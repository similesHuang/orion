import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const keyPath = path.join(os.homedir(), 'ga_keychain.enc');
const ALGO = 'aes-256-gcm';
const ITERATIONS = 100000;
const KEY_LEN = 32;
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;
const SALT_LEN = 16;

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, 'sha256');
}

function getPassword(): string {
  let userName: string;
  try {
    userName = os.userInfo().username;
  } catch {
    userName = process.env.USER || process.env.USERNAME || 'unknown';
  }
  const hostName = os.hostname();
  return `${userName}@${hostName}:ga_keychain:v2`;
}

/** Legacy XOR obfuscation (v1). Kept only for one-time migration. */
function legacyMask(): Buffer {
  const userName = getPassword().split(':')[0];
  return crypto.createHash('sha256').update(`${userName}@ga_keychain`).digest();
}

function legacyXor(data: Buffer): Buffer {
  const mask = legacyMask();
  return Buffer.from(data.map((b, i) => b ^ mask[i % mask.length]));
}

function encrypt(data: string): Buffer {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = deriveKey(getPassword(), salt);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

function decrypt(buf: Buffer): string {
  if (buf.length < SALT_LEN + IV_LEN + AUTH_TAG_LEN) {
    throw new Error('encrypted blob too short');
  }
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + AUTH_TAG_LEN);
  const encrypted = buf.subarray(SALT_LEN + IV_LEN + AUTH_TAG_LEN);
  const key = deriveKey(getPassword(), salt);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}

function rotateBackup(p: string): void {
  if (!fs.existsSync(p)) return;
  const bak = `${p}.bak`;
  try {
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
    fs.renameSync(p, bak);
  } catch (e) {
    console.log(`[keychain] WARNING: failed to rotate backup: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export class SecretStr {
  constructor(
    private readonly name: string,
    private readonly val: string
  ) {}

  use(): string {
    return this.val;
  }

  toString(): string {
    const n = this.val.length;
    let preview: string;
    if (n <= 4) preview = '***';
    else if (n <= 16) preview = `${this.val.slice(0, 3)}···${this.val.slice(-3)}`;
    else if (n <= 40) preview = `${this.val.slice(0, 6)}···${this.val.slice(-6)} len=${n}`;
    else preview = `${this.val.slice(0, 10)}···${this.val.slice(-6)} len=${n}`;
    return `SecretStr(${this.name}=${preview}) # .use() to get raw, do not print raw value`;
  }
}

class Keys {
  private d: Record<string, string> = {};
  private dirty = false;

  constructor() {
    if (fs.existsSync(keyPath)) {
      try {
        const buf = fs.readFileSync(keyPath);
        // First try modern AES-GCM format.
        this.d = JSON.parse(decrypt(buf));
      } catch {
        // Fallback to legacy XOR format and schedule migration.
        try {
          this.d = JSON.parse(legacyXor(fs.readFileSync(keyPath)).toString('utf-8'));
          this.dirty = true;
          console.log('[keychain] migrated from legacy XOR format to AES-GCM');
        } catch (e) {
          console.log(`[keychain] WARNING: failed to load ${keyPath}: ${e instanceof Error ? e.message : String(e)}`);
          console.log('[keychain] Starting with empty keychain. Old file kept as .bak');
          rotateBackup(keyPath);
        }
      }
    }
  }

  private save(): void {
    rotateBackup(keyPath);
    fs.writeFileSync(keyPath, encrypt(JSON.stringify(this.d)));
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(keyPath, 0o600);
      } catch (e) {
        console.log(`[keychain] WARNING: failed to set permissions: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.dirty = false;
  }

  get(k: string): SecretStr {
    if (!(k in this.d)) throw new Error(`No secret: ${k}`);
    return new SecretStr(k, this.d[k]);
  }

  set(k: string, v?: string, file?: string): void {
    let value = v;
    if (file) value = fs.readFileSync(file, 'utf-8').trim();
    if (value === undefined) throw new Error('keychain.set requires value or file');
    this.d[k] = value;
    this.save();
  }

  ls(): string[] {
    return Object.keys(this.d);
  }

  /** Persist any pending legacy-format migration. */
  flushMigration(): void {
    if (this.dirty) this.save();
  }
}

const keys = new Keys();
keys.flushMigration();

export function getKey(name: string): SecretStr {
  return keys.get(name);
}

export function setKey(name: string, value?: string, file?: string): void {
  keys.set(name, value, file);
}

export function listKeys(): string[] {
  return keys.ls();
}
