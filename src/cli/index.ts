import { Command } from 'commander';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRuntime, isInitialized, type Runtime } from '../core/runtime.js';
import { runDoctor } from '../core/doctor.js';
import { instanceLock } from '../core/lock.js';
import { getConfigValue, parseValue, saveConfig, setConfigValue, validateConfig } from '../shared/config.js';
import { fmtTime, log, todayStr } from '../shared/logger.js';
import { DATA_DIR, ROOT, VAULT_FILE, isPackaged } from '../shared/paths.js';
import { clearKey, hasKey, keyFileInfo, loadKey, saveKey } from '../shared/keys.js';
import type { AccountStatus, ToolId } from '../shared/types.js';
import { ask, askPassword } from './prompt.js';
import { printTable } from './table.js';
import pkg from '../../package.json';

const program = new Command();
program.name('mam').description('Trae / CodeBuddy 多账号管理系统（桌面 + 服务器）').version(pkg.version);

/** 口令解析顺序：环境变量 → 托管密钥 → 交互输入 */
async function resolvePassword(opts: { interactive?: boolean; question?: string } = {}): Promise<string> {
  const env = process.env.MAM_PASSWORD;
  if (env) return env;
  const pwFile = process.env.MAM_PASSWORD_FILE;
  if (pwFile && fs.existsSync(pwFile)) {
    const fromFile = fs.readFileSync(pwFile, 'utf-8').trim();
    if (fromFile) return fromFile;
  }
  const stored = loadKey();
  if (stored) return stored;
  if (opts.interactive === false) {
    throw new Error('非交互模式无法获取主口令：请设置 MAM_PASSWORD 环境变量，或先执行 mam key store 托管口令');
  }
  return askPassword(opts.question ?? '请输入主口令:');
}

async function getRuntime(opts: { needVault?: boolean; interactive?: boolean } = {}): Promise<Runtime> {
  const rt = createRuntime();
  for (const note of rt.recoveryNotes) log.warn(`[恢复] ${note}`);
  if (opts.needVault !== false) {
    if (!rt.vault.isInitialized()) {
      console.error('✗ 凭据库未初始化，请先运行：mam init');
      process.exit(1);
    }
    const pw = await resolvePassword({ interactive: opts.interactive });
    if (!rt.vault.unlock(pw)) {
      console.error('✗ 主口令错误');
      process.exit(1);
    }
  }
  return rt;
}

function requireTool(value: string): ToolId {
  if (value !== 'trae' && value !== 'codebuddy') {
    console.error('✗ --tool 必须是 trae 或 codebuddy');
    process.exit(1);
  }
  return value;
}

/** 计划任务中要执行的命令 */
function scheduledCommand(): string {
  if (isPackaged()) return `"${process.execPath}" checkin --scheduled`;
  const cli = path.join(ROOT, 'src', 'cli', 'index.ts');
  return `"${process.execPath}" --import tsx "${cli}" checkin --scheduled`;
}

// ================= init =================
program
  .command('init')
  .description('初始化数据目录、默认配置与凭据库（设置主口令）')
  .action(async () => {
    const rt = createRuntime();
    if (rt.vault.isInitialized()) {
      console.error(`✗ 凭据库已存在（${VAULT_FILE}）。如需重置请手动删除该文件（将丢失全部已存凭据）。`);
      process.exit(1);
    }
    const pw1 = process.env.MAM_PASSWORD ?? (await askPassword('设置主口令（至少6位，用于加密账号凭据）:'));
    const pw2 = process.env.MAM_PASSWORD ?? (await askPassword('再次输入确认:'));
    if (pw1 !== pw2) {
      console.error('✗ 两次输入不一致');
      process.exit(1);
    }
    rt.vault.initialize(pw1);
    console.log(`✓ 初始化完成，数据目录：${DATA_DIR}`);
    console.log('  accounts.json / records.jsonl / config.json / vault.json 已就绪');
    console.log('\n下一步：');
    console.log('  1. 配置客户端登录态目录：mam config set adapters.trae.credential_dir "C:\\Users\\you\\.trae"');
    console.log('  2. 在客户端登录账号后采集：mam add -t trae -n 账号A');
    console.log('  3. 桌面模式：mam desktop ；服务器常驻：mam serve');
    console.log('  4. 无人值守定时签到：mam key store && mam task install --time 09:00');
  });

// ================= add =================
program
  .command('add')
  .description('添加账号：采集当前客户端登录态并加密入库')
  .requiredOption('-t, --tool <tool>', '工具：trae | codebuddy')
  .requiredOption('-n, --name <name>', '账号显示名')
  .option('-d, --dir [dir]', '登录态目录（临时覆盖配置中的 credential_dir）')
  .option('-g, --groups [groups]', '分组，逗号分隔')
  .option('--remark [remark]', '备注')
  .action(async (opts: { tool: string; name: string; dir?: string; groups?: string; remark?: string }) => {
    const tool = requireTool(opts.tool);
    const rt = await getRuntime();
    if (opts.dir) rt.cfg.adapters[tool].credential_dir = opts.dir;

    let blob;
    try {
      const { buildAdapters } = await import('../adapters/registry.js');
      blob = await buildAdapters(rt.cfg)[tool].capture();
    } catch (e) {
      console.error(`✗ 采集登录态失败：${(e as Error).message}`);
      process.exit(1);
    }
    const credentialId = `cred-${crypto.randomUUID()}`;
    rt.vault.put(credentialId, blob);
    const account = rt.repo.insertAccount({ name: opts.name, toolId: tool, credentialId, remark: opts.remark });
    for (const g of (opts.groups ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      rt.repo.assignGroup(account.id, g);
    }
    console.log(`✓ 账号「${opts.name}」(#${account.id}) 已添加，采集 ${Object.keys(blob.files).length} 个凭据文件`);
    console.log(`  现在可切换：mam switch ${account.id}`);
  });

// ================= list =================
program
  .command('list')
  .description('列出全部账号')
  .option('-a, --all', '包含已删除账号')
  .action(async (opts: { all?: boolean }) => {
    const rt = await getRuntime();
    const accounts = rt.repo.listAccounts({ includeDeleted: opts.all });
    if (accounts.length === 0) {
      console.log('（暂无账号，使用 mam add 添加）');
      return;
    }
    const balances = rt.repo.latestBalances();
    const rows = accounts.map((a) => {
      const active = rt.repo.getActive(a.toolId);
      const today = rt.repo.listCheckins({ accountId: a.id, from: todayStr(), to: todayStr() })[0];
      return [
        a.id,
        a.name + (active?.accountId === a.id ? ' ●' : ''),
        a.toolId,
        a.deletedAt ? 'deleted' : a.status,
        rt.repo.groupsOfAccount(a.id).join(',') || '-',
        balances.get(a.id) ?? '-',
        today ? today.status : '-',
      ];
    });
    printTable(['ID', '名称(●=活跃)', '工具', '状态', '分组', '积分', '今日'], rows);
  });

// ================= remove / edit =================
program
  .command('remove')
  .argument('<id>', '账号 ID')
  .description('删除账号（默认软删除，--hard 同时删除凭据）')
  .option('-y, --yes', '跳过确认')
  .option('--hard', '彻底删除（含加密库中的凭据）')
  .action(async (id: string, opts: { yes?: boolean; hard?: boolean }) => {
    const rt = await getRuntime();
    const account = rt.repo.getAccount(Number(id));
    if (!account) {
      console.error('✗ 账号不存在');
      process.exit(1);
    }
    if (!opts.yes) {
      const answer = await ask(`确认删除账号「${account.name}」(#${account.id})？(y/N)`);
      if (answer.toLowerCase() !== 'y') return;
    }
    if (opts.hard) {
      rt.repo.hardDeleteAccount(account.id);
      rt.vault.delete(account.credentialId);
    } else {
      rt.repo.softDeleteAccount(account.id);
    }
    console.log(`✓ 账号「${account.name}」已${opts.hard ? '彻底' : ''}删除`);
  });

program
  .command('edit')
  .argument('<id>', '账号 ID')
  .description('编辑账号信息')
  .option('--name [name]', '新名称')
  .option('--status [status]', '状态：active | paused | invalid | banned')
  .option('--remark [remark]', '备注')
  .action(async (id: string, opts: { name?: string; status?: string; remark?: string }) => {
    const rt = await getRuntime();
    const status = opts.status as AccountStatus | undefined;
    if (status && !['active', 'paused', 'invalid', 'banned'].includes(status)) {
      console.error('✗ 状态不合法');
      process.exit(1);
    }
    const updated = rt.repo.updateAccount(Number(id), { name: opts.name, status, remark: opts.remark });
    if (!updated) {
      console.error('✗ 账号不存在');
      process.exit(1);
    }
    console.log(`✓ 已更新账号「${updated.name}」`);
  });

// ================= switch / active =================
program
  .command('switch')
  .argument('<id>', '账号 ID')
  .description('切换到指定账号（事务日志 + 备份 + 失败回滚）')
  .action(async (id: string) => {
    const rt = await getRuntime();
    const result = await rt.switcher.switchTo(Number(id));
    console.log(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('active')
  .description('显示各工具当前活跃账号')
  .action(async () => {
    const rt = await getRuntime();
    const rows = (['trae', 'codebuddy'] as ToolId[]).map((tool) => {
      const active = rt.repo.getActive(tool);
      const account = active ? rt.repo.getAccount(active.accountId) : null;
      return [tool, account ? account.name : '（无）', active ? fmtTime(active.switchedAt) : '-'];
    });
    printTable(['工具', '当前账号', '切换时间'], rows);
  });

// ================= group =================
const group = program.command('group').description('分组管理');
group.command('add').argument('<name>', '分组名').action(async (name: string) => {
  const rt = await getRuntime();
  rt.repo.getOrCreateGroup(name);
  console.log(`✓ 分组「${name}」已就绪`);
});
group.command('rm').argument('<name>', '分组名').action(async (name: string) => {
  const rt = await getRuntime();
  console.log(rt.repo.deleteGroup(name) ? `✓ 分组「${name}」已删除` : '✗ 分组不存在');
});
group.command('list').action(async () => {
  const rt = await getRuntime();
  printTable(
    ['分组', '账号数'],
    rt.repo.listGroups().map((g) => [g.name, rt.repo.accountIdsInGroup(g.name).length])
  );
});
group
  .command('assign')
  .argument('<accountId>', '账号 ID')
  .argument('<group>', '分组名')
  .action(async (accountId: string, g: string) => {
    const rt = await getRuntime();
    rt.repo.assignGroup(Number(accountId), g);
    console.log(`✓ 已将账号 #${accountId} 加入分组「${g}」`);
  });
group
  .command('unassign')
  .argument('<accountId>', '账号 ID')
  .argument('<group>', '分组名')
  .action(async (accountId: string, g: string) => {
    const rt = await getRuntime();
    rt.repo.unassignGroup(Number(accountId), g);
    console.log(`✓ 已将账号 #${accountId} 移出分组「${g}」`);
  });

// ================= checkin =================
program
  .command('checkin')
  .description('执行签到（默认按配置的分组范围与策略批量执行）')
  .option('--account <id>', '仅对指定账号签到')
  .option('--group <name>', '仅对指定分组签到')
  .option('--no-retry', '失败不重试')
  .option('--interval <lo,hi>', '账号间隔秒数（如 "1,5"），覆盖配置')
  .option('--scheduled', '无人值守模式（不交互，必须已托管口令）')
  .action(async (opts: { account?: string; group?: string; retry?: boolean; interval?: string; scheduled?: boolean }) => {
    const rt = await getRuntime({ interactive: !opts.scheduled });
    let interval: [number, number] | undefined;
    if (opts.interval) {
      const [lo, hi] = opts.interval.split(',').map(Number);
      interval = [lo, hi];
    }
    if (!opts.scheduled) console.log('开始执行签到任务…');
    const summary = await rt.checkin.runDailyJob({
      accountId: opts.account ? Number(opts.account) : undefined,
      group: opts.group,
      noRetry: opts.retry === false,
      intervalSeconds: interval,
      switchBack: true,
    });
    if (opts.scheduled) {
      log.file('info', '定时签到完成', { ...summary, records: undefined });
      if (summary.failed > 0 && summary.success === 0) process.exitCode = 1;
      return;
    }
    printTable(
      ['账号ID', '日期', '状态', '积分', '重试', '说明'],
      summary.records.map((r) => [r.accountId, r.checkinDate, r.status, r.reward, r.retried, r.message ?? ''])
    );
    console.log(`汇总：成功 ${summary.success} / 已签 ${summary.already} / 失败 ${summary.failed} / 跳过 ${summary.skipped}`);
  });

// ================= points / report =================
program
  .command('points')
  .description('积分查看 / 刷新')
  .option('--refresh', '立即刷新积分')
  .option('--account <id>', '仅刷新指定账号')
  .option('--group <name>', '刷新范围分组')
  .action(async (opts: { refresh?: boolean; account?: string; group?: string }) => {
    const rt = await getRuntime();
    if (opts.refresh) {
      if (opts.account) {
        const account = rt.repo.getAccount(Number(opts.account));
        if (!account) {
          console.error('✗ 账号不存在');
          process.exit(1);
        }
        await rt.switcher.switchTo(account.id);
        const balance = await rt.points.refreshActive(account);
        console.log(`账号「${account.name}」积分：${balance ?? '获取失败（未配置积分接口）'}`);
      } else {
        const results = await rt.points.refreshAll(opts.group ?? rt.cfg.switch.group_scope);
        printTable(['账号', '积分'], results.map((r) => [r.account.name, r.balance ?? '-']));
      }
      return;
    }
    const stats = rt.points.stats(30);
    printTable(
      ['ID', '账号', '工具', '最新积分', '近30天快照数'],
      stats.accounts.map((s) => [s.account.id, s.account.name, s.account.toolId, s.latest ?? '-', s.snapshots.length])
    );
    console.log(`积分总量：${stats.total}`);
  });

program
  .command('report')
  .description('签到与积分报表')
  .option('--month [YYYY-MM]', '统计月份', todayStr().slice(0, 7))
  .action(async (opts: { month: string }) => {
    const rt = await getRuntime();
    const month = opts.month;
    const rows = rt.repo.listAccounts().map((a) => {
      const recs = rt.repo.listCheckins({ accountId: a.id, from: `${month}-01`, to: `${month}-31` });
      return [
        a.id,
        a.name,
        a.toolId,
        recs.filter((r) => r.status === 'success').length,
        recs.filter((r) => r.status === 'already').length,
        recs.filter((r) => r.status === 'failed').length,
        rt.repo.monthlyReward(a.id, month),
        rt.repo.latestBalance(a.id) ?? '-',
      ];
    });
    printTable(['ID', '账号', '工具', `${month} 成功`, '已签', '失败', '本月收益', '最新余额'], rows);
  });

// ================= doctor =================
program
  .command('doctor')
  .description('环境自检：配置 / 存储 / 凭据库 / 登录态目录 / 接口 / 定时任务')
  .action(async () => {
    const rt = createRuntime();
    const { buildAdapters } = await import('../adapters/registry.js');
    const adapters = buildAdapters(rt.cfg);
    const key = keyFileInfo();
    const lines = await runDoctor(rt.cfg, rt.repo, rt.vault, adapters, {
      recoveryNotes: rt.recoveryNotes,
      keyInfo: key ? `已托管口令（${key.method}）` : '未托管口令（无人值守任务需要）',
      dataDir: DATA_DIR,
      packaged: isPackaged(),
    });
    for (const line of lines) {
      const symbol = { ok: '✓', warn: '⚠', fail: '✗', info: ' ' }[line.level];
      console.log(`${symbol} ${line.text}`);
    }
  });

// ================= config =================
const configCmd = program.command('config').description('配置管理');
configCmd.command('show').action(async () => {
  console.log(JSON.stringify(createRuntime().cfg, null, 2));
});
configCmd
  .command('get')
  .argument('<path>', 'dot 路径，如 switch.strategy')
  .action(async (p: string) => {
    console.log(JSON.stringify(getConfigValue(createRuntime().cfg, p)));
  });
configCmd
  .command('set')
  .argument('<path>', 'dot 路径')
  .argument('<value>', '值（JSON 或字符串）')
  .action(async (p: string, v: string) => {
    const rt = createRuntime();
    try {
      setConfigValue(rt.cfg, p, parseValue(v));
      validateConfig(rt.cfg);
      saveConfig(rt.cfg);
      console.log(`✓ 已设置 ${p} = ${v}`);
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ================= key（口令托管） =================
const keyCmd = program.command('key').description('主口令托管（供计划任务无人值守解锁）');
keyCmd
  .command('store')
  .description('保存主口令到本机（Windows: DPAPI / Linux: 机器绑定 + 0600）')
  .action(async () => {
    const pw = process.env.MAM_PASSWORD ?? (await askPassword('请输入要托管的主口令:'));
    if (!pw) {
      console.error('✗ 口令为空');
      process.exit(1);
    }
    const method = saveKey(pw);
    console.log(`✓ 主口令已托管（方式：${method}）`);
    console.log('  计划任务/服务将自动读取，无需交互输入');
  });
keyCmd.command('status').action(async () => {
  const info = keyFileInfo();
  if (!info) {
    console.log('⚠ 未托管主口令（无人值守任务需设置 MAM_PASSWORD 或执行 mam key store）');
    return;
  }
  console.log(`✓ 已托管：${info.path}（${info.method}，${fmtTime(info.createdAt)}）`);
});
keyCmd.command('clear').action(async () => {
  console.log(clearKey() ? '✓ 已删除托管口令' : '⚠ 无托管口令');
});

// ================= task（定时任务） =================
const TASK_NAME = 'MAM-DailyCheckin';
const taskCmd = program.command('task').description('系统定时任务管理（Windows 计划任务 / Linux systemd timer）');

taskCmd
  .command('install')
  .description('注册每日定时签到任务')
  .option('--time <HH:mm>', '触发时间', '09:00')
  .action(async (opts: { time: string }) => {
    const time = opts.time;
    if (!/^\d{2}:\d{2}$/.test(time)) {
      console.error('✗ --time 格式应为 HH:mm');
      process.exit(1);
    }
    if (!hasKey() && !process.env.MAM_PASSWORD) {
      console.error('✗ 无人值守任务需要先托管口令：mam key store');
      process.exit(1);
    }
    if (process.platform === 'win32') {
      const tr = scheduledCommand();
      execFileSync('schtasks', ['/Create', '/F', '/SC', 'DAILY', '/ST', time, '/TN', TASK_NAME, '/TR', tr], {
        windowsHide: true,
        stdio: 'inherit',
      });
      console.log(`✓ 已注册 Windows 计划任务「${TASK_NAME}」，每日 ${time} 执行`);
      console.log(`  查看：schtasks /Query /TN ${TASK_NAME}`);
    } else {
      const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
      fs.mkdirSync(systemdDir, { recursive: true });
      const execStart = isPackaged()
        ? `"${process.execPath}" checkin --scheduled`
        : `"${process.execPath}" --import tsx "${path.join(ROOT, 'src', 'cli', 'index.ts')}" checkin --scheduled`;
      const [hh, mm] = time.split(':');
      const service = `[Unit]
Description=MAM daily check-in
After=network-online.target

[Service]
Type=oneshot
Environment=MAM_HOME=${DATA_DIR}
ExecStart=${execStart}
`;
      const timer = `[Unit]
Description=Daily MAM check-in at ${time}

[Timer]
OnCalendar=*-*-* ${hh}:${mm}:00
Persistent=true
RandomizedDelaySec=1800

[Install]
WantedBy=timers.target
`;
      fs.writeFileSync(path.join(systemdDir, 'mam-checkin.service'), service, 'utf-8');
      fs.writeFileSync(path.join(systemdDir, 'mam-checkin.timer'), timer, 'utf-8');
      try {
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
        execFileSync('systemctl', ['--user', 'enable', '--now', 'mam-checkin.timer'], { stdio: 'inherit' });
        console.log(`✓ 已启用 systemd 用户定时器 mam-checkin.timer（每日 ${time}，错过会补跑）`);
        console.log('  注意：服务器重启后需用户登录才启动用户级 timer；如需开机即生效请改用系统级 unit');
      } catch {
        console.log('⚠ 已写入 unit 文件，但 systemctl 启用失败，请手动执行：');
        console.log('  systemctl --user daemon-reload && systemctl --user enable --now mam-checkin.timer');
      }
    }
  });

taskCmd
  .command('uninstall')
  .description('移除定时签到任务')
  .action(async () => {
    if (process.platform === 'win32') {
      try {
        execFileSync('schtasks', ['/Delete', '/F', '/TN', TASK_NAME], { windowsHide: true, stdio: 'inherit' });
        console.log(`✓ 已删除计划任务「${TASK_NAME}」`);
      } catch {
        console.log('⚠ 计划任务不存在或删除失败');
      }
    } else {
      const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
      try {
        execFileSync('systemctl', ['--user', 'disable', '--now', 'mam-checkin.timer'], { stdio: 'inherit' });
      } catch {
        /* ignore */
      }
      for (const f of ['mam-checkin.timer', 'mam-checkin.service']) {
        const p = path.join(systemdDir, f);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      console.log('✓ 已移除 systemd 定时器');
    }
  });

taskCmd.command('status').description('查看定时任务状态').action(async () => {
  if (process.platform === 'win32') {
    try {
      const ps = [
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
        `$t=Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop`,
        `$i=Get-ScheduledTaskInfo -TaskName '${TASK_NAME}'`,
        "function f($v){ if($v){ $v.ToString('yyyy-MM-dd HH:mm:ss') } else { '-' } }",
        "[pscustomobject]@{State=[string]$t.State;NextRunTime=(f $i.NextRunTime);LastRunTime=(f $i.LastRunTime);LastResult=$i.LastTaskResult;Command=$t.Actions[0].Execute;Arguments=$t.Actions[0].Arguments} | ConvertTo-Json -Compress",
      ].join(';');
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf-8',
        windowsHide: true,
      });
      const info = JSON.parse(out.trim()) as {
        State: string;
        NextRunTime: string;
        LastRunTime: string;
        LastResult: number;
        Command: string;
        Arguments: string;
      };
      console.log(`✓ 任务「${TASK_NAME}」已注册（状态：${info.State}）`);
      console.log(`  下次运行：${info.NextRunTime}`);
      console.log(`  上次运行：${info.LastRunTime}（结果码 ${info.LastResult}）`);
      console.log(`  命令：${info.Command} ${info.Arguments}`);
    } catch {
      console.log('⚠ 未注册定时任务，可执行：mam task install --time 09:00');
    }
  } else {
    try {
      const out = execFileSync('systemctl', ['--user', 'list-timers', '--no-pager'], { encoding: 'utf-8' });
      const line = out.split('\n').find((l) => l.includes('mam-checkin'));
      console.log(line ? `✓ ${line.trim()}` : '⚠ 未启用 mam-checkin.timer');
    } catch {
      console.log('⚠ 无法查询 systemd 定时器');
    }
  }
});

// ================= desktop / serve =================
program
  .command('desktop')
  .description('桌面模式：启动本地面板与调度器，并打开应用窗口')
  .option('--no-open', '不自动打开窗口')
  .option('--port <port>', '自定义端口')
  .action(async (opts: { open?: boolean; port?: string }) => {
    const rt = createRuntime();
    if (!isInitialized()) {
      console.error('✗ 尚未初始化，请先运行：mam init');
      process.exit(1);
    }
    if (!(await instanceLock.acquire())) {
      console.error('✗ 已有 MAM 实例在运行（同一时间只允许一个实例操作账号数据）');
      process.exit(1);
    }
    const pw = await resolvePassword({ interactive: true });
    if (!rt.vault.unlock(pw)) {
      instanceLock.release();
      console.error('✗ 主口令错误');
      process.exit(1);
    }
    if (opts.port) rt.cfg.server.port = Number(opts.port);
    const { startServer } = await import('../server/server.js');
    await startServer(rt, pw, { openBrowser: opts.open !== false });
    process.on('SIGINT', () => {
      instanceLock.release();
      process.exit(0);
    });
  });

program
  .command('serve')
  .description('服务器/守护模式：Web 面板 + API + 内置定时调度（无窗口）')
  .option('--port <port>', '自定义端口')
  .action(async (opts: { port?: string }) => {
    const rt = createRuntime();
    if (!isInitialized()) {
      console.error('✗ 请先运行 mam init');
      process.exit(1);
    }
    if (!(await instanceLock.acquire())) {
      console.error('✗ 已有 MAM 实例在运行');
      process.exit(1);
    }
    const pw = await resolvePassword({ interactive: true, question: '请输入主口令（守护进程）:' });
    if (opts.port) rt.cfg.server.port = Number(opts.port);
    const { startServer } = await import('../server/server.js');
    await startServer(rt, pw, { openBrowser: false });
    const shutdown = () => {
      instanceLock.release();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parseAsync().catch((e) => {
  log.error('命令执行失败', { error: (e as Error).message });
  process.exit(1);
});
