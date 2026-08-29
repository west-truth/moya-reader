import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Novel } from '../domain/types';
import { stageOriginalSourceAsset } from './book-asset-store';
import { BOOK_ASSET_STORES, type StoredBookAsset } from './book-asset-schema';
import {
  cleanupStaleImportArtifacts,
  createStagingContentRevision,
  saveStagedContentChapters,
} from './content-revision-store';
import { CONTENT_REVISION_STORES } from './content-revision-migration';
import type { BookContentRevisionRecord } from './content-revisions';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb, resetReaderDbForTests } from './reader-database';

const OLD = '2026-08-20T00:00:00.000Z';

function novel(id: string): Novel {
  return {
    id,
    title: id,
    sourceFileName: `${id}.txt`,
    sourceEncoding: 'utf-8',
    rawText: '',
    normalizedText: '',
    rawTextHash: `${id}-raw`,
    normalizedTextHash: `${id}-normalized`,
    createdAt: OLD,
    updatedAt: OLD,
    totalChapters: 1,
    totalCharacters: 4,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
}

beforeEach(() => resetReaderDbForTests());
afterEach(() => resetReaderDbForTests());

describe('stale import artifact cleanup', () => {
  it('removes only age-gated staging revisions, rows and their staged source blobs', async () => {
    const db = await openReaderDb();
    const oldNovel = novel('old-staging');
    const oldRevision = await createStagingContentRevision(db, {
      novel: oldNovel,
      source: 'local_import',
      expected: { chapterCount: 1, pageCount: 0, paragraphCount: 0 },
    });
    await saveStagedContentChapters(
      db,
      oldRevision.id,
      [
        {
          id: 'old-staging-chapter',
          novelId: oldNovel.id,
          index: 1,
          title: 'old',
          normalizedText: '',
          textHash: 'old-hash',
          rawStartOffset: 0,
          rawEndOffset: 0,
          characterCount: 0,
          paragraphCount: 0,
          createdAt: OLD,
          updatedAt: OLD,
        },
      ],
      { batchSize: 1, throwIfCancelled: () => undefined },
    );
    const oldHash = `sha256:${'01'.repeat(32)}`;
    const oldSource = await stageOriginalSourceAsset({
      bookId: oldNovel.id,
      contentRevisionId: oldRevision.id,
      fileName: 'old.txt',
      contentType: 'text/plain',
      contentHash: oldHash,
      blob: new Blob(['old']),
    });

    const recentNovel = novel('recent-staging');
    const recentRevision = await createStagingContentRevision(db, {
      novel: recentNovel,
      source: 'local_import',
      expected: { chapterCount: 0, pageCount: 0, paragraphCount: 0 },
    });
    const recentSource = await stageOriginalSourceAsset({
      bookId: recentNovel.id,
      contentRevisionId: recentRevision.id,
      fileName: 'recent.txt',
      contentType: 'text/plain',
      contentHash: `sha256:${'02'.repeat(32)}`,
      blob: new Blob(['recent']),
    });

    const ageTx = db.transaction([CONTENT_REVISION_STORES.revisions, BOOK_ASSET_STORES.assets], 'readwrite');
    const revisionStore = ageTx.objectStore(CONTENT_REVISION_STORES.revisions);
    const assetStore = ageTx.objectStore(BOOK_ASSET_STORES.assets);
    const storedRevision = await requestToPromise<BookContentRevisionRecord>(revisionStore.get(oldRevision.id));
    const storedAsset = await requestToPromise<StoredBookAsset>(assetStore.get(oldSource.id));
    revisionStore.put({ ...storedRevision, createdAt: OLD });
    assetStore.put({ ...storedAsset, createdAt: OLD });
    await transactionDone(ageTx);

    await expect(cleanupStaleImportArtifacts(db, { now: Date.now(), olderThanMs: 60_000, limit: 4 })).resolves.toEqual({
      revisionsRemoved: 1,
      orphanedAssetsRemoved: 0,
    });

    const readTx = db.transaction(
      [CONTENT_REVISION_STORES.revisions, CONTENT_REVISION_STORES.chapters, ...Object.values(BOOK_ASSET_STORES)],
      'readonly',
    );
    await expect(
      requestToPromise(readTx.objectStore(CONTENT_REVISION_STORES.revisions).get(oldRevision.id)),
    ).resolves.toBeUndefined();
    await expect(
      requestToPromise(
        readTx.objectStore(CONTENT_REVISION_STORES.chapters).index('contentRevisionId').count(oldRevision.id),
      ),
    ).resolves.toBe(0);
    await expect(
      requestToPromise(readTx.objectStore(BOOK_ASSET_STORES.assets).get(oldSource.id)),
    ).resolves.toBeUndefined();
    await expect(
      requestToPromise(readTx.objectStore(BOOK_ASSET_STORES.blobs).get(`asset_blob_${oldHash}`)),
    ).resolves.toBeUndefined();
    await expect(
      requestToPromise(readTx.objectStore(CONTENT_REVISION_STORES.revisions).get(recentRevision.id)),
    ).resolves.toMatchObject({ status: 'staging' });
    await expect(
      requestToPromise(readTx.objectStore(BOOK_ASSET_STORES.assets).get(recentSource.id)),
    ).resolves.toMatchObject({ status: 'staged' });
    await transactionDone(readTx);
  });

  it('removes an old staged asset whose revision no longer exists', async () => {
    const db = await openReaderDb();
    const hash = `sha256:${'03'.repeat(32)}`;
    const orphan = await stageOriginalSourceAsset({
      bookId: 'orphan-book',
      contentRevisionId: 'missing-revision',
      fileName: 'orphan.txt',
      contentType: 'text/plain',
      contentHash: hash,
      blob: new Blob(['orphan']),
    });
    const ageTx = db.transaction(BOOK_ASSET_STORES.assets, 'readwrite');
    const store = ageTx.objectStore(BOOK_ASSET_STORES.assets);
    const stored = await requestToPromise<StoredBookAsset>(store.get(orphan.id));
    store.put({ ...stored, createdAt: OLD });
    await transactionDone(ageTx);

    await expect(cleanupStaleImportArtifacts(db, { now: Date.now(), olderThanMs: 60_000, limit: 4 })).resolves.toEqual({
      revisionsRemoved: 0,
      orphanedAssetsRemoved: 1,
    });

    const readTx = db.transaction(Object.values(BOOK_ASSET_STORES), 'readonly');
    await expect(
      requestToPromise(readTx.objectStore(BOOK_ASSET_STORES.assets).get(orphan.id)),
    ).resolves.toBeUndefined();
    await expect(
      requestToPromise(readTx.objectStore(BOOK_ASSET_STORES.blobs).get(`asset_blob_${hash}`)),
    ).resolves.toBeUndefined();
    await transactionDone(readTx);
  });
});
