import fs from 'node:fs';
import path from 'node:path';
import type { AdapterConfig, MamConfig } from '../shared/config.js';
import { adapterCredentialDir } from '../shared/config.js';
import type {
  CheckinResult,
  CredentialBlob,
  ToolId,
  ValidateResult,
} from '../shared/types.js';
import type { ToolAdapter } from './types.js';
import { captureDir, clearDir, restoreDir } from './credential-ops.js';

const HTTP_TIMEOUT_MS = 15_000;

/** 每个工具的上次请求时间（限流用） */
const lastRequestAt = new Map<ToolId, number>();

async function throttledFetch(
  toolId: ToolId,
  minIntervalMs: number,
  url: string,
  init: RequestInit
): Promise<Response> {
  const last = lastRequestAt.get(toolId) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt.set(toolId, Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 在 JSON 中递归寻找积分数值字段 */
function findPointsNumber(node: unknown, depth = 0): number | null {
  if (depth > 5) return null;
  if (typeof node === 'number' && Number.isFinite(node)) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPointsNumber(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof node !== 'object' || node === null) return null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (/point|credit|balance|integral|score|coin|quota/i.test(key) && typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    const found = findPointsNumber(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export abstract class BaseAdapter implements ToolAdapter {
  abstract readonly toolId: ToolId;
  abstract readonly displayName: string;

  constructor(
    protected readonly cfg: MamConfig,
    protected readonly adapterCfg: AdapterConfig
  ) {}

  credentialDir(): string | null {
    return adapterCredentialDir(this.cfg, this.toolId);
  }

  processNames(): string[] {
    return this.adapterCfg.process_names;
  }

  async capture(): Promise<CredentialBlob> {
    const dir = this.credentialDir();
    if (!dir) throw new Error(`未配置 ${this.displayName} 的 credential_dir，请先在 config.json 中设置或使用 mam config set adapters.${this.toolId}.credential_dir "<路径>"`);
    const files = captureDir(dir, {
      includePatterns: this.adapterCfg.include_patterns,
      excludePatterns: this.adapterCfg.exclude_patterns,
      maxFileBytes: this.adapterCfg.max_file_mb * 1024 * 1024,
    });
    if (Object.keys(files).length === 0) {
      throw new Error(`凭据目录采集结果为空：${dir}（目录为空或全部被 exclude 规则过滤）`);
    }
    return { version: 1, toolId: this.toolId, capturedAt: Date.now(), files, meta: {} };
  }

  async restore(blob: CredentialBlob): Promise<void> {
    const dir = this.credentialDir();
    if (!dir) throw new Error(`未配置 ${this.displayName} 的 credential_dir`);
    // 目录已由调用方（SwitchService）移走备份，此处写全新内容
    clearDir(dir);
    restoreDir(dir, blob.files);
  }

  /** 从当前凭据目录提取 token 注入请求头（若配置了 auth） */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      ...this.adapterCfg.extra_headers,
    };
    const auth = this.adapterCfg.auth;
    if (auth?.file && auth.pattern) {
      try {
        const dir = this.credentialDir();
        if (dir) {
          const tokenFile = path.join(dir, ...auth.file.split('/'));
          if (fs.existsSync(tokenFile)) {
            const content = fs.readFileSync(tokenFile, 'utf-8');
            const m = new RegExp(auth.pattern).exec(content);
            if (m?.[1]) {
              headers[auth.header || 'Authorization'] = `${auth.prefix ?? 'Bearer '}${m[1]}`;
            }
          }
        }
      } catch {
        // token 提取失败不阻断请求
      }
    }
    return headers;
  }

  async validate(): Promise<ValidateResult> {
    const dir = this.credentialDir();
    if (!dir) return { ok: false, message: '未配置 credential_dir' };
    if (!fs.existsSync(dir)) return { ok: false, message: `登录态目录不存在：${dir}` };
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (entries.length === 0) return { ok: false, message: '登录态目录为空' };
    } catch (e) {
      return { ok: false, message: `读取登录态目录失败：${(e as Error).message}` };
    }
    if (this.adapterCfg.points_url) {
      try {
        const res = await throttledFetch(
          this.toolId,
          this.cfg.limits.min_request_interval_ms,
          this.adapterCfg.points_url,
          { method: 'GET', headers: this.buildHeaders() }
        );
        if (res.status === 401 || res.status === 403) {
          return { ok: false, message: `凭据已失效（接口返回 ${res.status}）` };
        }
        return { ok: res.ok, message: res.ok ? '凭据有效' : `接口返回 ${res.status}` };
      } catch (e) {
        return { ok: true, message: `目录校验通过（接口探测失败：${(e as Error).message}）` };
      }
    }
    return { ok: true, message: '登录态目录存在且非空（未配置接口，无法深度校验）' };
  }

  async checkin(): Promise<CheckinResult> {
    if (!this.adapterCfg.checkin_url) {
      return {
        status: 'skipped',
        message: '未配置签到接口（手动模式）：仅完成账号切换，请打开客户端手动签到，或配置 adapters.' + this.toolId + '.checkin_url',
      };
    }
    try {
      const res = await throttledFetch(
        this.toolId,
        this.cfg.limits.min_request_interval_ms,
        this.adapterCfg.checkin_url,
        {
          method: this.adapterCfg.checkin_method,
          headers: this.buildHeaders(),
          body: this.adapterCfg.checkin_method === 'POST' ? '{}' : undefined,
        }
      );
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON 响应 */
      }
      if (res.ok) {
        const obj = json as Record<string, unknown> | null;
        const ok = obj && (obj.code === 0 || obj.code === 200 || obj.success === true || obj.ok === true);
        if (ok) {
          const reward = json ? findPointsNumber((json as Record<string, unknown>).data ?? json) : null;
          return { status: 'success', message: '签到成功', reward: reward ?? 0, raw: json };
        }
        if (/已签|重复|already|repeat|signed/i.test(text)) {
          return { status: 'already', message: '今日已签到', raw: json };
        }
        return {
          status: 'failed',
          message: (obj?.message as string) ?? `接口返回 ${res.status}`,
          raw: json,
        };
      }
      if (res.status === 401 || res.status === 403) {
        return { status: 'failed', message: `凭据已失效（${res.status}）`, raw: json };
      }
      return { status: 'failed', message: `接口返回 ${res.status}: ${text.slice(0, 200)}`, raw: json };
    } catch (e) {
      return { status: 'failed', message: `请求异常：${(e as Error).message}` };
    }
  }

  async queryPoints(): Promise<number | null> {
    if (!this.adapterCfg.points_url) return null;
    try {
      const res = await throttledFetch(
        this.toolId,
        this.cfg.limits.min_request_interval_ms,
        this.adapterCfg.points_url,
        { method: 'GET', headers: this.buildHeaders() }
      );
      if (!res.ok) return null;
      const json = JSON.parse(await res.text());
      return findPointsNumber(json);
    } catch {
      return null;
    }
  }
}
