import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ACCOUNTS_FILE, RECORDS_FILE, ensureDataDirs } from '../shared/paths.js';
import { log } from '../shared/logger.js';
import type {
  Account,
  CheckinRecord,
  Group,
  PointsSnapshot,
  TaskLogEntry,
} from '../shared/types.js';

/** 账号/分组/活跃指针等"结构化状态"，整文件原子写入 */
export interface StoreData {
  version: 1;
  updatedAt: number;
  accounts: Account[];
  groups: Group[];
  /** accountId -> 分组名数组 */
  accountGroups: Record<string, string[]>;
  /** toolId -> 活跃账号指针 */
  active: Record<string, { accountId: number; switchedAt: number }>;
  seq: { account: number; group: number };
}

interface DataEnvelope {
  version: 1;
  checksum: string;
  data: StoreData;
}

type RecordLine =
  | { t: 'checkin'; r: CheckinRecord }
  | { t: 'snapshot'; r: PointsSnapshot }
  | { t: 'log'; r: TaskLogEntry };

const MAX_SNAPSHOTS_PER_ACCOUNT = 2000;
const MAX_LOGS = 5000;
const COMPACT_THRESHOLD_LINES = 20000;

function checksumOf(data: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function emptyData(): StoreData {
  return {
    version: 1,
    updatedAt: Date.now(),
    accounts: [],
    groups: [],
    accountGroups: {},
    active: {},
    seq: { account: 0, group: 0 },
  };
}

/** 原子写：写临时文件 → fsync → 备份旧文件 → rename 覆盖 */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* 备份失败不阻断主流程 */
    }
  }
  fs.renameSync(tmp, file);
}

/**
 * JSON 文件存储：
 * - accounts.json     结构化状态（带 checksum + .bak 回退 + 损坏隔离）
 * - records.jsonl     追加型流水（签到/快照/日志），启动时重建内存索引
 */
export class JsonStore {
  data: StoreData = emptyData();
  checkins: CheckinRecord[] = [];
  snapshots: PointsSnapshot[] = [];
  logs: TaskLogEntry[] = [];
  /** 启动时的恢复提示（损坏回退等） */
  loadNote: string | null = null;
  private recordLines = 0;

  constructor(
    private readonly accountsFile = ACCOUNTS_FILE,
    private readonly recordsFile = RECORDS_FILE
  ) {}

  load(): void {
    ensureDataDirs();
    this.data = this.loadStructured();
    this.loadRecords();
    this.compactIfNeeded(true);
  }

  // ---------- 结构化状态 ----------

  private loadStructured(): StoreData {
    const candidates = [this.accountsFile, `${this.accountsFile}.bak`];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as DataEnvelope;
        if (!raw || typeof raw !== 'object' || !raw.data) throw new Error('缺少 data 字段');
        if (raw.checksum && checksumOf(raw.data) !== raw.checksum) throw new Error('checksum 校验失败');
        const data = { ...emptyData(), ...raw.data } as StoreData;
        if (!Array.isArray(data.accounts) || !Array.isArray(data.groups)) throw new Error('数据结构非法');
        if (file !== this.accountsFile) {
          this.loadNote = 'accounts.json 损坏，已自动从备份 accounts.json.bak 恢复';
          log.warn(this.loadNote);
        }
        return data;
      } catch (e) {
        const quarantine = `${file}.corrupt-${Date.now()}`;
        try {
          fs.copyFileSync(file, quarantine);
        } catch {
          /* ignore */
        }
        log.error(`读取 ${path.basename(file)} 失败：${(e as Error).message}`, { quarantine });
      }
    }
    if (fs.existsSync(this.accountsFile)) {
      this.loadNote = '账号配置文件损坏且无可用备份，已以空配置启动（原文件已隔离保留）';
    }
    return emptyData();
  }

  /** 保存结构化状态（原子写 + checksum） */
  save(): void {
    this.data.updatedAt = Date.now();
    const envelope: DataEnvelope = {
      version: 1,
      checksum: checksumOf(this.data),
      data: this.data,
    };
    writeFileAtomic(this.accountsFile, JSON.stringify(envelope, null, 2));
  }

  // ---------- 流水记录 ----------

  private loadRecords(): void {
    this.checkins = [];
    this.snapshots = [];
    this.logs = [];
    this.recordLines = 0;
    if (!fs.existsSync(this.recordsFile)) return;
    let text = '';
    try {
      text = fs.readFileSync(this.recordsFile, 'utf-8');
    } catch (e) {
      log.error('读取流水文件失败', { error: (e as Error).message });
      return;
    }
    let broken = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as RecordLine;
        this.pushRecord(rec);
        this.recordLines++;
      } catch {
        broken++;
      }
    }
    if (broken > 0) log.warn(`流水文件有 ${broken} 行损坏记录已跳过（后续写入不受影响）`);
  }

  private pushRecord(rec: RecordLine): void {
    if (rec.t === 'checkin') this.checkins.push(rec.r);
    else if (rec.t === 'snapshot') this.snapshots.push(rec.r);
    else if (rec.t === 'log') this.logs.push(rec.r);
  }

  /** 追加一条流水（append + fsync，单行损坏不影响其他行） */
  append(rec: RecordLine): void {
    fs.mkdirSync(path.dirname(this.recordsFile), { recursive: true });
    const fd = fs.openSync(this.recordsFile, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(rec) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.pushRecord(rec);
    this.recordLines++;
    if (this.recordLines > COMPACT_THRESHOLD_LINES) this.compactIfNeeded();
  }

  /** 重写流水文件（压缩/清理） */
  private compactIfNeeded(force = false): void {
    if (!force && this.recordLines <= COMPACT_THRESHOLD_LINES) return;
    if (this.recordLines === 0) return;
    const lines: string[] = [];
    for (const r of this.checkins) lines.push(JSON.stringify({ t: 'checkin', r }));
    for (const r of this.snapshots) lines.push(JSON.stringify({ t: 'snapshot', r }));
    for (const r of this.logs) lines.push(JSON.stringify({ t: 'log', r }));
    writeFileAtomic(this.recordsFile, lines.join('\n') + (lines.length ? '\n' : ''));
    this.recordLines = lines.length;
  }

  nextAccountId(): number {
    this.data.seq.account += 1;
    return this.data.seq.account;
  }

  nextGroupId(): number {
    this.data.seq.group += 1;
    return this.data.seq.group;
  }

  // ---------- 内存索引维护 ----------

  pruneSnapshots(accountId: number): void {
    const owned = this.snapshots.filter((s) => s.accountId === accountId);
    if (owned.length <= MAX_SNAPSHOTS_PER_ACCOUNT) return;
    const keep = new Set(
      owned
        .slice()
        .sort((a, b) => b.capturedAt - a.capturedAt || b.id - a.id)
        .slice(0, MAX_SNAPSHOTS_PER_ACCOUNT)
        .map((s) => s.id)
    );
    this.snapshots = this.snapshots.filter((s) => s.accountId !== accountId || keep.has(s.id));
  }

  pruneLogs(): void {
    if (this.logs.length <= MAX_LOGS) return;
    this.logs.sort((a, b) => b.startedAt - a.startedAt || (b.id ?? 0) - (a.id ?? 0));
    this.logs = this.logs.slice(0, MAX_LOGS);
  }
}
