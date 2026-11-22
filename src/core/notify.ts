import { execFile } from 'node:child_process';
import type { MamConfig } from '../shared/config.js';
import { log } from '../shared/logger.js';

/** Windows 桌面气泡通知（best-effort，失败不影响主流程） */
async function desktopToast(title: string, message: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$n = New-Object System.Windows.Forms.NotifyIcon`,
    '$n.Icon = [System.Drawing.SystemIcons]::Information',
    '$n.Visible = $true',
    `$n.ShowBalloonTip(5000, ${JSON.stringify(title)}, ${JSON.stringify(message)}, [System.Windows.Forms.ToolTipIcon]::Warning)`,
    'Start-Sleep -Seconds 6',
    '$n.Dispose()',
  ].join('\n');
  await new Promise<void>((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20_000, windowsHide: true }, () => resolve());
  });
}

async function webhookPost(url: string, title: string, message: string): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, message, ts: Date.now() }),
  }).catch(() => undefined);
}

/** 事件通知入口：按配置过滤事件与渠道 */
export async function notify(cfg: MamConfig, event: string, title: string, message: string): Promise<void> {
  try {
    if (!cfg.notify.on.includes(event)) return;
    for (const channel of cfg.notify.channels) {
      if (channel === 'desktop') await desktopToast(title, message);
      if (channel === 'webhook' && cfg.notify.webhook_url) await webhookPost(cfg.notify.webhook_url, title, message);
    }
  } catch (e) {
    log.warn('通知发送失败', { error: (e as Error).message });
  }
}
