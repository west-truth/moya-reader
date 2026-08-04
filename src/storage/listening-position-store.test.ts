import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { listSyncOutbox } from './sync-event-store';
import { openReaderDb, READER_DB_NAME, READER_DB_VERSION, resetReaderDbForTests } from './reader-database';
import { clearListeningPosition, getListeningPosition, saveListeningPosition } from './listening-position-store';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';

describe('listening position store', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('adds the document and listening stores in the current schema', async () => {
    const db = await openReaderDb();
    for (const storeName of Object.values(DOCUMENT_LISTENING_STORES)) {
      expect(db.objectStoreNames.contains(storeName)).toBe(true);
    }
  });

  it('upgrades a pre-v30 database to the current schema without rewriting existing reader rows', async () => {
    await resetReaderDbForTests();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(READER_DB_NAME, 29);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('novels', { keyPath: 'id' }).put({
          id: 'legacy_book',
          title: 'Legacy',
          updatedAt: '2026-07-31T00:00:00.000Z',
        });
        request.result.createObjectStore('settings', { keyPath: 'id' }).put({
          id: 'reader_settings',
          theme: 'sepia',
          fontSize: 19,
        });
        const positions = request.result.createObjectStore('reading_positions', { keyPath: 'id' });
        positions.createIndex('novelId', 'novelId', { unique: true });
        positions.createIndex('chapterId', 'chapterId');
        positions.createIndex('updatedAt', 'updatedAt');
        positions.put({
          id: 'reading_position_legacy_book',
          novelId: 'legacy_book',
          chapterId: 'legacy_chapter',
          paragraphIndex: 12,
          chapterProgress: 0.42,
          updatedAt: '2026-07-31T00:00:00.000Z',
        });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    const db = await openReaderDb();
    expect(db.version).toBe(READER_DB_VERSION);
    for (const storeName of Object.values(DOCUMENT_LISTENING_STORES)) {
      expect(db.objectStoreNames.contains(storeName)).toBe(true);
    }
    expect(
      db
        .transaction(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest)
        .objectStore(DOCUMENT_LISTENING_STORES.ttsOfflineCacheManifest)
        .indexNames.contains('bookId_renderSpecHash_storage'),
    ).toBe(true);

    const transaction = db.transaction(['novels', 'settings', 'reading_positions']);
    const [novel, settings, readingPosition] = await Promise.all([
      new Promise((resolve, reject) => {
        const request = transaction.objectStore('novels').get('legacy_book');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
      new Promise((resolve, reject) => {
        const request = transaction.objectStore('settings').get('reader_settings');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
      new Promise((resolve, reject) => {
        const request = transaction.objectStore('reading_positions').get('reading_position_legacy_book');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
    ]);
    expect(novel).toMatchObject({ id: 'legacy_book', title: 'Legacy' });
    expect(settings).toEqual({ id: 'reader_settings', theme: 'sepia', fontSize: 19 });
    expect(readingPosition).toMatchObject({
      id: 'reading_position_legacy_book',
      novelId: 'legacy_book',
      chapterProgress: 0.42,
    });
  });

  it('persists an exact source range without changing the reading position', async () => {
    const saved = await saveListeningPosition({
      bookId: 'book_1',
      chapterId: 'chapter_1',
      contentRevisionId: 'revision_1',
      queueItemFingerprint: 'queue_1',
      settingsFingerprint: 'settings_1',
      updatedAt: '2026-08-01T00:00:00.000Z',
      anchor: {
        kind: 'reflowable_text',
        paragraphId: 'paragraph_1',
        startOffset: 7,
        endOffset: 18,
        reader: {
          bookId: 'book_1',
          contentRevisionId: 'revision_1',
          sectionId: 'chapter_1',
          blockId: 'paragraph_1',
          blockIndex: 3,
          offset: 7,
        },
      },
    });

    expect(await getListeningPosition('book_1')).toEqual(saved);
    const db = await openReaderDb();
    const readingPosition = await new Promise((resolve, reject) => {
      const request = db.transaction('reading_positions').objectStore('reading_positions').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(readingPosition).toEqual([]);
    expect((await listSyncOutbox())[0]?.event.type).toBe('listening_position_updated');
  });

  it('creates a tombstoned delete event when cleared', async () => {
    await saveListeningPosition({
      bookId: 'book_1',
      chapterId: 'chapter_1',
      contentRevisionId: 'revision_1',
      queueItemFingerprint: 'queue_1',
      settingsFingerprint: 'settings_1',
      anchor: { kind: 'fixed_page', bookId: 'book_1', pageIndex: 2, pageHash: 'page_hash_2' },
    });
    await clearListeningPosition('book_1');
    expect(await getListeningPosition('book_1')).toBeUndefined();
    expect((await listSyncOutbox()).map((item) => item.event.type)).toContain('listening_position_deleted');
  });
});
