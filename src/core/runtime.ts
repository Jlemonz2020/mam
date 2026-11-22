import fs from 'node:fs';
import { ensureDataDirs, VAULT_FILE } from '../shared/paths.js';
import { loadConfig, type MamConfig } from '../shared/config.js';
import { Repo } from '../store/repo.js';
import { CredentialVault } from '../vault/vault.js';
import { buildAdapters } from '../adapters/registry.js';
import { SwitchService, recoverInterruptedSwitch } from './switcher.js';
import { CheckinService } from './checkin.js';
import { PointsService } from './points.js';

export interface Runtime {
  cfg: MamConfig;
  repo: Repo;
  vault: CredentialVault;
  switcher: SwitchService;
  checkin: CheckinService;
  points: PointsService;
  /** 启动时的数据恢复提示（配置损坏回退 / 未完成切换回滚） */
  recoveryNotes: string[];
  reloadConfig(): void;
}

/** 组装运行时（CLI / Server / 桌面端共用）。注意：vault 需另行解锁。 */
export function createRuntime(): Runtime {
  ensureDataDirs();
  const cfg = loadConfig();
  const repo = new Repo();
  const recoveryNotes: string[] = [];
  if (repo.loadNote) recoveryNotes.push(repo.loadNote);

  const recovered = recoverInterruptedSwitch(repo);
  if (recovered) recoveryNotes.push(recovered);

  const vault = new CredentialVault(VAULT_FILE);
  const adapters = buildAdapters(cfg);
  const switcher = new SwitchService(repo, vault, cfg, adapters);
  const checkin = new CheckinService(repo, vault, cfg, switcher, adapters);
  const points = new PointsService(repo, cfg, switcher, adapters);

  return {
    cfg,
    repo,
    vault,
    switcher,
    checkin,
    points,
    recoveryNotes,
    reloadConfig(): void {
      const fresh = loadConfig();
      Object.assign(cfg, fresh);
    },
  };
}

/** 数据目录是否已初始化 */
export function isInitialized(): boolean {
  return fs.existsSync(VAULT_FILE);
}
