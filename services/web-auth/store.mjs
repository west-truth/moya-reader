import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export class AuthStore {
  constructor(path, encryptionKey) {
    this.key = Buffer.from(encryptionKey, 'base64');
    if (this.key.length !== 32) throw new Error('AUTH_ENCRYPTION_KEY must be 32 random bytes encoded as base64');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, subject TEXT NOT NULL, label TEXT NOT NULL,
        expires INTEGER NOT NULL, deadline INTEGER NOT NULL, refresh TEXT);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, origin TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, session TEXT NOT NULL, origin TEXT NOT NULL,
        verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL);
    `);
  }
  seal(value, owner) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(owner));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  unseal(value, owner) {
    const data = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(owner));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
  }
  prune(now) {
    this.db.prepare('DELETE FROM sessions WHERE expires <= ? OR deadline <= ?').run(now, now);
    this.db.prepare('DELETE FROM challenges WHERE expires <= ?').run(now);
    this.db.prepare('DELETE FROM flows WHERE expires <= ? OR session NOT IN (SELECT id FROM sessions)').run(now);
  }
  close() {
    this.db.close();
  }
}
