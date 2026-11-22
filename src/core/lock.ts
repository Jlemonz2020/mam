import fs from 'node:fs';
import { INSTANCE_LOCK_FILE } from '../shared/paths.js';
import { isPidAlive } from './process.js';

/**
 * 单实例锁：防止两个进程同时操作配置文件与登录态。
 * 持有者进程退出后，锁文件残留会通过 PID 存活检测自动接管。
 */
export class InstanceLock {
  private held = false;

  async acquire(): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = fs.openSync(INSTANCE_LOCK_FILE, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        fs.closeSync(fd);
        this.held = true;
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          const { pid } = JSON.parse(fs.readFileSync(INSTANCE_LOCK_FILE, 'utf-8')) as { pid: number };
          if (!(await isPidAlive(pid))) {
            fs.unlinkSync(INSTANCE_LOCK_FILE); // 残留锁，接管
            continue;
          }
        } catch {
          try {
            fs.unlinkSync(INSTANCE_LOCK_FILE);
          } catch {
            /* ignore */
          }
          continue;
        }
        return false;
      }
    }
    return false;
  }

  release(): void {
    if (!this.held) return;
    try {
      fs.unlinkSync(INSTANCE_LOCK_FILE);
    } catch {
      /* ignore */
    }
    this.held = false;
  }
}

/** 进程中只持有一份锁 */
export const instanceLock = new InstanceLock();
