// 领域类型定义
export type ToolId = 'trae' | 'codebuddy';

export type AccountStatus = 'active' | 'paused' | 'invalid' | 'banned';

export type CheckinStatus = 'success' | 'already' | 'failed' | 'skipped';

export type SwitchStrategy = 'round-robin' | 'least-points' | 'undated-first';

export interface Account {
  id: number;
  name: string;
  toolId: ToolId;
  credentialId: string;
  status: AccountStatus;
  remark: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface Group {
  id: number;
  name: string;
}

export interface CheckinRecord {
  id: number;
  accountId: number;
  checkinDate: string; // YYYY-MM-DD
  status: CheckinStatus;
  message: string | null;
  reward: number;
  retried: number;
  executedAt: number;
}

export interface PointsSnapshot {
  id: number;
  accountId: number;
  balance: number;
  capturedAt: number;
}

export interface TaskLogEntry {
  id?: number;
  taskType: string; // switch / checkin / points_poll / health_check / system
  accountId: number | null;
  status: 'ok' | 'fail';
  detail: string; // JSON 字符串
  startedAt: number;
  durationMs: number;
}

/** 凭据包：相对路径 -> base64 文件内容 */
export interface CredentialBlob {
  version: 1;
  toolId: ToolId;
  capturedAt: number;
  files: Record<string, string>;
  meta: Record<string, string>;
}

export interface CheckinResult {
  status: CheckinStatus;
  message?: string;
  reward?: number;
  raw?: unknown;
}

export interface ValidateResult {
  ok: boolean;
  message: string;
}

export interface SwitchResult {
  ok: boolean;
  message: string;
  accountId?: number;
}
