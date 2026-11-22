import cron from 'node-cron';
import type { Runtime } from '../core/runtime.js';
import { log } from '../shared/logger.js';

/** 包装随机抖动：cron 触发后再延迟 0~jitter 分钟执行 */
function withJitter(jitterMinutes: number, fn: () => Promise<unknown>): () => void {
  return () => {
    const delay = Math.floor(Math.random() * jitterMinutes * 60 * 1000);
    log.info(`定时任务触发，随机延迟 ${Math.round(delay / 1000)}s 后执行（风控抖动）`);
    setTimeout(() => {
      fn().catch((e) => log.error('定时任务执行失败', { error: (e as Error).message }));
    }, delay);
  };
}

/** 启动后台调度：每日签到 / 积分轮询 / 健康检查 */
export function startScheduler(rt: Runtime): void {
  const { schedule } = rt.cfg;
  const [h, m] = schedule.checkin_time.split(':').map(Number);

  /** 凭据库未解锁时不执行需要解密凭据的任务 */
  const requireUnlocked = (task: string): boolean => {
    if (rt.vault.isUnlocked()) return true;
    log.warn(`凭据库未解锁，跳过「${task}」定时任务（打开面板解锁一次后即可自动执行）`);
    return false;
  };

  cron.schedule(`${m} ${h} * * *`, withJitter(schedule.jitter_minutes, async () => {
    if (!requireUnlocked('每日签到')) return;
    log.info('开始执行每日签到任务');
    const summary = await rt.checkin.runDailyJob({});
    log.info(
      `每日签到完成：成功 ${summary.success} / 已签 ${summary.already} / 失败 ${summary.failed} / 跳过 ${summary.skipped}`
    );
  }));

  if (schedule.points_poll_interval_hours > 0) {
    const intervalMs = schedule.points_poll_interval_hours * 3600 * 1000;
    const poll = async () => {
      if (!requireUnlocked('积分轮询')) return;
      log.info('开始积分轮询');
      const result = await rt.points.refreshAll(rt.cfg.switch.group_scope);
      const got = result.filter((r) => r.balance !== null).length;
      log.info(`积分轮询完成：${got}/${result.length} 个账号获取成功`);
    };
    setTimeout(() => poll().catch((e) => log.error('积分轮询失败', { error: (e as Error).message })), 60_000);
    setInterval(() => poll().catch((e) => log.error('积分轮询失败', { error: (e as Error).message })), intervalMs);
  }

  if (schedule.health_check_interval_hours > 0) {
    setInterval(() => {
      (async () => {
        for (const account of rt.repo.listAccounts()) {
          if (account.status !== 'active') continue;
          const active = rt.repo.getActive(account.toolId);
          if (active?.accountId !== account.id) continue; // 只检查当前活跃账号（不触发切换）
          const adapter = { trae: rt.cfg.adapters.trae, codebuddy: rt.cfg.adapters.codebuddy }[account.toolId];
          if (!adapter.points_url) continue;
          // validate 需要 adapter 实例，走 runtime 重建太重，此处简化为日志
          log.file('info', '健康检查：跳过（仅活跃账号在线时深度校验）', { accountId: account.id });
        }
      })().catch(() => undefined);
    }, schedule.health_check_interval_hours * 3600 * 1000);
  }

  log.info(
    `调度器已启动：签到 ${schedule.checkin_time}（±${schedule.jitter_minutes}min），积分轮询每 ${schedule.points_poll_interval_hours}h`
  );
}
