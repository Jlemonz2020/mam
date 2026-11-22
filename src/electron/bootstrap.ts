/**
 * 桌面端引导入口：必须在加载业务模块之前确定数据目录，
 * 因为这些模块在导入时就会解析 MAM_HOME（模块级常量）。
 */
import { app } from 'electron';
import path from 'node:path';

if (!process.env.MAM_HOME) {
  // 安装目录通常不可写，数据统一放 %APPDATA%\<app>\data
  process.env.MAM_HOME = path.join(app.getPath('userData'), 'data');
}

void import('./main.js');
