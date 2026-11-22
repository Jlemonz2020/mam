import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** 检测指定进程名是否正在运行（win32: tasklist / 其他: pgrep） */
export async function isProcessRunning(name: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await exec('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], {
        timeout: 10_000,
        windowsHide: true,
      });
      return stdout.toLowerCase().includes(name.toLowerCase());
    }
    const { stdout } = await exec('pgrep', ['-f', name], { timeout: 10_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** 检查进程是否存活（用于锁的过期判断） */
export async function isPidAlive(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        timeout: 10_000,
        windowsHide: true,
      });
      return stdout.includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
