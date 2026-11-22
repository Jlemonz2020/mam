import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Runtime } from '../core/runtime.js';
import { startScheduler } from '../scheduler/scheduler.js';
import { log, todayStr } from '../shared/logger.js';
import { PUBLIC_DIR } from '../shared/paths.js';
import { saveConfig, validateConfig, type MamConfig } from '../shared/config.js';
import type { AccountStatus, ToolId } from '../shared/types.js';
import { PANEL_HTML } from './panel-html.js';
import pkg from '../../package.json';

/** 面板 HTML：开发态读文件（可热改），打包后使用内嵌副本 */
let cachedPanel: string | null = null;
function panelHtml(): string {
  if (cachedPanel) return cachedPanel;
  try {
    cachedPanel = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
  } catch {
    cachedPanel = PANEL_HTML || '<h1>面板资源缺失</h1>';
  }
  return cachedPanel;
}

/** 打开应用窗口：Windows 优先 Edge --app（无地址栏，接近桌面应用） */
function openUI(url: string): void {
  try {
    if (process.platform === 'win32') {
      const candidates = [
        path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ];
      const browser = candidates.find((p) => fs.existsSync(p));
      if (browser) {
        spawn(browser, [`--app=${url}`, '--window-size=1360,900'], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return;
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    log.warn('自动打开窗口失败，请手动访问地址', { error: (e as Error).message });
  }
}

export async function startServer(
  rt: Runtime,
  password?: string,
  opts: { openBrowser?: boolean; port?: number } = {}
): Promise<{ url: string; port: number }> {
  // 传入口令则立即解锁；桌面安装版不传，由面板首次设置/解锁
  if (password) {
    if (!rt.vault.unlock(password)) {
      throw new Error('主口令错误，无法启动守护进程');
    }
  }

  const app = Fastify({ logger: false });
  let sessionToken: string | null = null;
  let lastActive = Date.now();

  const isLocked = () =>
    sessionToken === null ||
    Date.now() - lastActive > rt.cfg.security.auto_lock_minutes * 60 * 1000;

  // ---- API 鉴权 ----
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return;
    if (
      req.url === '/api/session/state' ||
      req.url === '/api/session/unlock' ||
      req.url === '/api/session/setup'
    ) {
      return;
    }
    if (sessionToken === null) {
      reply.code(423).send({ error: 'locked', message: '面板已锁定，请先解锁' });
      return;
    }
    if (Date.now() - lastActive > rt.cfg.security.auto_lock_minutes * 60 * 1000) {
      sessionToken = null;
      reply.code(423).send({ error: 'locked', message: '会话超时已锁定' });
      return;
    }
    if (req.headers.authorization !== `Bearer ${sessionToken}`) {
      reply.code(401).send({ error: 'unauthorized', message: '未授权' });
      return;
    }
    lastActive = Date.now();
  });

  // ---- 会话 ----
  app.get('/api/session/state', async () => ({
    initialized: rt.vault.isInitialized(),
    needsSetup: !rt.vault.isInitialized(),
    locked: sessionToken === null || isLocked(),
    autoLockMinutes: rt.cfg.security.auto_lock_minutes,
    version: pkg.version,
  }));

  /** 首次使用：在面板内设置主口令（安装版无需命令行） */
  app.post('/api/session/setup', async (req: FastifyRequest, reply: FastifyReply) => {
    const { password: pw } = (req.body ?? {}) as { password?: string };
    if (rt.vault.isInitialized()) {
      reply.code(400).send({ error: 'already_initialized', message: '凭据库已初始化' });
      return;
    }
    if (!pw || pw.length < 6) {
      reply.code(400).send({ error: 'weak_password', message: '主口令至少 6 位' });
      return;
    }
    rt.vault.initialize(pw);
    sessionToken = crypto.randomBytes(24).toString('hex');
    lastActive = Date.now();
    return { token: sessionToken };
  });

  app.post('/api/session/unlock', async (req: FastifyRequest, reply: FastifyReply) => {
    const { password: pw } = (req.body ?? {}) as { password?: string };
    if (!pw || !rt.vault.unlock(pw)) {
      reply.code(403).send({ error: 'forbidden', message: '主口令错误' });
      return;
    }
    sessionToken = crypto.randomBytes(24).toString('hex');
    lastActive = Date.now();
    return { token: sessionToken };
  });

  app.post('/api/session/lock', async () => {
    sessionToken = null;
    return { ok: true };
  });

  // ---- 账号 ----
  app.get('/api/accounts', async () => {
    const accounts = rt.repo.listAccounts();
    const balances = rt.repo.latestBalances();
    return accounts.map((a) => {
      const active = rt.repo.getActive(a.toolId);
      const todayRec = rt.repo.listCheckins({ accountId: a.id, from: todayStr(), to: todayStr() })[0];
      return {
        ...a,
        groups: rt.repo.groupsOfAccount(a.id),
        balance: balances.get(a.id) ?? null,
        isActive: active?.accountId === a.id,
        today: todayRec ? { status: todayRec.status, message: todayRec.message } : null,
      };
    });
  });

  app.post('/api/accounts', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as {
      toolId?: ToolId;
      name?: string;
      dir?: string;
      remark?: string;
      groups?: string[];
    };
    if ((body.toolId !== 'trae' && body.toolId !== 'codebuddy') || !body.name) {
      reply.code(400).send({ error: 'bad_request', message: '需要 toolId 和 name' });
      return;
    }
    if (body.dir) rt.cfg.adapters[body.toolId].credential_dir = body.dir;
    let blob;
    try {
      const { buildAdapters } = await import('../adapters/registry.js');
      blob = await buildAdapters(rt.cfg)[body.toolId].capture();
    } catch (e) {
      reply.code(400).send({ error: 'capture_failed', message: (e as Error).message });
      return;
    }
    const credentialId = `cred-${crypto.randomUUID()}`;
    rt.vault.put(credentialId, blob);
    const account = rt.repo.insertAccount({
      name: body.name,
      toolId: body.toolId,
      credentialId,
      remark: body.remark,
    });
    for (const g of body.groups ?? []) rt.repo.assignGroup(account.id, g);
    return { ok: true, account, fileCount: Object.keys(blob.files).length };
  });

  app.patch('/api/accounts/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { name?: string; status?: AccountStatus; remark?: string };
    const updated = rt.repo.updateAccount(id, body);
    if (!updated) {
      reply.code(404).send({ error: 'not_found', message: '账号不存在' });
      return;
    }
    return { ok: true, account: updated };
  });

  app.delete('/api/accounts/:id', async (req: FastifyRequest) => {
    const id = Number((req.params as { id: string }).id);
    const hard = (req.query as { hard?: string }).hard === '1';
    const account = rt.repo.getAccount(id);
    if (!account) return { ok: false, message: '账号不存在' };
    if (hard) {
      rt.repo.hardDeleteAccount(id);
      rt.vault.delete(account.credentialId);
    } else {
      rt.repo.softDeleteAccount(id);
    }
    return { ok: true };
  });

  // ---- 分组 ----
  app.get('/api/groups', async () =>
    rt.repo.listGroups().map((g) => ({ ...g, accountIds: rt.repo.accountIdsInGroup(g.name) }))
  );

  app.post('/api/groups', async (req: FastifyRequest, reply: FastifyReply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name) {
      reply.code(400).send({ error: 'bad_request', message: '需要 name' });
      return;
    }
    rt.repo.getOrCreateGroup(name);
    return { ok: true };
  });

  app.delete('/api/groups/:name', async (req: FastifyRequest) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    return { ok: rt.repo.deleteGroup(name) };
  });

  app.post('/api/groups/assign', async (req: FastifyRequest) => {
    const { accountId, group } = (req.body ?? {}) as { accountId?: number; group?: string };
    if (!accountId || !group) return { ok: false, message: '需要 accountId 和 group' };
    rt.repo.assignGroup(accountId, group);
    return { ok: true };
  });

  app.post('/api/groups/unassign', async (req: FastifyRequest) => {
    const { accountId, group } = (req.body ?? {}) as { accountId?: number; group?: string };
    if (!accountId || !group) return { ok: false, message: '需要 accountId 和 group' };
    rt.repo.unassignGroup(accountId, group);
    return { ok: true };
  });

  // ---- 切换 ----
  app.post('/api/switch/:id', async (req: FastifyRequest) => {
    const id = Number((req.params as { id: string }).id);
    return rt.switcher.switchTo(id);
  });

  // ---- 签到 ----
  app.post('/api/checkin', async (req: FastifyRequest) => {
    const body = (req.body ?? {}) as {
      accountId?: number;
      group?: string;
      intervalSeconds?: [number, number];
      noRetry?: boolean;
    };
    return rt.checkin.runDailyJob({
      accountId: body.accountId,
      group: body.group,
      intervalSeconds: body.intervalSeconds,
      noRetry: body.noRetry,
      switchBack: false,
    });
  });

  app.get('/api/checkin/records', async (req: FastifyRequest) => {
    const q = req.query as { month?: string; accountId?: string };
    const month = q.month ?? todayStr().slice(0, 7);
    const accountId = q.accountId ? Number(q.accountId) : undefined;
    return rt.repo.listCheckins({ accountId, from: `${month}-01`, to: `${month}-31` });
  });

  // ---- 积分 ----
  app.get('/api/points', async (req: FastifyRequest) => {
    const days = Number((req.query as { days?: string }).days ?? 30);
    return rt.points.stats(days);
  });

  app.post('/api/points/refresh', async (req: FastifyRequest) => {
    const { group } = (req.body ?? {}) as { group?: string };
    const results = await rt.points.refreshAll(group ?? rt.cfg.switch.group_scope);
    return results.map((r) => ({ accountId: r.account.id, name: r.account.name, balance: r.balance }));
  });

  // ---- 日志 ----
  app.get('/api/logs', async (req: FastifyRequest) => {
    const q = req.query as { taskType?: string; accountId?: string; limit?: string };
    return rt.repo.listLogs({
      taskType: q.taskType || undefined,
      accountId: q.accountId ? Number(q.accountId) : undefined,
      limit: q.limit ? Number(q.limit) : 200,
    });
  });

  // ---- 概览 ----
  app.get('/api/overview', async () => {
    const accounts = rt.repo.listAccounts();
    const balances = rt.repo.latestBalances();
    const today = todayStr();
    const todayRecords = rt.repo.listCheckins({ from: today, to: today });
    const series = rt.points.stats(30);
    return {
      accountCount: accounts.length,
      invalidCount: accounts.filter((a) => a.status === 'invalid' || a.status === 'banned').length,
      today: {
        total: accounts.filter((a) => a.status === 'active').length,
        success: todayRecords.filter((r) => r.status === 'success' || r.status === 'already').length,
        failed: todayRecords.filter((r) => r.status === 'failed').length,
      },
      totalPoints: balances.size ? [...balances.values()].reduce((s, v) => s + v, 0) : 0,
      pointsSeries: series.accounts.map((s) => ({
        accountId: s.account.id,
        name: s.account.name,
        snapshots: s.snapshots.map((sn) => ({ t: sn.capturedAt, v: sn.balance })),
      })),
      schedule: rt.cfg.schedule,
    };
  });

  // ---- 配置 ----
  app.get('/api/config', async () => rt.cfg);

  app.put('/api/config', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as MamConfig;
    try {
      validateConfig(body);
      saveConfig(body);
      rt.reloadConfig();
      return { ok: true };
    } catch (e) {
      reply.code(400).send({ error: 'bad_request', message: (e as Error).message });
      return;
    }
  });

  // ---- 静态面板 ----
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.type('text/html; charset=utf-8').send(panelHtml());
  });

  const { host } = rt.cfg.server;
  const desiredPort = opts.port ?? rt.cfg.server.port;
  await app.listen({ host, port: desiredPort });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : desiredPort;
  const browserHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${browserHost}:${port}`;

  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │  MAM 多账号管理面板已启动                    │');
  console.log(`  │  地址: ${url.padEnd(36)}│`);
  console.log(`  │  签到: 每日 ${rt.cfg.schedule.checkin_time} ±${rt.cfg.schedule.jitter_minutes}min        │`);
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
  log.info('守护进程启动完成', { host, port });

  startScheduler(rt);
  if (opts.openBrowser) openUI(url);
  return { url, port };
}
