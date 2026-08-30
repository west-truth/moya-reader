import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, Novel } from '../domain/types';
import type { BookContentRevisionRecord } from './content-revisions';
import { revisionScopedStorageId } from './content-revisions';
import { CONTENT_REVISION_STORES } from './content-revision-migration';
import type { RevisionChapterRow } from './content-revision-store';
import { EXACT_SECTION_READ_INDEXES } from './exact-section-read-schema';
import { clearExactDocumentSectionReadState, markExactDocumentSectionReadState } from './exact-section-read-state';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb, READER_DB_NAME, READER_DB_VERSION, resetReaderDbForTests } from './reader-database';

const NOW = '2026-08-31T00:00:00.000Z';
const READ_AT = '2026-08-31T00:10:00.000Z';

function novel(id = 'exact-read-book'): Novel {
  return {
    id,
    activeContentRevisionId: 'revision-active',
    title: 'Exact read test',
    sourceFileName: 'exact.cbz',
    rawText: '',
    normalizedText: '',
    rawTextHash: 'raw',
    normalizedTextHash: 'normalized',
    createdAt: NOW,
    updatedAt: NOW,
    totalChapters: 1_001,
    totalCharacters: 1_001,
    totalParagraphs: 1_001,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
}

function chapter(bookId: string, index: number, sectionId: string, readAt?: string): Chapter {
  return {
    id: `${bookId}:chapter:${index}`,
    novelId: bookId,
    index,
    title: `${index}화`,
    normalizedText: '',
    textHash: `hash-${index}`,
    rawStartOffset: 0,
    rawEndOffset: 1,
    characterCount: 1,
    paragraphCount: 1,
    documentSectionId: sectionId,
    documentSectionReadAt: readAt,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function revisionChapter(contentRevisionId: string, value: Chapter): RevisionChapterRow {
  return {
    ...value,
    storageId: revisionScopedStorageId(contentRevisionId, value.id),
    contentRevisionId,
  };
}

function activeRevision(bookId: string): BookContentRevisionRecord {
  return {
    id: 'revision-active',
    novelId: bookId,
    status: 'active',
    source: 'local_import',
    baseNovelPresent: false,
    expected: { chapterCount: 1_001, paragraphCount: 1_001 },
    createdAt: NOW,
    activatedAt: NOW,
  };
}

async function storedRows(db: IDBDatabase, book: Novel) {
  const tx = db.transaction([CONTENT_REVISION_STORES.chapters, 'chapters'], 'readonly');
  const revisionTarget = await requestToPromise<RevisionChapterRow | undefined>(
    tx
      .objectStore(CONTENT_REVISION_STORES.chapters)
      .get(revisionScopedStorageId('revision-active', `${book.id}:chapter:1`)),
  );
  const staleTarget = await requestToPromise<RevisionChapterRow | undefined>(
    tx
      .objectStore(CONTENT_REVISION_STORES.chapters)
      .get(revisionScopedStorageId('revision-stale', `${book.id}:chapter:1`)),
  );
  const legacyTarget = await requestToPromise<Chapter | undefined>(
    tx.objectStore('chapters').get(`${book.id}:chapter:1`),
  );
  await transactionDone(tx);
  return { revisionTarget, staleTarget, legacyTarget };
}

describe('exact fixed-document section read state', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('uses section/read-marker indexes instead of loading every chapter on each save or reset', async () => {
    const db = await openReaderDb();
    const book = novel();
    const seed = db.transaction(
      [CONTENT_REVISION_STORES.revisions, CONTENT_REVISION_STORES.chapters, 'chapters'],
      'readwrite',
    );
    seed.objectStore(CONTENT_REVISION_STORES.revisions).put(activeRevision(book.id));
    const revisionStore = seed.objectStore(CONTENT_REVISION_STORES.chapters);
    const legacyStore = seed.objectStore('chapters');
    for (let index = 1; index <= book.totalChapters; index += 1) {
      const value = chapter(book.id, index, index === 1 ? 'target-section' : `section-${index}`);
      revisionStore.put(revisionChapter('revision-active', value));
      legacyStore.put(value);
    }
    revisionStore.put(
      revisionChapter('revision-stale', chapter(book.id, 1, 'target-section', '2026-08-30T00:00:00.000Z')),
    );
    await transactionDone(seed);

    const markGetAll = vi.spyOn(IDBIndex.prototype, 'getAll');
    const mark = db.transaction(
      [CONTENT_REVISION_STORES.revisions, CONTENT_REVISION_STORES.chapters, 'chapters'],
      'readwrite',
    );
    await markExactDocumentSectionReadState(mark, book, 'target-section', READ_AT);
    await transactionDone(mark);
    expect(markGetAll.mock.contexts.map(indexCall)).toEqual([
      `${CONTENT_REVISION_STORES.chapters}:${EXACT_SECTION_READ_INDEXES.revisionSection}`,
      `chapters:${EXACT_SECTION_READ_INDEXES.legacySection}`,
    ]);
    markGetAll.mockRestore();

    expect(await storedRows(db, book)).toMatchObject({
      revisionTarget: { documentSectionReadAt: READ_AT },
      staleTarget: { documentSectionReadAt: '2026-08-30T00:00:00.000Z' },
      legacyTarget: { documentSectionReadAt: READ_AT },
    });

    const clearGetAll = vi.spyOn(IDBIndex.prototype, 'getAll');
    const clear = db.transaction(
      [CONTENT_REVISION_STORES.revisions, CONTENT_REVISION_STORES.chapters, 'chapters'],
      'readwrite',
    );
    await clearExactDocumentSectionReadState(clear, book);
    await transactionDone(clear);
    expect(clearGetAll.mock.contexts.map(indexCall)).toEqual([
      `${CONTENT_REVISION_STORES.chapters}:${EXACT_SECTION_READ_INDEXES.revisionReadAt}`,
      `chapters:${EXACT_SECTION_READ_INDEXES.legacyReadAt}`,
    ]);
    clearGetAll.mockRestore();

    expect(await storedRows(db, book)).toMatchObject({
      revisionTarget: { documentSectionReadAt: undefined },
      staleTarget: { documentSectionReadAt: '2026-08-30T00:00:00.000Z' },
      legacyTarget: { documentSectionReadAt: undefined },
    });
  });

  it('adds the bounded lookup indexes without rewriting existing version-38 chapter rows', async () => {
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(READER_DB_NAME, 38);
      request.onupgradeneeded = () => {
        const legacy = request.result.createObjectStore('chapters', { keyPath: 'id' });
        legacy.createIndex('novelId', 'novelId');
        const revision = request.result.createObjectStore(CONTENT_REVISION_STORES.chapters, {
          keyPath: 'storageId',
        });
        revision.createIndex('contentRevisionId', 'contentRevisionId');
        revision.createIndex('novelId', 'novelId');
        revision.createIndex('domainId', 'id');
        revision.createIndex('contentRevisionId_domainId', ['contentRevisionId', 'id'], { unique: true });
        revision.createIndex('contentRevisionId_index', ['contentRevisionId', 'index'], { unique: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const existing = chapter('migration-book', 1, 'section-1', READ_AT);
    const seed = oldDb.transaction(['chapters', CONTENT_REVISION_STORES.chapters], 'readwrite');
    seed.objectStore('chapters').put(existing);
    seed.objectStore(CONTENT_REVISION_STORES.chapters).put(revisionChapter('revision-old', existing));
    await transactionDone(seed);
    oldDb.close();

    const db = await openReaderDb();
    expect(db.version).toBe(READER_DB_VERSION);
    const tx = db.transaction(['chapters', CONTENT_REVISION_STORES.chapters], 'readonly');
    const legacy = tx.objectStore('chapters');
    const revision = tx.objectStore(CONTENT_REVISION_STORES.chapters);
    expect(Array.from(legacy.indexNames)).toEqual(
      expect.arrayContaining([EXACT_SECTION_READ_INDEXES.legacySection, EXACT_SECTION_READ_INDEXES.legacyReadAt]),
    );
    expect(Array.from(revision.indexNames)).toEqual(
      expect.arrayContaining([EXACT_SECTION_READ_INDEXES.revisionSection, EXACT_SECTION_READ_INDEXES.revisionReadAt]),
    );
    expect(await requestToPromise<Chapter | undefined>(legacy.get(existing.id))).toMatchObject({
      documentSectionReadAt: READ_AT,
    });
    expect(
      await requestToPromise<RevisionChapterRow | undefined>(
        revision.get(revisionScopedStorageId('revision-old', existing.id)),
      ),
    ).toMatchObject({ documentSectionReadAt: READ_AT });
    await transactionDone(tx);
  });
});

function indexCall(context: unknown): string {
  const index = context as IDBIndex;
  return `${index.objectStore.name}:${index.name}`;
}
