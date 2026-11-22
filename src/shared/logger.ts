import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './paths.js';

let currentDate = '';
let stream: fs.WriteStream | null = null;

function getStream(): fs.WriteStream {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (!stream || currentDate !== today) {
    stream?.end();
    currentDate = today;
    stream = fs.createWriteStream(path.join(LOG_DIR, `app-${today}.ndjson`), {
      flags: 'a',
    });
  }
  return stream;
}

function fmt(level: string, msg: string, data?: Record<string, unknown>): string {
  const line = JSON.stringify({ ts: Date.now(), level, msg, ...data });
  getStream().write(line + '\n');
  const extra = data ? ` ${JSON.stringify(data)}` : '';
  const colors: Record<string, string> = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
  return `${colors[level] ?? ''}[${level}]\x1b[0m ${msg}${extra}`;
}

export const log = {
  info(msg: string, data?: Record<string, unknown>): void {
    console.log(fmt('info', msg, data));
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    console.warn(fmt('warn', msg, data));
  },
  error(msg: string, data?: Record<string, unknown>): void {
    console.error(fmt('error', msg, data));
  },
  /** 面板/守护进程静默模式下的纯文件日志 */
  file(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void {
    getStream().write(JSON.stringify({ ts: Date.now(), level, msg, ...data }) + '\n');
  },
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomBetween(lo: number, hi: number): number {
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

export function todayStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function monthStr(d = new Date()): string {
  return todayStr(d).slice(0, 7);
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
