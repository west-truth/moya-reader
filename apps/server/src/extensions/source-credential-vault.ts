import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SourceAuthenticationInput } from '@noveldesk/extension-contracts/package';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const maximumVaultBytes = (scope: string) => {
  const kind = (JSON.parse(scope) as string[])[1];
  return kind === 'browser' || kind?.startsWith('browser:') ? 2 * 1024 * 1024 : 64 * 1024;
};

export interface SourceCredentialVault {
  read(scope: string): SourceAuthenticationInput | undefined;
  write(scope: string, value: SourceAuthenticationInput | undefined): void;
  retain?(packageId: string, epoch: string | undefined): void;
}

/** Separate from settings/backups. The host supplies the owner directory and a protected 256-bit key. */
export class EncryptedSourceCredentialVault implements SourceCredentialVault {
  constructor(
    private readonly directory: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('source_vault_unavailable');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private file(scope: string) {
    const [packageId, , epoch] = JSON.parse(scope) as string[];
    return path.join(this.directory, `${hash(packageId)}-${hash(epoch)}-${hash(scope)}.credential`);
  }
  retain(packageId: string, epoch: string | undefined) {
    const prefix = hash(packageId) + '-';
    const keep = epoch ? `${prefix}${hash(epoch)}-` : undefined;
    for (const name of readdirSync(this.directory))
      if (name.startsWith(prefix) && name.endsWith('.credential') && (!keep || !name.startsWith(keep)))
        rmSync(path.join(this.directory, name), { force: true });
  }
  read(scope: string): SourceAuthenticationInput | undefined {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.file(scope));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('source_vault_unavailable', { cause: error });
    }
    try {
      if (bytes.length < 29 || bytes.length > maximumVaultBytes(scope) || bytes[0] !== 1) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(1, 13));
      cipher.setAAD(Buffer.from(scope));
      cipher.setAuthTag(bytes.subarray(13, 29));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]).toString('utf8'));
    } catch {
      throw new Error('source_vault_unavailable');
    }
  }
  write(scope: string, value: SourceAuthenticationInput | undefined) {
    const file = this.file(scope);
    if (!value) {
      rmSync(file, { force: true });
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]), {
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
