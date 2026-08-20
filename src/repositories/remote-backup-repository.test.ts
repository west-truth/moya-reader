import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import type { BackupManifestV1 } from './backup-repository';
import { RemoteBackupRepository } from './remote-backup-repository';

async function exportedArchive(manifest: BackupManifestV1): Promise<Blob> {
  const writer = new BlobWriter('application/zip');
  const zip = new ZipWriter(writer);
  await zip.add('manifest.json', new TextReader(JSON.stringify({ ...manifest, backend: 'hosted' })));
  return zip.close();
}

describe('RemoteBackupRepository', () => {
  it('reads the exported manifest locally without uploading the ZIP for inspection', async () => {
    const manifest: BackupManifestV1 = {
      format: 'noveldesk-backup',
      version: 1,
      exportedAt: '2026-08-20T00:00:00.000Z',
      appVersion: '0.1.0',
      books: [{ id: 'book_1', format: 'epub', title: 'Book' }],
      entries: [],
      assetBlobs: [],
    };
    const blob = await exportedArchive(manifest);
    const client = {
      exportBackup: vi.fn(async () => ({ blob, headers: new Headers() })),
      inspectBackup: vi.fn(),
    } as unknown as RemoteApiClient;

    const result = await new RemoteBackupRepository(client).exportBackup();

    expect(result).toEqual({ blob, manifest: { ...manifest, backend: 'hosted' } });
    expect(client.exportBackup).toHaveBeenCalledOnce();
    expect(client.inspectBackup).not.toHaveBeenCalled();
  });

  it('rejects an export response without the archive manifest contract', async () => {
    const writer = new BlobWriter('application/zip');
    const zip = new ZipWriter(writer);
    await zip.add('readme.txt', new TextReader('not a backup'));
    const blob = await zip.close();
    const client = {
      exportBackup: vi.fn(async () => ({ blob, headers: new Headers() })),
      inspectBackup: vi.fn(),
    } as unknown as RemoteApiClient;

    await expect(new RemoteBackupRepository(client).exportBackup()).rejects.toThrow('manifest is missing');
    expect(client.inspectBackup).not.toHaveBeenCalled();
  });
});
