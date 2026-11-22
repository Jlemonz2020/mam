/**
 * 桌面版构建：
 *   node scripts/build-desktop.mjs            → 生成 Windows 安装包（release/MAM-Setup-x.y.z.exe）
 *   node scripts/build-desktop.mjs --dir      → 只生成免安装目录（release/win-unpacked）
 *   node scripts/build-desktop.mjs --main-only→ 只打包主进程（配合 npx electron . 调试）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const mainOnly = args.includes('--main-only');
const dirOnly = args.includes('--dir');

console.log('① 生成内嵌面板与图标…');
execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-panel.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-icon.mjs')], { stdio: 'inherit' });

console.log('② 打包 Electron 主进程…');
fs.mkdirSync(path.join(root, 'dist-electron'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/electron/bootstrap.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(root, 'dist-electron/bootstrap.cjs'),
  external: ['electron'],
  logLevel: 'warning',
  define: { 'import.meta.url': 'undefined' },
});

if (mainOnly) {
  console.log('✓ 主进程已构建：dist-electron/bootstrap.cjs（可用 npx electron . 调试）');
  process.exit(0);
}

console.log('③ 调用 electron-builder…');
const builderArgs = dirOnly ? ['--dir'] : ['--win', 'nsis'];
execSync(`npx electron-builder ${builderArgs.join(' ')}`, { cwd: root, stdio: 'inherit' });
console.log('\n✓ 构建完成，产物位于 release/');
