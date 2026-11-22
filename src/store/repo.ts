import type {
  Account,
  AccountStatus,
  CheckinRecord,
  Group,
  PointsSnapshot,
  TaskLogEntry,
  ToolId,
} from '../shared/types.js';
import { JsonStore } from './json-store.js';

/**
 * 数据仓库（JSON 文件持久化）。
 * 对外 API 与业务层解耦：切换存储实现不影响 core/server。
 */
export class Repo {
  readonly store: JsonStore;

  constructor(store = new JsonStore()) {
    this.store = store;
    this.store.load();
  }

  /** 启动时的数据恢复提示（供 CLI/面板展示） */
  get loadNote(): string | null {
    return this.store.loadNote;
  }

  // ---------- 账号 ----------

  listAccounts(opts: { includeDeleted?: boolean } = {}): Account[] {
    const list = opts.includeDeleted
      ? this.store.data.accounts
      : this.store.data.accounts.filter((a) => a.deletedAt === null);
    return list.slice().sort((a, b) => a.id - b.id);
  }

  getAccount(id: number): Account | null {
    return this.store.data.accounts.find((a) => a.id === id) ?? null;
  }

  insertAccount(input: { name: string; toolId: ToolId; credentialId: string; remark?: string }): Account {
    const now = Date.now();
    const account: Account = {
      id: this.store.nextAccountId(),
      name: input.name,
      toolId: input.toolId,
      credentialId: input.credentialId,
      status: 'active',
      remark: input.remark ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.store.data.accounts.push(account);
    this.store.save();
    return account;
  }

  updateAccount(id: number, patch: Partial<Pick<Account, 'name' | 'status' | 'remark'>>): Account | null {
    const account = this.store.data.accounts.find((a) => a.id === id);
    if (!account) return null;
    if (patch.name !== undefined) account.name = patch.name;
    if (patch.status !== undefined) account.status = patch.status as AccountStatus;
    if (patch.remark !== undefined) account.remark = patch.remark;
    account.updatedAt = Date.now();
    this.store.save();
    return account;
  }

  softDeleteAccount(id: number): void {
    const account = this.store.data.accounts.find((a) => a.id === id);
    if (!account) return;
    account.deletedAt = Date.now();
    account.updatedAt = Date.now();
    this.store.save();
  }

  hardDeleteAccount(id: number): void {
    this.store.data.accounts = this.store.data.accounts.filter((a) => a.id !== id);
    delete this.store.data.accountGroups[String(id)];
    this.store.save();
  }

  // ---------- 分组 ----------

  listGroups(): Group[] {
    return this.store.data.groups.slice().sort((a, b) => a.name.localeCompare(b.name));
  }

  getOrCreateGroup(name: string): Group {
    const existing = this.store.data.groups.find((g) => g.name === name);
    if (existing) return existing;
    const group: Group = { id: this.store.nextGroupId(), name };
    this.store.data.groups.push(group);
    this.store.save();
    return group;
  }

  deleteGroup(name: string): boolean {
    const group = this.store.data.groups.find((g) => g.name === name);
    if (!group) return false;
    this.store.data.groups = this.store.data.groups.filter((g) => g.id !== group.id);
    for (const key of Object.keys(this.store.data.accountGroups)) {
      this.store.data.accountGroups[key] = this.store.data.accountGroups[key].filter((n) => n !== name);
    }
    this.store.save();
    return true;
  }

  assignGroup(accountId: number, groupName: string): void {
    this.getOrCreateGroup(groupName);
    const key = String(accountId);
    const list = this.store.data.accountGroups[key] ?? [];
    if (!list.includes(groupName)) list.push(groupName);
    this.store.data.accountGroups[key] = list;
    this.store.save();
  }

  unassignGroup(accountId: number, groupName: string): void {
    const key = String(accountId);
    const list = this.store.data.accountGroups[key] ?? [];
    this.store.data.accountGroups[key] = list.filter((n) => n !== groupName);
    this.store.save();
  }

  groupsOfAccount(accountId: number): string[] {
    return this.store.data.accountGroups[String(accountId)] ?? [];
  }

  accountIdsInGroup(groupName: string): number[] {
    return Object.entries(this.store.data.accountGroups)
      .filter(([, names]) => names.includes(groupName))
      .map(([id]) => Number(id));
  }

  // ---------- 签到记录 ----------

  hasCheckedIn(accountId: number, date: string): boolean {
    return this.store.checkins.some(
      (r) => r.accountId === accountId && r.checkinDate === date && (r.status === 'success' || r.status === 'already')
    );
  }

  countFailedToday(accountId: number, date: string): number {
    return this.store.checkins.filter(
      (r) => r.accountId === accountId && r.checkinDate === date && r.status === 'failed'
    ).length;
  }

  insertCheckin(rec: Omit<CheckinRecord, 'id'>): CheckinRecord {
    const id = this.store.checkins.reduce((max, r) => Math.max(max, r.id), 0) + 1;
    const full: CheckinRecord = {
      id,
      accountId: rec.accountId,
      checkinDate: rec.checkinDate,
      status: rec.status,
      message: rec.message ?? null,
      reward: rec.reward ?? 0,
      retried: rec.retried ?? 0,
      executedAt: rec.executedAt,
    };
    this.store.append({ t: 'checkin', r: full });
    return full;
  }

  getCheckin(id: number): CheckinRecord | null {
    return this.store.checkins.find((r) => r.id === id) ?? null;
  }

  listCheckins(opts: { accountId?: number; from?: string; to?: string } = {}): CheckinRecord[] {
    return this.store.checkins
      .filter((r) => {
        if (opts.accountId !== undefined && r.accountId !== opts.accountId) return false;
        if (opts.from && r.checkinDate < opts.from) return false;
        if (opts.to && r.checkinDate > opts.to) return false;
        return true;
      })
      .sort((a, b) => b.executedAt - a.executedAt)
      .slice(0, 2000);
  }

  lastCheckinDate(accountId: number): string | null {
    const dates = this.store.checkins
      .filter((r) => r.accountId === accountId && (r.status === 'success' || r.status === 'already'))
      .map((r) => r.checkinDate)
      .sort();
    return dates.length ? dates[dates.length - 1] : null;
  }

  monthlyReward(accountId: number, month: string): number {
    return this.store.checkins
      .filter((r) => r.accountId === accountId && r.status === 'success' && r.checkinDate.startsWith(month))
      .reduce((sum, r) => sum + (r.reward ?? 0), 0);
  }

  // ---------- 积分快照 ----------

  insertSnapshot(accountId: number, balance: number, capturedAt = Date.now()): void {
    const id = this.store.snapshots.reduce((max, s) => Math.max(max, s.id), 0) + 1;
    const snapshot: PointsSnapshot = { id, accountId, balance, capturedAt };
    this.store.append({ t: 'snapshot', r: snapshot });
    this.store.pruneSnapshots(accountId);
  }

  latestBalance(accountId: number): number | null {
    const list = this.store.snapshots.filter((s) => s.accountId === accountId);
    if (!list.length) return null;
    return list.reduce((best, cur) => (cur.capturedAt >= best.capturedAt ? cur : best)).balance;
  }

  latestBalances(): Map<number, number> {
    const map = new Map<number, PointsSnapshot>();
    for (const s of this.store.snapshots) {
      const cur = map.get(s.accountId);
      if (!cur || s.capturedAt >= cur.capturedAt) map.set(s.accountId, s);
    }
    return new Map([...map.entries()].map(([id, s]) => [id, s.balance]));
  }

  snapshotsSince(accountId: number, sinceTs: number): PointsSnapshot[] {
    return this.store.snapshots
      .filter((s) => s.accountId === accountId && s.capturedAt >= sinceTs)
      .sort((a, b) => a.capturedAt - b.capturedAt);
  }

  allSnapshotsSince(sinceTs: number): PointsSnapshot[] {
    return this.store.snapshots.filter((s) => s.capturedAt >= sinceTs).sort((a, b) => a.capturedAt - b.capturedAt);
  }

  // ---------- 任务日志 ----------

  insertLog(entry: Omit<TaskLogEntry, 'id'>): void {
    const id = this.store.logs.reduce((max, l) => Math.max(max, l.id ?? 0), 0) + 1;
    const full: TaskLogEntry = { ...entry, id };
    this.store.append({ t: 'log', r: full });
    this.store.pruneLogs();
  }

  listLogs(opts: { taskType?: string; accountId?: number; limit?: number } = {}): TaskLogEntry[] {
    return this.store.logs
      .filter((l) => {
        if (opts.taskType && l.taskType !== opts.taskType) return false;
        if (opts.accountId !== undefined && l.accountId !== opts.accountId) return false;
        return true;
      })
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, opts.limit ?? 200);
  }

  // ---------- 活跃账号指针 ----------

  getActive(toolId: ToolId): { accountId: number; switchedAt: number } | null {
    return this.store.data.active[toolId] ?? null;
  }

  setActive(toolId: ToolId, accountId: number): void {
    this.store.data.active[toolId] = { accountId, switchedAt: Date.now() };
    this.store.save();
  }
}
