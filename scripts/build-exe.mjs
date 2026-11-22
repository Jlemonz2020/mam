/**
 * 构建单文件可执行程序（Node SEA）：
 *   1. 生成内嵌面板 src/server/panel-html.ts
 *   2. esbuild 打包为单文件 CJS
 *   3. 生成 SEA blob
 *   4. 复制当前平台 node 可执行文件并注入 blob
 * 产物：dist/mam.exe（Windows）/ dist/mam（Linux/macOS）
 * 在哪个平台运行，就产出该平台的可执行文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

console.log('① 生成内嵌面板…');
execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-panel.mjs')], { stdio: 'inherit' });

console.log('② 打包应用代码…');
await build({
  entryPoints: [path.join(root, 'src/cli/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(dist, 'mam.cjs'),
  logLevel: 'warning',
  external: [],
  define: { 'import.meta.url': 'undefined' },
});

console.log('③ 生成 SEA blob…');
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: path.join(dist, 'mam.cjs'),
      output: path.join(dist, 'mam.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2
  ),
  'utf-8'
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

const exeName = process.platform === 'win32' ? 'mam.exe' : 'mam';
const target = path.join(dist, exeName);
console.log(`④ 生成 ${exeName}…`);
fs.copyFileSync(process.execPath, target);

console.log('⑤ 注入应用代码…');
execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
    target,
    'NODE_SEA_BLOB',
    path.join(dist, 'mam.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { stdio: 'inherit' }
);

if (process.platform !== 'win32') fs.chmodSync(target, 0o755);

const sizeMb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ 构建完成：${target}（${sizeMb} MB）`);
console.log('  用法：');
console.log(`    ${exeName} init`);
console.log(`    ${exeName} desktop`);
console.log(`    ${exeName} serve`);
