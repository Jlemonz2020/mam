import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/** 兼容三种运行形态：ESM(tsx) / CJS 打包产物 / SEA 单文件 */
function runtimeRequire(id: string): unknown {
  try {
    return (require as NodeRequire)(id);
  } catch {
    return createRequire(import.meta.url)(id);
  }
}

/** 是否运行在 Node SEA 单文件可执行程序中 */
export function isPackaged(): boolean {
  try {
    const sea = runtimeRequire('node:sea') as { isSea?: () => boolean };
    return typeof sea.isSea === 'function' && sea.isSea();
  } catch {
    return false;
  }
}

function detectRoot(): string {
  if (isPackaged()) return path.dirname(process.execPath);
  // CJS 打包产物有 __dirname；ESM（tsx 开发态）走 import.meta.url
  try {
    return path.resolve(__dirname, '..', '..');
  } catch {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  }
}

/** 程序根目录：打包后为 exe 所在目录，开发态为项目根目录 */
export const ROOT = detectRoot();

/** 数据目录，可用环境变量 MAM_HOME 覆盖（服务器部署常用 /var/lib/mam） */
export const DATA_DIR = process.env.MAM_HOME
  ? path.resolve(process.env.MAM_HOME)
  : path.join(ROOT, 'data');

export const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
export const RECORDS_FILE = path.join(DATA_DIR, 'records.jsonl');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const VAULT_FILE = path.join(DATA_DIR, 'vault.json');
export const JOURNAL_FILE = path.join(DATA_DIR, 'switch.journal.json');
export const INSTANCE_LOCK_FILE = path.join(DATA_DIR, 'instance.lock');
/** 账号切换全局互斥锁 */
export const LOCK_FILE = path.join(DATA_DIR, 'switch.lock');
export const KEY_FILE = path.join(DATA_DIR, 'master.key');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const PUBLIC_DIR = path.join(ROOT, 'src', 'server', 'public');

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, LOG_DIR, BACKUP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 展开路径中的 %ENV% 与 ~ */
export function expandPath(p: string): string {
  let out = p;
  if (out.startsWith('~/') || out === '~') {
    out = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', out.slice(1));
  }
  out = out.replace(/%([^%]+)%/g, (_, key: string) => process.env[key] ?? `%${key}%`);
  return path.resolve(out);
}
