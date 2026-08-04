import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TTSOfflineCacheManifestEntry } from '../domain/types';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import { IndexedDbHostedTTSOfflineCache, type HostedTTSOfflineBlobRecord } from './hosted-tts-offline-cache';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb, resetReaderDbForTests } from './reader-database';

function audio(value: string): Blob {
  return new Blob([value], { type: 'audio/mpeg' });
}

describe('IndexedDbHostedTTSOfflineCache', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds the render lookup index when upgrading an existing v30 cache store', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('noveldesk-reader', 30);
      request.onupgradeneeded = () => {
        const manifest = request.result.createObjectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, {
          keyPath: 'id',
        });
        manifest.createIndex('bookId', 'bookId');
        manifest.createIndex('cacheKey', 'cacheKey', { unique: true });
        manifest.createIndex('lastAccessedAt', 'lastAccessedAt');
        const blobs = request.result.createObjectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs, {
          keyPath: 'id',
        });
        blobs.createIndex('bookId', 'bookId');
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    const db = await openReaderDb();
    const tx = db.transaction(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, 'readonly');
    expect(
      tx
        .objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest)
        .indexNames.contains('bookId_renderSpecHash_storage'),
    ).toBe(true);
  });

  it('stores and resolves audio by its render specification hash', async () => {
    const cache = new IndexedDbHostedTTSOfflineCache();
    await cache.put({
      bookId: 'book_1',
      chapterId: 'chapter_1',
      cacheKey: 'cache_1',
      renderSpecHash: 'render_1',
      contentRevisionId: 'revision_1',
      blob: audio('voice data'),
    });

    const stored = await cache.getByRenderSpecHash('book_1', 'render_1');
    expect(stored?.cacheKey).toBe('cache_1');
    expect(await stored?.blob.text()).toBe('voice data');
    await expect(cache.evidence('book_1', ['render_1', 'missing'])).resolves.toEqual([
      {
        renderSpecHash: 'render_1',
        cacheKey: 'cache_1',
        byteSize: audio('voice data').size,
        storage: 'indexeddb',
      },
    ]);
  });

  it('reports cache and origin quota status and requests persistence only through an explicit call', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', {
      storage: {
        estimate: async () => ({ usage: 20, quota: 100 }),
        persisted: async () => false,
        persist,
      },
    });
    const cache = new IndexedDbHostedTTSOfflineCache();
    await cache.put({
      bookId: 'book_1',
      chapterId: 'chapter_1',
      cacheKey: 'cache_1',
      renderSpecHash: 'render_1',
      contentRevisionId: 'revision_1',
      blob: audio('voice data'),
    });

    await expect(cache.status('book_1')).resolves.toMatchObject({
      itemCount: 1,
      byteSize: audio('voice data').size,
      originUsage: 20,
      originQuota: 100,
      persisted: false,
      persistenceSupported: true,
    });
    expect(persist).not.toHaveBeenCalled();
    await expect(cache.requestPersistence()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('deletes corrupt binary evidence instead of returning it', async () => {
    const cache = new IndexedDbHostedTTSOfflineCache();
    await cache.put({
      bookId: 'book_1',
      chapterId: 'chapter_1',
      cacheKey: 'cache_1',
      renderSpecHash: 'render_1',
      contentRevisionId: 'revision_1',
      blob: audio('voice data'),
    });
    const db = await openReaderDb();
    const tx = db.transaction(DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs, 'readwrite');
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs);
    const record = await requestToPromise<HostedTTSOfflineBlobRecord>(store.get('cache_1'));
    store.put({ ...record, audioHash: 'sha256:forged' });
    await transactionDone(tx);

    await expect(cache.getByCacheKey('book_1', 'cache_1')).resolves.toBeUndefined();
    const verify = db.transaction(
      [DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs],
      'readonly',
    );
    expect(
      await requestToPromise(verify.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest).get('cache_1')),
    ).toBeUndefined();
    expect(
      await requestToPromise(verify.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheBlobs).get('cache_1')),
    ).toBeUndefined();
  });

  it('prunes least-recently-used unpinned audio while preserving pinned entries', async () => {
    const cache = new IndexedDbHostedTTSOfflineCache();
    for (const suffix of ['old', 'pinned', 'new']) {
      await cache.put({
        bookId: 'book_1',
        chapterId: 'chapter_1',
        cacheKey: `cache_${suffix}`,
        renderSpecHash: `render_${suffix}`,
        contentRevisionId: 'revision_1',
        blob: audio('1234'),
      });
    }
    const db = await openReaderDb();
    const tx = db.transaction(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, 'readwrite');
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest);
    const update = async (key: string, lastAccessedAt: string, pinnedByJobIds: string[] = []) => {
      const entry = await requestToPromise<TTSOfflineCacheManifestEntry>(store.get(key));
      store.put({ ...entry, lastAccessedAt, pinnedByJobIds });
    };
    await update('cache_old', '2026-01-01T00:00:00.000Z');
    await update('cache_pinned', '2026-01-02T00:00:00.000Z', ['job_1']);
    await update('cache_new', '2026-01-03T00:00:00.000Z');
    await transactionDone(tx);

    await expect(cache.prune(10, 8)).resolves.toBe(1);
    await expect(cache.getByCacheKey('book_1', 'cache_old')).resolves.toBeUndefined();
    await expect(cache.getByCacheKey('book_1', 'cache_pinned')).resolves.toBeDefined();
    await expect(cache.getByCacheKey('book_1', 'cache_new')).resolves.toBeDefined();
  });

  it('reports and removes only unpinned entries from older content revisions', async () => {
    const cache = new IndexedDbHostedTTSOfflineCache();
    for (const [cacheKey, contentRevisionId] of [
      ['cache_current', 'revision_2'],
      ['cache_stale', 'revision_1'],
      ['cache_stale_pinned', 'revision_1'],
    ] as const) {
      await cache.put({
        bookId: 'book_1',
        chapterId: 'chapter_1',
        cacheKey,
        renderSpecHash: cacheKey.replace('cache', 'render'),
        contentRevisionId,
        blob: audio('1234'),
      });
    }
    const db = await openReaderDb();
    const pin = db.transaction(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest, 'readwrite');
    const store = pin.objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest);
    const pinned = await requestToPromise<TTSOfflineCacheManifestEntry>(store.get('cache_stale_pinned'));
    store.put({ ...pinned, pinnedByJobIds: ['job_manual'] });
    await transactionDone(pin);

    await expect(cache.status('book_1', 'revision_2')).resolves.toMatchObject({
      itemCount: 3,
      byteSize: 12,
      staleItemCount: 1,
      staleByteSize: 4,
      protectedStaleItemCount: 1,
    });
    await expect(cache.removeStaleForBook('book_1', 'revision_2')).resolves.toEqual({
      removedItems: 1,
      removedBytes: 4,
      protectedItems: 1,
    });
    await expect(cache.getByCacheKey('book_1', 'cache_current')).resolves.toBeDefined();
    await expect(cache.getByCacheKey('book_1', 'cache_stale')).resolves.toBeUndefined();
    await expect(cache.getByCacheKey('book_1', 'cache_stale_pinned')).resolves.toBeDefined();
  });
});
