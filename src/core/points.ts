import type { MamConfig } from '../shared/config.js';
import { log, randomBetween, sleep } from '../shared/logger.js';
import type { Account, PointsSnapshot, ToolId } from '../shared/types.js';
import type { Repo } from '../store/repo.js';
import type { SwitchService } from './switcher.js';
import type { ToolAdapter } from '../adapters/types.js';

/** 积分追踪与统计服务 */
export class PointsService {
  constructor(
    private readonly repo: Repo,
    private readonly cfg: MamConfig,
    private readonly switcher: SwitchService,
    private readonly adapters: Record<ToolId, ToolAdapter>
  ) {}

  /** 刷新单账号积分（假设该账号当前已处于活跃态） */
  async refreshActive(account: Account): Promise<number | null> {
    const adapter = this.adapters[account.toolId];
    const balance = await adapter.queryPoints();
    if (typeof balance === 'number') {
      this.repo.insertSnapshot(account.id, balance);
    }
    return balance;
  }

  /** 刷新全部（或某分组）账号：逐个切换 → 查询 → 快照 */
  async refreshAll(group?: string): Promise<Array<{ account: Account; balance: number | null }>> {
    let accounts = this.repo.listAccounts().filter((a) => a.status === 'active');
    if (group && group !== 'all') {
      const ids = new Set(this.repo.accountIdsInGroup(group));
      accounts = accounts.filter((a) => ids.has(a.id));
    }
    const out: Array<{ account: Account; balance: number | null }> = [];
    const [lo, hi] = this.cfg.switch.account_interval_seconds;
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const sw = await this.switcher.switchTo(account.id);
      if (!sw.ok) {
        log.warn(`积分刷新：账号「${account.name}」切换失败（${sw.message}）`);
        out.push({ account, balance: null });
        continue;
      }
      if (i > 0 && lo > 0) await sleep(randomBetween(lo, hi) * 1000);
      const balance = await this.refreshActive(account);
      out.push({ account, balance });
      log.info(`账号「${account.name}」积分：${balance ?? '获取失败'}`);
    }
    return out;
  }

  /** 统计视图数据 */
  stats(days = 30): {
    accounts: Array<{
      account: Account;
      groups: string[];
      latest: number | null;
      snapshots: PointsSnapshot[];
    }>;
    total: number;
  } {
    const sinceTs = Date.now() - days * 24 * 3600 * 1000;
    const accounts = this.repo.listAccounts();
    const result = accounts.map((account) => ({
      account,
      groups: this.repo.groupsOfAccount(account.id),
      latest: this.repo.latestBalance(account.id),
      snapshots: this.repo.snapshotsSince(account.id, sinceTs),
    }));
    const total = result.reduce((s, r) => s + (r.latest ?? 0), 0);
    return { accounts: result, total };
  }
}
