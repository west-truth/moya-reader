import { describe, expect, it, vi } from 'vitest';
import { GoogleDriveFixture } from './test-support/google-drive-fixture';
import { GoogleDriveCloudVaultProvider } from './google-drive-provider';
import { CloudVaultWriteConflictError } from './contracts';

function fixture() {
  const drive = new GoogleDriveFixture();
  const tokens = { getAccessToken: async () => 'synthetic', invalidate: vi.fn() };
  return { drive, tokens, provider: new GoogleDriveCloudVaultProvider(tokens, drive.fetch) };
}
const data = new TextEncoder().encode('{"synthetic":true}');
const key = `content/v1/sha256/${'a'.repeat(64)}`;

describe('Google Drive vault storage boundary', () => {
  it('discovers an existing vault on a second device and conditionally updates it', async () => {
    const { drive, tokens, provider } = fixture();
    expect(await provider.read()).toBeUndefined();
    const first = await provider.write(data);
    const other = new GoogleDriveCloudVaultProvider(tokens, drive.fetch);
    expect(await other.read()).toEqual({ bytes: data, revision: first.revision });
    const next = await other.write(new TextEncoder().encode('{"new":true}'), first.revision);
    expect(next.revision).not.toBe(first.revision);
    expect(
      drive.requests
        .find((request) => request.url.includes('/v2/') && request.method === 'PUT')
        ?.headers.get('If-Match'),
    ).toBe('"1"');
    await expect(provider.write(data, first.revision)).rejects.toBeInstanceOf(CloudVaultWriteConflictError);
  });
  it('fails closed on a concurrent write or missing ETag without an unconditional fallback', async () => {
    const { drive, provider } = fixture();
    const first = await provider.write(data);
    drive.rejectWrite = true;
    await expect(provider.write(data, first.revision)).rejects.toBeInstanceOf(CloudVaultWriteConflictError);
    drive.rejectWrite = false;
    drive.omitEtag = true;
    await expect(provider.write(data, first.revision)).rejects.toThrow('동시 수정 보호');
    expect(drive.requests.filter((request) => request.url.includes('/v2/') && request.method === 'PUT')).toHaveLength(
      1,
    );
  });
  it('preserves duplicates and stops on ambiguous/incomplete discovery', async () => {
    const { drive, provider } = fixture();
    await provider.write(data);
    const root = [...drive.files.values()].find((file) => file.appProperties.moyaObject === 'root')!;
    drive.files.set('duplicate', { ...root, id: 'duplicate' });
    await expect(provider.read()).rejects.toThrow('중복');
    expect(drive.files.size).toBe(3);
    drive.files.delete('duplicate');
    drive.incomplete = true;
    await expect(provider.read()).rejects.toThrow('불완전');
  });
  it('uploads large immutable objects in chunks and reuses them without another upload', async () => {
    const { drive, provider } = fixture();
    const blob = new Blob([new Uint8Array(9 * 1024 * 1024)]);
    expect((await provider.putObject(key, blob, { byteLength: blob.size })).created).toBe(true);
    expect(drive.requests.filter((request) => request.method === 'PUT')).toHaveLength(2);
    expect((await provider.putObject(key, blob, { byteLength: blob.size })).created).toBe(false);
    expect((await provider.getObject(key))?.blob.size).toBe(blob.size);
    await expect(provider.putObject(key, new Blob(['short']), { byteLength: 5 })).rejects.toThrow('크기');
  });
  it('never sends credentials to an untrusted resumable upload URL', async () => {
    const { drive, provider } = fixture();
    drive.uploadLocation = 'https://attacker.example/upload';
    await expect(provider.write(data)).rejects.toThrow('주소');
    expect(drive.requests.some((request) => request.url.includes('attacker'))).toBe(false);
  });
  it('invalidates expired grants and rejects malformed object paths before networking', async () => {
    const { drive, tokens, provider } = fixture();
    await expect(provider.getObject('../other')).rejects.toThrow('key');
    expect(drive.requests).toHaveLength(0);
    drive.rejectToken = true;
    await expect(provider.read()).rejects.toThrow('만료');
    expect(tokens.invalidate).toHaveBeenCalledOnce();
  });
});
