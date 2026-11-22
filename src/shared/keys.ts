import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { KEY_FILE } from './paths.js';

/**
 * 主口令托管：让计划任务/服务在无人值守时也能解锁凭据库。
 * - Windows：DPAPI（CurrentUser），仅当前用户可解密
 * - Linux：机器绑定密钥（/etc/machine-id + uid），文件权限 0600
 */
interface KeyFile {
  version: 1;
  method: 'dpapi' | 'machine-bound';
  payload: string;
  createdAt: number;
}

function readKeyFile(): KeyFile | null {
  try {
    if (!fs.existsSync(KEY_FILE)) return null;
    return JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8')) as KeyFile;
  } catch {
    return null;
  }
}

function machineKey(): Buffer {
  let machineId = '';
  try {
    machineId = fs.readFileSync('/etc/machine-id', 'utf-8').trim();
  } catch {
    machineId = os.hostname();
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return crypto.createHash('sha256').update(`mam|${machineId}|${uid}`).digest();
}

function dpapiProtect(secret: string): string {
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:MAM_SECRET),$null,'CurrentUser');" +
    "[Convert]::ToBase64String($b)";
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, MAM_SECRET: secret },
    encoding: 'utf-8',
    timeout: 30_000,
    windowsHide: true,
  }).trim();
}

function dpapiUnprotect(base64: string): string {
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String($env:MAM_SECRET);" +
    "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    "[Text.Encoding]::UTF8.GetString($p)";
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, MAM_SECRET: base64 },
    encoding: 'utf-8',
    timeout: 30_000,
    windowsHide: true,
  }).trim();
}

function encryptMachineBound(secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf-8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decryptMachineBound(payload: string): string | null {
  try {
    const [ivB64, tagB64, ctB64] = payload.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', machineKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}

/** 保存主口令（供无人值守任务使用） */
export function saveKey(secret: string): KeyFile['method'] {
  let method: KeyFile['method'];
  let payload: string;
  if (process.platform === 'win32') {
    try {
      payload = dpapiProtect(secret);
      method = 'dpapi';
    } catch {
      payload = encryptMachineBound(secret);
      method = 'machine-bound';
    }
  } else {
    payload = encryptMachineBound(secret);
    method = 'machine-bound';
  }
  const data: KeyFile = { version: 1, method, payload, createdAt: Date.now() };
  fs.writeFileSync(KEY_FILE, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(KEY_FILE, 0o600);
  } catch {
    /* Windows 忽略 */
  }
  return method;
}

/** 读取已托管的主口令 */
export function loadKey(): string | null {
  const data = readKeyFile();
  if (!data) return null;
  if (data.method === 'dpapi') {
    if (process.platform !== 'win32') return null;
    try {
      return dpapiUnprotect(data.payload);
    } catch {
      return null;
    }
  }
  return decryptMachineBound(data.payload);
}

export function hasKey(): boolean {
  return readKeyFile() !== null;
}

export function clearKey(): boolean {
  if (!fs.existsSync(KEY_FILE)) return false;
  fs.unlinkSync(KEY_FILE);
  return true;
}

export function keyFileInfo(): { path: string; method: string; createdAt: number } | null {
  const data = readKeyFile();
  if (!data) return null;
  return { path: KEY_FILE, method: data.method, createdAt: data.createdAt };
}
