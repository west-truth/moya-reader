import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseNovelTextForSample } from '../domain/parser';
import { IndexedDbReaderRepository } from '../repositories/indexeddb-reader-repository';
import { deleteNovel, resetReaderDbForTests, saveImportedNovel } from '../storage/db';
import { getAllRecords } from '../storage/indexeddb-transaction';
import type { SyncTombstone } from '../storage/sync-event-store';
import { DEFAULT_CLOUD_VAULT_SCOPE } from './contracts';
import { IndexedDbCloudVaultArtifactRepository } from './indexeddb-artifact-repository';
import { mergeCloudVaultSnapshots } from './merge';

describe('IndexedDbCloudVaultArtifactRepository lifecycle merge', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('captures a body clock from the active content revision independently of metadata', async () => {
    const parsed = await parseNovelTextForSample('본문 시계', '1화\n\n본문입니다.');
    await saveImportedNovel(parsed);
    const artifacts = new IndexedDbCloudVaultArtifactRepository(new IndexedDbReaderRepository());

    const captured = await artifacts.capture({
      deviceId: 'device-content-owner',
      scope: DEFAULT_CLOUD_VAULT_SCOPE,
      capturedAt: '2099-08-29T00:00:00.000Z',
    });

    expect(captured.books[0]?.revisions.contentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(captured.books[0]?.revisions.contentAt).not.toBe(captured.generatedAt);
    expect(captured.books[0]?.revisions.contentDeviceId).toBe('device-content-owner');
  });

  it('restores a locally trashed book when a newer remote restore supersedes its tombstone', async () => {
    const parsed = await parseNovelTextForSample('복원 동기화', '1화\n\n본문입니다.');
    await saveImportedNovel(parsed);
    const reader = new IndexedDbReaderRepository();
    const artifacts = new IndexedDbCloudVaultArtifactRepository(reader);
    const initial = await artifacts.capture({
      deviceId: 'device-a',
      scope: DEFAULT_CLOUD_VAULT_SCOPE,
      capturedAt: '2026-08-29T00:00:00.000Z',
    });

    await deleteNovel(parsed.novel.id);
    const trashed = await artifacts.capture({
      deviceId: 'device-b',
      scope: DEFAULT_CLOUD_VAULT_SCOPE,
      capturedAt: '2026-08-29T00:01:00.000Z',
    });
    const remoteDeleted = mergeCloudVaultSnapshots(trashed, initial, '2026-08-29T00:01:00.000Z');
    expect(remoteDeleted.books).toEqual([]);

    const restoredAt = '2099-08-29T00:02:00.000Z';
    const restoredOnA = {
      ...initial,
      generatedAt: restoredAt,
      books: initial.books.map((book) => ({
        ...book,
        identity: { ...book.identity, updatedAt: restoredAt },
        revisions: { ...book.revisions, metadataAt: restoredAt },
      })),
    };
    const remoteRestored = mergeCloudVaultSnapshots(restoredOnA, remoteDeleted, restoredAt);
    expect(remoteRestored.books).toHaveLength(1);

    await artifacts.apply(remoteRestored);

    await expect(reader.getNovel(parsed.novel.id)).resolves.toMatchObject({
      id: parsed.novel.id,
      deletedAt: undefined,
      deletedByDeviceId: undefined,
      cloudVaultBookId: parsed.novel.id,
    });
    expect(
      (await getAllRecords<SyncTombstone>('sync_tombstones')).find((item) => item.entityType === 'book'),
    ).toBeUndefined();
  });
});
