import fs from 'node:fs';
import type { MamConfig } from '../shared/config.js';
import { ACCOUNTS_FILE, RECORDS_FILE, expandPath } from '../shared/paths.js';
import type { ToolId } from '../shared/types.js';
import type { Repo } from '../store/repo.js';
import type { CredentialVault } from '../vault/vault.js';
import type { ToolAdapter } from '../adapters/types.js';
import { CANDIDATE_DIRS } from '../adapters/registry.js';
import { isProcessRunning } from './process.js';

export interface DoctorLine {
  level: 'ok' | 'warn' | 'fail' | 'info';
  text: string;
}

export interface DoctorExtra {
  recoveryNotes?: string[];
  keyInfo?: string;
  dataDir?: string;
  packaged?: boolean;
}

/** 环境自检：存储 / 凭据库 / 配置 / 登录态目录 / 接口 / 进程 */
export async function runDoctor(
  cfg: MamConfig,
  repo: Repo,
  vault: CredentialVault,
  adapters: Record<ToolId, ToolAdapter>,
  extra: DoctorExtra = {}
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const add = (level: DoctorLine['level'], text: string) => lines.push({ level, text });

  // 1. 运行形态与存储
  add('info', `运行形态：${extra.packaged ? '单文件可执行程序' : '源码模式'}；数据目录：${extra.dataDir ?? '(默认)'}`);
  if (fs.existsSync(ACCOUNTS_FILE)) {
    const stat = fs.statSync(ACCOUNTS_FILE);
    add('ok', `accounts.json 正常（${(stat.size / 1024).toFixed(1)} KB，更新于 ${new Date(stat.mtimeMs).toLocaleString('zh-CN', { hour12: false })}）`);
  } else {
    add('warn', 'accounts.json 尚未创建（添加第一个账号后生成）');
  }
  if (fs.existsSync(`${ACCOUNTS_FILE}.bak`)) add('ok', 'accounts.json.bak 备份存在（可用于损坏回退）');
  if (fs.existsSync(RECORDS_FILE)) {
    try {
      const lines_ = fs.readFileSync(RECORDS_FILE, 'utf-8').split('\n').filter(Boolean).length;
      add('ok', `records.jsonl 正常（${lines_} 条流水记录）`);
    } catch {
      add('fail', 'records.jsonl 读取失败');
    }
  }
  for (const note of extra.recoveryNotes ?? []) add('warn', `恢复提示：${note}`);

  // 2. 配置
  add('ok', `配置正常：签到 ${cfg.schedule.checkin_time}（±${cfg.schedule.jitter_minutes}min），切换策略 ${cfg.switch.strategy}`);

  // 3. 数据库/账号
  const accounts = repo.listAccounts();
  add('ok', `账号数据正常，共 ${accounts.length} 个账号`);

  // 4. 凭据库与口令托管
  add(vault.isInitialized() ? 'ok' : 'fail', vault.isInitialized() ? '凭据库已初始化（AES-256-GCM）' : '凭据库未初始化，请运行 mam init');
  add(extra.keyInfo?.startsWith('已托管') ? 'ok' : 'warn', `主口令托管：${extra.keyInfo ?? '未知'}`);

  // 5. 各适配器
  for (const tool of ['trae', 'codebuddy'] as ToolId[]) {
    const adapter = adapters[tool];
    const dir = adapter.credentialDir();
    if (!dir) {
      add('warn', `${adapter.displayName}：未配置 credential_dir。候选目录：`);
      for (const c of CANDIDATE_DIRS[tool]) {
        const expanded = expandPath(c);
        add(fs.existsSync(expanded) ? 'ok' : 'info', `    ${c}${fs.existsSync(expanded) ? '  ← 存在，可使用' : ''}`);
      }
    } else if (fs.existsSync(dir)) {
      add('ok', `${adapter.displayName}：凭据目录 ${dir}`);
      const v = await adapter.validate();
      add(v.ok ? 'ok' : 'fail', `    登录态校验：${v.message}`);
    } else {
      add('warn', `${adapter.displayName}：凭据目录不存在（${dir}）`);
    }

    if (!cfg.adapters[tool].checkin_url) {
      add('warn', `    ${adapter.displayName} 未配置签到接口 → 手动模式（只做切换与记录）`);
    } else {
      add('ok', `    签到接口：${cfg.adapters[tool].checkin_method} ${cfg.adapters[tool].checkin_url}`);
    }
    if (!cfg.adapters[tool].points_url) add('warn', `    未配置积分接口 → 不自动拉取积分`);

    for (const name of adapter.processNames()) {
      if (await isProcessRunning(name)) add('warn', `    检测到 ${name} 正在运行，切换任务会被阻止`);
    }
  }

  return lines;
}
