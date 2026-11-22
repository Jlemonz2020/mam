import fs from 'node:fs';
import { CONFIG_FILE, ensureDataDirs, expandPath } from './paths.js';
import type { SwitchStrategy, ToolId } from './types.js';

export interface AdapterAuthConfig {
  /** 凭据目录内的相对文件路径，用于提取 token */
  file: string;
  /** 正则表达式，第 1 个捕获组为 token */
  pattern: string;
  /** 注入的请求头名，默认 Authorization */
  header: string;
  /** 头部前缀，如 "Bearer " */
  prefix: string;
}

export interface AdapterConfig {
  /** 该工具本地登录态目录（采集/恢复的目标），支持 %ENV% 与 ~ */
  credential_dir: string;
  /** 检测到这些进程运行时阻止切换 */
  process_names: string[];
  /** 签到接口，留空 = 手动模式（只做凭据切换，不模拟签到请求） */
  checkin_url: string;
  checkin_method: 'POST' | 'GET';
  /** 积分查询接口，留空 = 不自动拉取积分 */
  points_url: string;
  extra_headers: Record<string, string>;
  /** 从凭据文件中提取 token 注入请求头（接口逆向完成后配置） */
  auth: AdapterAuthConfig | null;
  include_patterns: string[];
  exclude_patterns: string[];
  /** 单文件采集上限（MB） */
  max_file_mb: number;
}

export interface MamConfig {
  server: { host: string; port: number };
  schedule: {
    checkin_time: string; // "HH:mm"
    jitter_minutes: number;
    points_poll_interval_hours: number;
    health_check_interval_hours: number;
  };
  switch: {
    strategy: SwitchStrategy;
    group_scope: string; // 'all' 或分组名
    auto_switch_after_checkin: boolean;
    account_interval_seconds: [number, number];
    allow_while_running: boolean;
  };
  security: { auto_lock_minutes: number };
  limits: {
    min_request_interval_ms: number;
    max_checkin_per_day: number;
    retry_delays_seconds: number[];
  };
  notify: {
    channels: Array<'desktop' | 'webhook'>;
    webhook_url: string;
    on: string[];
  };
  adapters: Record<ToolId, AdapterConfig>;
}

export const DEFAULT_EXCLUDES = [
  '**/Cache*/**',
  '**/CachedData/**',
  '**/Code Cache/**',
  '**/GPUCache/**',
  '**/logs/**',
  '**/Logs/**',
  '**/extensions/**',
  '**/node_modules/**',
  '**/*.log',
  '**/*.tmp',
  '**/*.lock',
  '**/Service Worker/CacheStorage/**',
];

export function defaultAdapterConfig(tool: ToolId): AdapterConfig {
  return {
    credential_dir: '',
    process_names:
      tool === 'trae' ? ['trae.exe', 'Trae.exe'] : ['CodeBuddy.exe', 'codebuddy.exe'],
    checkin_url: '',
    checkin_method: 'POST',
    points_url: '',
    extra_headers: {},
    auth: null,
    include_patterns: [],
    exclude_patterns: DEFAULT_EXCLUDES,
    max_file_mb: 10,
  };
}

export function defaultConfig(): MamConfig {
  return {
    server: { host: '127.0.0.1', port: 7431 },
    schedule: {
      checkin_time: '09:00',
      jitter_minutes: 30,
      points_poll_interval_hours: 6,
      health_check_interval_hours: 24,
    },
    switch: {
      strategy: 'round-robin',
      group_scope: 'all',
      auto_switch_after_checkin: true,
      account_interval_seconds: [30, 120],
      allow_while_running: false,
    },
    security: { auto_lock_minutes: 30 },
    limits: {
      min_request_interval_ms: 5000,
      max_checkin_per_day: 1,
      retry_delays_seconds: [60, 300, 900],
    },
    notify: {
      channels: ['desktop'],
      webhook_url: '',
      on: ['checkin_failed_twice', 'account_invalid', 'points_drop'],
    },
    adapters: {
      trae: defaultAdapterConfig('trae'),
      codebuddy: defaultAdapterConfig('codebuddy'),
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 深合并：user 配置覆盖默认值（数组直接替换） */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T));
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

export function loadConfig(file = CONFIG_FILE): MamConfig {
  const defaults = defaultConfig();
  if (!fs.existsSync(file)) {
    ensureDataDirs();
    fs.writeFileSync(file, JSON.stringify(defaults, null, 2), 'utf-8');
    return defaults;
  }
  const user = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const cfg = deepMerge(defaults, user);
  validateConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: MamConfig, file = CONFIG_FILE): void {
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf-8');
}

export function validateConfig(cfg: MamConfig): void {
  if (!/^\d{2}:\d{2}$/.test(cfg.schedule.checkin_time)) {
    throw new Error(`schedule.checkin_time 格式应为 HH:mm，当前为 ${cfg.schedule.checkin_time}`);
  }
  const [h, m] = cfg.schedule.checkin_time.split(':').map(Number);
  if (h > 23 || m > 59) throw new Error('schedule.checkin_time 时间不合法');
  const strategies: SwitchStrategy[] = ['round-robin', 'least-points', 'undated-first'];
  if (!strategies.includes(cfg.switch.strategy)) {
    throw new Error(`switch.strategy 必须是 ${strategies.join(' / ')} 之一`);
  }
  const [lo, hi] = cfg.switch.account_interval_seconds;
  if (lo < 0 || hi < lo) throw new Error('switch.account_interval_seconds 区间不合法');
}

/** 获取适配器凭据目录（已展开环境变量），未配置返回 null */
export function adapterCredentialDir(cfg: MamConfig, tool: ToolId): string | null {
  const raw = cfg.adapters[tool]?.credential_dir;
  if (!raw) return null;
  return expandPath(raw);
}

/** dot-path 读写配置：mam config set switch.strategy least-points */
export function setConfigValue(cfg: MamConfig, dottedPath: string, value: unknown): void {
  const keys = dottedPath.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = cfg;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) {
      throw new Error(`配置路径不存在：${keys.slice(0, i + 1).join('.')}`);
    }
    node = node[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (!(last in node)) throw new Error(`配置项不存在：${dottedPath}`);
  node[last] = value;
}

export function getConfigValue(cfg: MamConfig, dottedPath: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = cfg;
  for (const key of dottedPath.split('.')) {
    if (node == null || typeof node !== 'object' || !(key in node)) {
      throw new Error(`配置路径不存在：${dottedPath}`);
    }
    node = node[key];
  }
  return node;
}

/** 解析 CLI 传入的 JSON/字符串值 */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
