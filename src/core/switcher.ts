import fs from 'node:fs';
import path from 'node:path';
import type { MamConfig } from '../shared/config.js';
import { BACKUP_DIR, JOURNAL_FILE, LOCK_FILE } from '../shared/paths.js';
import { log } from '../shared/logger.js';
import type { Account, SwitchResult, ToolId } from '../shared/types.js';
import type { Repo } from '../store/repo.js';
import { writeFileAtomic } from '../store/json-store.js';
import type { CredentialVault } from '../vault/vault.js';
import type { ToolAdapter } from '../adapters/types.js';
import { isPidAlive, isProcessRunning } from './process.js';

const MAX_BACKUPS = 5;

/** 切换事务日志：崩溃后据此判断回滚还是清理 */
interface SwitchJournal {
  toolId: ToolId;
  accountId: number;
  credDir: string;
  backupPath: string | null;
  phase: 'backup' | 'restored' | 'committed';
  startedAt: number;
}

function readJournal(): SwitchJournal | null {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return null;
    return JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf-8')) as SwitchJournal;
  } catch {
    return null;
  }
}

function writeJournal(journal: SwitchJournal): void {
  writeFileAtomic(JOURNAL_FILE, JSON.stringify(journal, null, 2));
}

function clearJournal(): void {
  for (const f of [JOURNAL_FILE, `${JOURNAL_FILE}.bak`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 启动恢复：上次切换若未提交（进程崩溃/断电），自动回滚到切换前登录态。
 * 返回恢复说明（无未完成事务时返回 null）。
 */
export function recoverInterruptedSwitch(repo: Repo): string | null {
  const journal = readJournal();
  if (!journal) return null;

  let note: string;
  let ok = true;
  if (journal.phase === 'committed') {
    note = '上次切换已提交，仅清理事务日志';
  } else if (journal.backupPath && fs.existsSync(journal.backupPath)) {
    try {
      fs.rmSync(journal.credDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(journal.credDir), { recursive: true });
      fs.renameSync(journal.backupPath, journal.credDir);
      note = `检测到未完成的账号切换（账号 #${journal.accountId}，阶段 ${journal.phase}），已自动回滚到切换前登录态`;
    } catch (e) {
      ok = false;
      note = `未完成切换的回滚失败：${(e as Error).message}；备份保留在 ${journal.backupPath}，请手动恢复`;
    }
  } else {
    ok = false;
    note = `检测到未完成的切换事务，但备份不存在（凭据目录：${journal.credDir}）`;
  }

  repo.insertLog({
    taskType: 'recovery',
    accountId: journal.accountId,
    status: ok ? 'ok' : 'fail',
    detail: JSON.stringify({ note, journal, recoveredAt: Date.now() }),
    startedAt: Date.now(),
    durationMs: 0,
  });
  clearJournal();
  log.warn(note);
  return note;
}

/**
 * 账号切换服务：全局文件锁 → 进程检测 → 事务日志 → 备份 →
 * 恢复目标凭据 → 校验 → 提交（或回滚）。
 */
export class SwitchService {
  constructor(
    private readonly repo: Repo,
    private readonly vault: CredentialVault,
    private readonly cfg: MamConfig,
    private readonly adapters: Record<ToolId, ToolAdapter>
  ) {}

  /** 获取全局切换锁；返回释放函数 */
  private async acquireLock(): Promise<() => void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        fs.closeSync(fd);
        return () => {
          try {
            fs.unlinkSync(LOCK_FILE);
          } catch {
            /* ignore */
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          try {
            const { pid } = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8')) as { pid: number };
            if (!(await isPidAlive(pid))) {
              fs.unlinkSync(LOCK_FILE);
              continue;
            }
          } catch {
            fs.unlinkSync(LOCK_FILE);
            continue;
          }
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw e;
      }
    }
    throw new Error('获取切换锁超时（30s），可能有其他切换任务正在执行');
  }

  private async checkProcesses(adapter: ToolAdapter): Promise<string | null> {
    if (this.cfg.switch.allow_while_running) return null;
    for (const name of adapter.processNames()) {
      if (await isProcessRunning(name)) {
        return `检测到 ${name} 正在运行，为避免登录态冲突已中止切换（可配置 switch.allow_while_running: true 跳过）`;
      }
    }
    return null;
  }

  async switchTo(accountId: number, opts: { skipLock?: boolean } = {}): Promise<SwitchResult> {
    const account = this.repo.getAccount(accountId);
    if (!account || account.deletedAt) return { ok: false, message: `账号 #${accountId} 不存在` };
    if (account.status === 'banned' || account.status === 'paused') {
      return { ok: false, message: `账号 ${account.name} 状态为 ${account.status}，已跳过` };
    }
    const adapter = this.adapters[account.toolId];
    const credDir = adapter.credentialDir();
    if (!credDir) return { ok: false, message: `未配置 ${adapter.displayName} 的 credential_dir` };

    const startedAt = Date.now();
    const release = opts.skipLock ? () => {} : await this.acquireLock();
    let journal: SwitchJournal | null = null;
    try {
      const procMsg = await this.checkProcesses(adapter);
      if (procMsg) {
        this.writeLog(account, startedAt, 'fail', { step: 'process_check', message: procMsg });
        return { ok: false, message: procMsg };
      }

      // 事务日志先行：崩溃后可根据 phase 决定回滚
      journal = {
        toolId: account.toolId,
        accountId: account.id,
        credDir,
        backupPath: null,
        phase: 'backup',
        startedAt,
      };
      writeJournal(journal);

      // 备份当前登录态
      if (fs.existsSync(credDir)) {
        const backupPath = path.join(BACKUP_DIR, `${account.toolId}-${Date.now()}`);
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        fs.renameSync(credDir, backupPath);
        journal.backupPath = backupPath;
        writeJournal(journal);
      }

      // 恢复目标账号凭据
      const blob = this.vault.get(account.credentialId);
      if (!blob) throw new Error(`凭据 ${account.credentialId} 不存在（可能已删除）`);
      await adapter.restore(blob);
      journal.phase = 'restored';
      writeJournal(journal);

      // 校验
      const validate = await adapter.validate();
      if (!validate.ok) throw new Error(`切换后校验失败：${validate.message}`);

      // 提交：更新活跃指针 → 回写最新凭据 → 清理事务日志
      this.repo.setActive(account.toolId, account.id);
      try {
        const refreshed = await adapter.capture();
        this.vault.put(account.credentialId, refreshed);
      } catch {
        /* 回写失败不影响切换结果 */
      }
      journal.phase = 'committed';
      writeJournal(journal);
      clearJournal();

      const message = `已切换到 ${adapter.displayName} 账号「${account.name}」（${validate.message}）`;
      this.writeLog(account, startedAt, 'ok', { message, backup: journal.backupPath });
      log.info(message, { accountId: account.id });
      this.cleanupBackups(account.toolId);
      return { ok: true, message, accountId: account.id };
    } catch (e) {
      const message = (e as Error).message;
      // 回滚
      let rollbackOk = true;
      try {
        if (journal?.backupPath && fs.existsSync(journal.backupPath)) {
          fs.rmSync(credDir, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(credDir), { recursive: true });
          fs.renameSync(journal.backupPath, credDir);
        }
      } catch (rollbackErr) {
        rollbackOk = false;
        log.error('回滚失败！请手动恢复备份目录', {
          error: (rollbackErr as Error).message,
          backupPath: journal?.backupPath,
        });
      }
      if (rollbackOk) clearJournal();
      this.writeLog(account, startedAt, 'fail', {
        message,
        rollbackOk,
        backup: journal?.backupPath ?? null,
      });
      return {
        ok: false,
        message: rollbackOk ? `切换失败（已回滚）：${message}` : `切换失败且回滚失败：${message}`,
        accountId: account.id,
      };
    } finally {
      release();
    }
  }

  private writeLog(account: Account, startedAt: number, status: 'ok' | 'fail', detail: object): void {
    this.repo.insertLog({
      taskType: 'switch',
      accountId: account.id,
      status,
      detail: JSON.stringify({ to: account.id, ...detail }),
      startedAt,
      durationMs: Date.now() - startedAt,
    });
  }

  private cleanupBackups(toolId: ToolId): void {
    try {
      const files = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith(toolId + '-'))
        .sort()
        .reverse();
      for (const f of files.slice(MAX_BACKUPS)) {
        fs.rmSync(path.join(BACKUP_DIR, f), { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }

  /** 按策略对待签账号排序 */
  orderAccounts(accounts: Account[]): Account[] {
    const strategy = this.cfg.switch.strategy;
    const list = [...accounts];
    if (strategy === 'least-points') {
      const balances = this.repo.latestBalances();
      list.sort((a, b) => (balances.get(a.id) ?? Infinity) - (balances.get(b.id) ?? Infinity));
      return list;
    }
    if (strategy === 'undated-first') {
      list.sort((a, b) => {
        const da = this.repo.lastCheckinDate(a.id) ?? '';
        const db = this.repo.lastCheckinDate(b.id) ?? '';
        return da.localeCompare(db);
      });
      return list;
    }
    const firstIdx = list.findIndex((a) => {
      const active = this.repo.getActive(a.toolId);
      return active?.accountId === a.id;
    });
    if (firstIdx >= 0 && list.length > 1) {
      return [...list.slice(firstIdx + 1), ...list.slice(0, firstIdx + 1)];
    }
    return list;
  }
}
