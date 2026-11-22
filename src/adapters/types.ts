import type {
  CheckinResult,
  CredentialBlob,
  ToolId,
  ValidateResult,
} from '../shared/types.js';

/**
 * 工具适配器统一接口：屏蔽 Trae / CodeBuddy 差异。
 * 新增工具 = 实现该接口并注册。
 */
export interface ToolAdapter {
  readonly toolId: ToolId;
  readonly displayName: string;

  /** 本地登录态目录（已展开环境变量）；未配置返回 null */
  credentialDir(): string | null;

  /** 从本地采集当前登录态，打包为凭据 Blob */
  capture(): Promise<CredentialBlob>;

  /** 用凭据 Blob 恢复登录态（调用方负责先备份当前目录） */
  restore(blob: CredentialBlob): Promise<void>;

  /** 校验当前登录态是否有效 */
  validate(): Promise<ValidateResult>;

  /** 对当前（活跃）账号执行签到 */
  checkin(): Promise<CheckinResult>;

  /** 查询当前账号积分余额；不可得返回 null */
  queryPoints(): Promise<number | null>;

  /** 检测进程名列表 */
  processNames(): string[];
}
