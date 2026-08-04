import { describe, expect, it } from 'vitest';
import {
  CLOUD_VAULT_FORMAT,
  CLOUD_VAULT_VERSION,
  DEFAULT_CLOUD_VAULT_SCOPE,
  type CloudVaultSnapshotV1,
} from './contracts';
import { decryptCloudVault, encryptCloudVault, sealCloudVaultSecret, unsealCloudVaultSecret } from './crypto';

function snapshot(): CloudVaultSnapshotV1 {
  return {
    format: CLOUD_VAULT_FORMAT,
    version: CLOUD_VAULT_VERSION,
    generatedAt: '2026-08-01T00:00:00.000Z',
    deviceId: 'device-a',
    scope: DEFAULT_CLOUD_VAULT_SCOPE,
    books: [],
    shelves: [],
    shelfMemberships: [],
    tombstones: [],
  };
}

describe('cloud vault encryption', () => {
  it('round-trips an encrypted snapshot without exposing its payload', async () => {
    const encrypted = await encryptCloudVault(snapshot(), 'correct horse battery staple');
    const text = new TextDecoder().decode(encrypted);

    expect(text).not.toContain('device-a');
    await expect(decryptCloudVault(encrypted, 'correct horse battery staple')).resolves.toEqual(snapshot());
  });

  it('rejects a wrong passphrase', async () => {
    const encrypted = await encryptCloudVault(snapshot(), 'correct horse battery staple');
    await expect(decryptCloudVault(encrypted, 'different secure passphrase')).rejects.toThrow(/incorrect|damaged/);
  });

  it('seals Dropbox credentials separately from the vault payload', async () => {
    const credential = { accessToken: 'access-secret', refreshToken: 'refresh-secret' };
    const sealed = await sealCloudVaultSecret(credential, 'correct horse battery staple');
    expect(sealed).not.toContain('refresh-secret');
    await expect(unsealCloudVaultSecret<typeof credential>(sealed, 'correct horse battery staple')).resolves.toEqual(
      credential,
    );
  });
});
