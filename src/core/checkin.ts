import type { MamConfig } from '../shared/config.js';
import { log, randomBetween, sleep, todayStr } from '../shared/logger.js';
import type { Account, CheckinRecord } from '../shared/types.js';
import type { Repo } from '../store/repo.js';
import type { CredentialVault } from '../vault/vault.js';
import type { SwitchService } from './switcher.js';
import type { ToolAdapter } from '../adapters/types.js';
import type { ToolId } from '../shared/types.js';
import { notify } from './notify.js';

export interface CheckinSummary {
  date: string;
  total: number;
  success: number;
  already: number;
  failed: number;
  skipped: number;
  records: CheckinRecord[];
}

export interface CheckinOptions {
  /** 限定账号 */
  accountId?: number;
  /** 限定分组名 */
  group?: string;
  noRetry?: boolean;
  /** 覆盖账号间隔（秒），CLI 手动运行时可缩短 */
  intervalSeconds?: [number, number];
  /** 签到完成后是否切回首选账号 */
  switchBack?: boolean;
}

/** 每日签到编排服务 */
export class CheckinService {
  constructor(
    private readonly repo: Repo,
    private readonly vault: CredentialVault,
    private readonly cfg: MamConfig,
    private readonly switcher: SwitchService,
    private readonly adapters: Record<ToolId, ToolAdapter>
  ) {}

  /** 选出本次要处理的账号（active + 范围过滤 + 按策略排序） */
  private selectAccounts(opts: CheckinOptions): Account[] {
    let accounts = this.repo.listAccounts().filter((a) => a.status === 'active');
    if (opts.accountId !== undefined) {
      accounts = accounts.filter((a) => a.id === opts.accountId);
      return accounts;
    }
    const scope = opts.group ?? this.cfg.switch.group_scope;
    if (scope && scope !== 'all') {
      const ids = new Set(this.repo.accountIdsInGroup(scope));
      accounts = accounts.filter((a) => ids.has(a.id));
    }
    return this.switcher.orderAccounts(accounts);
  }

  async runDailyJob(opts: CheckinOptions = {}): Promise<CheckinSummary> {
    const date = todayStr();
    const startedAll = Date.now();
    const accounts = this.selectAccounts(opts);
    const [loCfg, hiCfg] = this.cfg.switch.account_interval_seconds;
    const [lo, hi] = opts.intervalSeconds ?? [loCfg, hiCfg];
    const records: CheckinRecord[] = [];
    const summary: CheckinSummary = { date, total: accounts.length, success: 0, already: 0, failed: 0, skipped: 0, records };

    if (accounts.length === 0) {
      log.warn('没有符合条件的待签到账号');
      return summary;
    }

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const prev = i > 0 ? records[records.length - 1] : null;
      if (prev && lo > 0) {
        const wait = randomBetween(lo, hi);
        log.info(`等待 ${wait}s 后处理下一个账号…`);
        await sleep(wait * 1000);
      }

      const record = await this.checkinSingle(account, date, opts.noRetry ?? false);
      records.push(record);
      summary[record.status]++;
    }

    // 签完切回首选账号（第一个成功的）
    if (opts.switchBack ?? this.cfg.switch.auto_switch_after_checkin) {
      const firstOk = records.find((r) => r.status === 'success' || r.status === 'already');
      if (firstOk) {
        const res = await this.switcher.switchTo(firstOk.accountId);
        log.info(res.ok ? `已切回账号 #${firstOk.accountId}` : `切回失败：${res.message}`);
      }
    }

    this.repo.insertLog({
      taskType: 'checkin',
      accountId: null,
      status: summary.failed > 0 ? 'fail' : 'ok',
      detail: JSON.stringify({ ...summary, records: undefined, totalMs: Date.now() - startedAll }),
      startedAt: startedAll,
      durationMs: Date.now() - startedAll,
    });
    return summary;
  }

  /** 单账号签到（含切换、重试、记录、积分快照） */
  private async checkinSingle(account: Account, date: string, noRetry: boolean): Promise<CheckinRecord> {
    const startedAt = Date.now();
    const base = { accountId: account.id, checkinDate: date, executedAt: startedAt };

    // 幂等：今日已签
    if (this.repo.hasCheckedIn(account.id, date)) {
      return this.repo.insertCheckin({ ...base, status: 'skipped', message: '今日已签到，跳过', reward: 0, retried: 0 });
    }

    // 切换到该账号
    const sw = await this.switcher.switchTo(account.id);
    if (!sw.ok) {
      return this.repo.insertCheckin({ ...base, status: 'failed', message: `切换失败：${sw.message}`, reward: 0, retried: 0 });
    }

    const adapter = this.adapters[account.toolId];
    let retried = 0;
    let result = await adapter.checkin();
    const delays = this.cfg.limits.retry_delays_seconds;

    while (result.status === 'failed' && !noRetry && retried < delays.length) {
      const delay = delays[retried];
      log.warn(`账号「${account.name}」签到失败（${result.message}），${delay}s 后重试 ${retried + 1}/${delays.length}`);
      await sleep(delay * 1000);
      retried++;
      result = await adapter.checkin();
    }

    const record = this.repo.insertCheckin({
      ...base,
      status: result.status,
      message: result.message ?? null,
      reward: result.reward ?? 0,
      retried,
      executedAt: Date.now(),
    });

    this.repo.insertLog({
      taskType: 'checkin',
      accountId: account.id,
      status: result.status === 'failed' ? 'fail' : 'ok',
      detail: JSON.stringify({ message: result.message, retried, status: result.status }),
      startedAt,
      durationMs: Date.now() - startedAt,
    });

    // 签到后拉取积分快照
    const balance = await adapter.queryPoints();
    if (typeof balance === 'number') {
      this.repo.insertSnapshot(account.id, balance);
    }

    // 连续失败通知
    if (result.status === 'failed') {
      const failCount = this.repo.countFailedToday(account.id, date);
      if (failCount >= 2) {
        await notify(this.cfg, 'checkin_failed_twice', '签到失败提醒', `账号「${account.name}」今日已失败 ${failCount} 次：${result.message ?? '未知原因'}`);
      }
    } else {
      log.info(`账号「${account.name}」签到完成：${result.status}${result.reward ? `（+${result.reward}）` : ''}`);
    }
    return record;
  }
}
