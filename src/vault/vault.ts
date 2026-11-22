import fs from 'node:fs';
import crypto from 'node:crypto';
import type { CredentialBlob, ToolId } from '../shared/types.js';

/**
 * 凭据加密库：独立于 SQLite 的 vault.json
 * - 主密钥由用户口令经 scrypt 派生（口令不落盘）
 * - 每条凭据独立 IV + AuthTag，AES-256-GCM
 */
interface VaultEntry {
  iv: string;
  tag: string;
  ct: string;
}

interface VaultFile {
  version: number;
  kdf: 'scrypt';
  salt: string;
  verifier: VaultEntry; // 校验口令是否正确
  entries: Record<string, VaultEntry>;
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const VERIFIER_PLAINTEXT = 'mam-vault-ok';

export class CredentialVault {
  private key: Buffer | null = null;
  private data: VaultFile | null = null;

  constructor(private readonly filePath: string) {}

  /** 是否已完成初始化（文件存在） */
  isInitialized(): boolean {
    return fs.existsSync(this.filePath);
  }

  isUnlocked(): boolean {
    return this.key !== null;
  }

  /** 初始化：设置主口令（仅首次） */
  initialize(password: string): void {
    if (this.isInitialized()) throw new Error('凭据库已初始化，如需重置口令请删除 vault.json（将丢失所有凭据）');
    if (password.length < 6) throw new Error('主口令至少 6 位');
    const salt = crypto.randomBytes(16);
    const key = this.deriveKey(password, salt);
    const data: VaultFile = {
      version: 1,
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      verifier: this.encrypt(key, VERIFIER_PLAINTEXT),
      entries: {},
    };
    this.key = key;
    this.data = data;
    this.flush();
  }

  /** 用口令解锁；成功返回 true */
  unlock(password: string): boolean {
    if (!this.isInitialized()) throw new Error('凭据库未初始化，请先运行 mam init');
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as VaultFile;
    const key = this.deriveKey(password, Buffer.from(raw.salt, 'base64'));
    try {
      const plain = this.decrypt(key, raw.verifier);
      if (plain !== VERIFIER_PLAINTEXT) return false;
    } catch {
      return false;
    }
    this.key = key;
    this.data = raw;
    return true;
  }

  private requireUnlocked(): void {
    if (!this.key || !this.data) throw new Error('凭据库未解锁');
  }

  private deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.scryptSync(password, salt, 32, SCRYPT_PARAMS);
  }

  private encrypt(key: Buffer, plaintext: string): VaultEntry {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  private decrypt(key: Buffer, entry: VaultEntry): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.ct, 'base64')),
      decipher.final(),
    ]).toString('utf-8');
  }

  private flush(): void {
    this.requireUnlocked();
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  /** 存入/覆盖一条凭据 */
  put(id: string, blob: CredentialBlob): void {
    this.requireUnlocked();
    this.data!.entries[id] = this.encrypt(this.key!, JSON.stringify(blob));
    this.flush();
  }

  get(id: string): CredentialBlob | null {
    this.requireUnlocked();
    const entry = this.data!.entries[id];
    if (!entry) return null;
    try {
      return JSON.parse(this.decrypt(this.key!, entry)) as CredentialBlob;
    } catch {
      throw new Error(`凭据 ${id} 解密失败（数据损坏或口令不符）`);
    }
  }

  delete(id: string): boolean {
    this.requireUnlocked();
    const existed = id in this.data!.entries;
    delete this.data!.entries[id];
    if (existed) this.flush();
    return existed;
  }

  /** 列出凭据元信息（需解锁） */
  list(): Array<{ id: string; toolId: ToolId; capturedAt: number; fileCount: number }> {
    this.requireUnlocked();
    return Object.entries(this.data!.entries).map(([id]) => {
      const blob = this.get(id)!;
      return {
        id,
        toolId: blob.toolId,
        capturedAt: blob.capturedAt,
        fileCount: Object.keys(blob.files).length,
      };
    });
  }

  /** 锁定（清除内存中的密钥） */
  lock(): void {
    this.key = null;
    this.data = null;
  }
}
