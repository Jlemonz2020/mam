import fs from 'node:fs';
import path from 'node:path';

/** 极简 glob 匹配：支持 ** / * / 精确名（用于 include/exclude 规则） */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // "**" 跨目录
        re += '.*';
        i += 2;
        if (glob[i] === '/') i += 1; // "**/" 匹配零层或多层
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

export function matchAny(relPath: string, patterns: string[]): boolean {
  const posixRel = relPath.split(path.sep).join('/');
  const basename = posixRel.split('/').pop() ?? '';
  return patterns.some((p) => {
    const re = globToRegExp(p);
    return re.test(posixRel) || re.test(basename);
  });
}

export interface CaptureOptions {
  includePatterns: string[];
  excludePatterns: string[];
  maxFileBytes: number;
}

/**
 * 递归采集目录：返回 相对路径 -> base64 内容。
 * 应用 include/exclude 规则与单文件大小上限。
 */
export function captureDir(dir: string, opts: CaptureOptions): Record<string, string> {
  if (!fs.existsSync(dir)) throw new Error(`凭据目录不存在：${dir}`);
  const files: Record<string, string> = {};
  const walk = (cur: string, rel: string): void => {
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (opts.excludePatterns.length && matchAny(childRel, opts.excludePatterns)) continue;
      if (opts.includePatterns.length && !matchAny(childRel, opts.includePatterns)) continue;
      const childAbs = path.join(cur, e.name);
      if (e.isDirectory()) {
        walk(childAbs, childRel);
      } else if (e.isFile()) {
        const stat = fs.statSync(childAbs);
        if (stat.size > opts.maxFileBytes) continue; // 超大文件跳过
        files[childRel] = fs.readFileSync(childAbs).toString('base64');
      }
    }
  };
  walk(dir, '');
  return files;
}

/** 将凭据文件集写入目标目录（目录应为空/不存在，由调用方保证） */
export function restoreDir(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, b64] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    // 防路径穿越
    if (!path.resolve(abs).startsWith(path.resolve(dir))) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
  }
}

/** 清空目录内容（保留目录本身） */
export function clearDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}
