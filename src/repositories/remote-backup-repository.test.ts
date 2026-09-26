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
  it('uses the inspected server file for restore and discards abandoned inspections', async () => {
    const archive = new Blob(['zip']);
    const client = {
      inspectBackup: vi.fn(async () => ({ stagedId: 'stage-1' })),
      restoreInspectedBackup: vi.fn(async () => ({ restoredBooks: 1 })),
      restoreBackup: vi.fn(),
      discardBackupInspection: vi.fn(async () => undefined),
      createBackupDownload: vi.fn(async () => '/api/backups/download/ticket'),
    } as unknown as RemoteApiClient;
    const repository = new RemoteBackupRepository(client);
    expect(await repository.createDownload()).toBe('/api/backups/download/ticket');
    await repository.inspectBackup(archive);
    vi.mocked(client.restoreInspectedBackup).mockRejectedValueOnce(new Error('network interrupted'));
    await expect(repository.restoreBackup(archive, { defaultConflictResolution: 'skip' })).rejects.toThrow(
      'network interrupted',
    );
    const progress = vi.fn();
    await repository.restoreBackup(archive, { defaultConflictResolution: 'skip' }, progress);
    expect(client.restoreInspectedBackup).toHaveBeenLastCalledWith(
      'stage-1',
      { defaultConflictResolution: 'skip' },
      progress,
    );
    expect(client.restoreBackup).not.toHaveBeenCalled();
    await repository.inspectBackup(archive);
    await repository.discardInspection();
    expect(client.discardBackupInspection).toHaveBeenCalledWith('stage-1');
  });
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
