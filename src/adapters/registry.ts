import type { BaseAdapter } from './base.js';
import type { ToolId } from '../shared/types.js';
import type { MamConfig } from '../shared/config.js';

import { BaseAdapter as TraeBase } from './base.js';
import { BaseAdapter as CodeBuddyBase } from './base.js';

export class TraeAdapter extends TraeBase {
  readonly toolId = 'trae' as const;
  readonly displayName = 'Trae';
}

export class CodeBuddyAdapter extends CodeBuddyBase {
  readonly toolId = 'codebuddy' as const;
  readonly displayName = 'CodeBuddy';
}

/** doctor 命令使用的候选登录态目录（Windows） */
export const CANDIDATE_DIRS: Record<ToolId, string[]> = {
  trae: [
    '~/.trae',
    '%APPDATA%/Trae',
    '%APPDATA%/Trae CN',
    '%LOCALAPPDATA%/Trae',
  ],
  codebuddy: [
    '~/.codebuddy',
    '%APPDATA%/CodeBuddy',
    '%APPDATA%/CodeBuddy CN',
    '%APPDATA%/Tencent/CodeBuddy',
    '%LOCALAPPDATA%/Programs/CodeBuddy',
  ],
};

export function buildAdapters(cfg: MamConfig): Record<ToolId, BaseAdapter> {
  return {
    trae: new TraeAdapter(cfg, cfg.adapters.trae),
    codebuddy: new CodeBuddyAdapter(cfg, cfg.adapters.codebuddy),
  };
}
