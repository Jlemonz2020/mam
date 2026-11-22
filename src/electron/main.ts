import { app, BrowserWindow, Menu, dialog, shell, Tray, nativeImage, Notification } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRuntime, type Runtime } from '../core/runtime.js';
import { startServer } from '../server/server.js';
import { TRAY_ICON_B64 } from './icon-data.js';

// 启动追踪（GUI 应用没有控制台，异常写入临时日志便于排查）
const TRACE_FILE = path.join(os.tmpdir(), 'mam-desktop.log');
function trace(msg: string): void {
  try {
    fs.appendFileSync(TRACE_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (e) => {
  trace(`UNCAUGHT: ${e.stack ?? e.message}`);
  try {
    dialog.showErrorBox('MAM 运行异常', `${e.message}\n\n日志：${TRACE_FILE}`);
  } catch {
    /* ignore */
  }
});
process.on('unhandledRejection', (e) => {
  trace(`UNHANDLED REJECTION: ${(e as Error)?.stack ?? String(e)}`);
});

// 数据目录：安装版程序目录不可写，统一放 %APPDATA%\MAM\data（可用 MAM_HOME 覆盖）
if (!process.env.MAM_HOME) {
  process.env.MAM_HOME = path.join(app.getPath('userData'), 'data');
}
trace(`boot start, MAM_HOME=${process.env.MAM_HOME}, execPath=${process.execPath}`);

const VERSION = app.getVersion();
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: Runtime | null = null;
let serverUrl = '';
let starting = false;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
trace(`single instance lock = ${gotLock}`);
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.mam.multiaccount');

  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    await boot();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void boot();
      else showWindow();
    });
  });

  // 关闭窗口不退出（驻留托盘继续执行每日签到），只有托盘「退出」才真正结束
  app.on('window-all-closed', () => {
    if (quitting && process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
}

function showWindow(): void {
  if (!mainWindow) {
    if (serverUrl) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function boot(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    trace('creating runtime…');
    runtime = createRuntime();
    const port = process.env.MAM_PORT ? Number(process.env.MAM_PORT) : 0; // 0 = 随机空闲端口
    trace(`starting server on port ${port}…`);
    const { url } = await startServer(runtime, undefined, { port, openBrowser: false });
    serverUrl = url;
    trace(`server ready: ${url}`);
    createWindow();
    buildMenu();
    createTray();
    trace('window + tray created');
  } catch (e) {
    const err = e as Error;
    trace(`BOOT FAILED: ${err.stack ?? err.message}`);
    dialog.showErrorBox(
      'MAM 启动失败',
      `${err.message}\n\n数据目录：${process.env.MAM_HOME}\n\n${err.stack ?? ''}`
    );
    app.quit();
  } finally {
    starting = false;
  }
}

function createWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1024,
    minHeight: 660,
    backgroundColor: '#070b11',
    title: 'MAM 多账号管理',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.loadURL(serverUrl);

  // 外部链接交给系统浏览器，窗口内只加载本地面板
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 点关闭 = 收进托盘（继续后台签到）
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow?.hide();
      if (tray && !tray.isDestroyed()) {
        new Notification({ title: 'MAM 已最小化到托盘', body: '每日签到仍在后台按计划执行，右键托盘图标可退出' }).show();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_B64, 'base64'));
    tray = new Tray(image.resize({ width: 16, height: 16 }));
    tray.setToolTip('MAM 多账号管理');
    refreshTrayMenu();
    tray.on('double-click', () => showWindow());
  } catch (e) {
    trace(`tray failed: ${(e as Error).message}`);
  }
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const autoStart = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主界面', click: () => showWindow() },
      { label: '立即执行签到', click: () => void runCheckinNow() },
      { type: 'separator' },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: autoStart,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          refreshTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

async function runCheckinNow(): Promise<void> {
  if (!runtime) return;
  if (!runtime.vault.isUnlocked()) {
    showWindow();
    dialog.showMessageBox({
      type: 'info',
      title: '需要先解锁',
      message: '请先在面板中输入主口令解锁，再执行签到。',
    });
    return;
  }
  new Notification({ title: 'MAM', body: '开始执行签到任务…' }).show();
  try {
    const summary = await runtime.checkin.runDailyJob({});
    new Notification({
      title: 'MAM 签到完成',
      body: `成功 ${summary.success} · 已签 ${summary.already} · 失败 ${summary.failed}`,
    }).show();
  } catch (e) {
    new Notification({ title: 'MAM 签到失败', body: (e as Error).message }).show();
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '重新加载', accelerator: 'F5', click: () => mainWindow?.reload() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开数据目录',
          click: () => {
            if (process.env.MAM_HOME) void shell.openPath(process.env.MAM_HOME);
          },
        },
        {
          label: '关于',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于 MAM',
              message: `MAM 多账号管理系统 v${VERSION}`,
              detail: `本地优先 · 凭据 AES-256-GCM 加密\n数据目录：${process.env.MAM_HOME}\n\n仅用于管理你合法持有的账号。`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
