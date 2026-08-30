import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedNovel } from '../domain/types';
import type { SyncOutboxItem, SyncState } from '../sync/types';
import {
  addNovelReadingTime,
  getChapters,
  getNovel,
  getParagraph,
  getParagraphPages,
  getSyncState,
  listSyncOutbox,
  openReaderDb,
  PARAGRAPHS_PER_PAGE,
  resetReaderDbForTests,
  saveImportedNovel,
  saveBookmark,
  saveHighlight,
  saveNote,
  patchNovelMetadata,
  searchParagraphs,
  saveReadingPosition,
} from '../storage/db';
import type { BookContentRevisionRecord } from '../storage/content-revisions';
import { activateStagedContentRevision, createStagingContentRevision } from '../storage/content-revision-store';
import { READER_DB_VERSION } from '../storage/reader-database';
import { IndexedDbBookAssetRepository } from '../repositories/indexeddb-book-asset-repository';
import { IndexedDbLibraryCatalogRepository } from '../repositories/indexeddb-library-catalog-repository';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function getContentRevisions(novelId: string): Promise<BookContentRevisionRecord[]> {
  const db = await openReaderDb();
  const tx = db.transaction('book_content_revisions', 'readonly');
  return requestToPromise<BookContentRevisionRecord[]>(
    tx.objectStore('book_content_revisions').index('novelId').getAll(novelId),
  );
}

function parsedNovel(id: string, title: string, paragraphCount = 2): ParsedNovel {
  const now = '2026-07-10T00:00:00.000Z';
  let cursor = 0;
  const paragraphs = Array.from({ length: paragraphCount }, (_, offset) => {
    const index = offset + 1;
    const text = `${title} paragraph ${index}`;
    const startOffsetInChapter = cursor;
    cursor += text.length + 2;
    return {
      id: `${id}:paragraph:${index}`,
      novelId: id,
      chapterId: `${id}:chapter:1`,
      index,
      text,
      startOffsetInChapter,
      endOffsetInChapter: startOffsetInChapter + text.length,
      textHash: `${id}:paragraph-hash:${index}`,
    };
  });
  const normalizedText = paragraphs.map((paragraph) => paragraph.text).join('\n\n');
  return {
    novel: {
      id,
      title,
      sourceFileName: `${id}.txt`,
      sourceEncoding: 'utf-8',
      rawText: normalizedText,
      normalizedText,
      rawTextHash: `${id}:raw`,
      normalizedTextHash: `${id}:normalized:${title}`,
      createdAt: now,
      updatedAt: now,
      totalChapters: 1,
      totalCharacters: paragraphs.reduce((total, paragraph) => total + paragraph.text.length, 0),
      totalParagraphs: paragraphs.length,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters: [
      {
        id: `${id}:chapter:1`,
        novelId: id,
        index: 1,
        title: 'Chapter 1',
        normalizedText,
        textHash: `${id}:chapter-hash`,
        rawStartOffset: 0,
        rawEndOffset: normalizedText.length,
        characterCount: paragraphs.reduce((total, paragraph) => total + paragraph.text.length, 0),
        paragraphCount: paragraphs.length,
        createdAt: now,
        updatedAt: now,
      },
    ],
    paragraphs,
  };
}

async function createLegacyV11Database(novel: ParsedNovel): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('noveldesk-reader', 11);
    request.onupgradeneeded = () => {
      const db = request.result;
      const novelStore = db.createObjectStore('novels', { keyPath: 'id' });
      novelStore.createIndex('updatedAt', 'updatedAt');
      novelStore.createIndex('title', 'title');
      novelStore.put(novel.novel);

      const chapterStore = db.createObjectStore('chapters', { keyPath: 'id' });
      chapterStore.createIndex('novelId', 'novelId');
      novel.chapters.forEach((chapter) => chapterStore.put(chapter));

      const paragraphStore = db.createObjectStore('paragraphs', { keyPath: 'id' });
      paragraphStore.createIndex('novelId', 'novelId');
      paragraphStore.createIndex('chapterId', 'chapterId');
      paragraphStore.createIndex('chapterId_index', ['chapterId', 'index'], { unique: true });
      novel.paragraphs.forEach((paragraph) => paragraphStore.put(paragraph));

      const pageStore = db.createObjectStore('paragraph_pages', { keyPath: 'id' });
      pageStore.createIndex('novelId', 'novelId');
      pageStore.createIndex('chapterId', 'chapterId');
      pageStore.createIndex('chapterId_pageIndex', ['chapterId', 'pageIndex'], { unique: true });
      pageStore.put({
        id: `${novel.novel.id}:legacy-page:0`,
        novelId: novel.novel.id,
        chapterId: novel.chapters[0].id,
        pageIndex: 0,
        startParagraphIndex: 1,
        endParagraphIndex: novel.paragraphs.length,
        paragraphs: novel.paragraphs,
        textHash: `${novel.novel.id}:legacy-page-hash`,
      });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe('content revision storage', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('dual-reads v11 content without backfilling revision stores during upgrade', async () => {
    await resetReaderDbForTests();
    const legacy = parsedNovel('novel-v11', 'legacy');
    await createLegacyV11Database(legacy);

    const db = await openReaderDb();
    const [storedNovel, chapters, pages, paragraph, matches, revisions] = await Promise.all([
      getNovel(legacy.novel.id),
      getChapters(legacy.novel.id),
      getParagraphPages(legacy.chapters[0].id),
      getParagraph(legacy.paragraphs[0].id),
      searchParagraphs(legacy.chapters[0].id, legacy.paragraphs[0].text),
      getContentRevisions(legacy.novel.id),
    ]);

    expect(db.version).toBe(READER_DB_VERSION);
    expect(db.objectStoreNames.contains('reader_anchor_quarantine')).toBe(true);
    expect(storedNovel?.activeContentRevisionId).toBeUndefined();
    expect(chapters.map((chapter) => chapter.id)).toEqual([legacy.chapters[0].id]);
    expect(pages).toHaveLength(1);
    expect(paragraph?.text).toBe(legacy.paragraphs[0].text);
    expect(matches.map((item) => item.text)).toEqual([legacy.paragraphs[0].text]);
    expect(revisions).toEqual([]);
  });

  it('activates a multi-batch import once and queues one book_imported event', async () => {
    const parsed = parsedNovel('novel-single-activation', 'batched', PARAGRAPHS_PER_PAGE * 2 + 3);
    const countedIndexes: string[] = [];
    const nativeCount = IDBIndex.prototype.count;
    const countSpy = vi.spyOn(IDBIndex.prototype, 'count').mockImplementation(function (
      this: IDBIndex,
      query?: IDBValidKey | IDBKeyRange,
    ) {
      countedIndexes.push(this.name);
      return nativeCount.call(this, query);
    });
    try {
      await saveImportedNovel(parsed, { batchPageCount: 1 });
    } finally {
      countSpy.mockRestore();
    }

    const [novel, revisions, outbox] = await Promise.all([
      getNovel(parsed.novel.id),
      getContentRevisions(parsed.novel.id),
      listSyncOutbox(),
    ]);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      id: novel?.activeContentRevisionId,
      status: 'active',
      actual: {
        chapterCount: 1,
        pageCount: 3,
        paragraphCount: parsed.paragraphs.length,
        paragraphRefCount: parsed.paragraphs.length,
        searchRowCount: parsed.paragraphs.length,
      },
    });
    expect(revisions[0]?.stagedCounts).toBeUndefined();
    expect(countedIndexes).not.toContain('contentRevisionId');
    expect(outbox.map((item) => item.event.type)).toEqual(['book_imported']);
  });

  it('persists staging counts with each chapter and page batch before activation', async () => {
    const parsed = parsedNovel('novel-staged-counts', 'staged counts', PARAGRAPHS_PER_PAGE + 2);
    let releaseProgress!: () => void;
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    let staged!: () => void;
    const stagedWrite = new Promise<void>((resolve) => {
      staged = resolve;
    });
    let paused = false;
    const importPromise = saveImportedNovel(parsed, {
      batchPageCount: 1,
      onProgress: async (progress) => {
        if (paused || progress.phase !== 'writing_pages' || progress.paragraphsWritten !== parsed.paragraphs.length) {
          return;
        }
        paused = true;
        staged();
        await progressGate;
      },
    });

    await stagedWrite;
    const [stagingRevision] = await getContentRevisions(parsed.novel.id);
    releaseProgress();
    await importPromise;

    expect(stagingRevision).toMatchObject({
      status: 'staging',
      stagedCounts: {
        chapterCount: 1,
        pageCount: 2,
        paragraphCount: parsed.paragraphs.length,
        paragraphRefCount: parsed.paragraphs.length,
        searchRowCount: parsed.paragraphs.length,
      },
    });
    expect((await getContentRevisions(parsed.novel.id))[0]).toMatchObject({
      status: 'active',
      actual: stagingRevision.stagedCounts,
    });
  });

  it('falls back to index counts for a legacy staging revision without staged counts', async () => {
    const parsed = parsedNovel('novel-legacy-staged-counts', 'legacy staged counts', 0);
    const novel = {
      ...parsed.novel,
      totalChapters: 0,
      totalCharacters: 0,
      totalParagraphs: 0,
      lastReadChapterId: undefined,
    };
    const db = await openReaderDb();
    const revision = await createStagingContentRevision(db, {
      novel,
      source: 'local_import',
      expected: { chapterCount: 0, pageCount: 0, paragraphCount: 0 },
    });
    const { stagedCounts: _stagedCounts, ...legacyRevision } = revision;
    const tx = db.transaction('book_content_revisions', 'readwrite');
    tx.objectStore('book_content_revisions').put(legacyRevision);
    await transactionDone(tx);

    await activateStagedContentRevision(db, {
      revision: legacyRevision,
      actual: { chapterCount: 0, pageCount: 0, paragraphCount: 0, paragraphRefCount: 0, searchRowCount: 0 },
      novel,
    });

    expect((await getContentRevisions(novel.id))[0]).toMatchObject({
      status: 'active',
      actual: { chapterCount: 0, pageCount: 0, paragraphCount: 0, paragraphRefCount: 0, searchRowCount: 0 },
    });
  });

  it('keeps only the old active content visible while a replacement is staging', async () => {
    const original = parsedNovel('novel-stage-visibility', 'old');
    await saveImportedNovel(original);
    const originalNovel = await getNovel(original.novel.id);
    const originalOutbox = await listSyncOutbox();
    const replacement = parsedNovel(original.novel.id, 'replacement', PARAGRAPHS_PER_PAGE + 2);
    const observations: Array<{ title?: string; revision?: string; body?: string; outboxCount: number }> = [];

    await saveImportedNovel(replacement, {
      batchPageCount: 1,
      onProgress: async () => {
        const [visibleNovel, visibleParagraph, outbox] = await Promise.all([
          getNovel(original.novel.id),
          getParagraph(original.paragraphs[0].id),
          listSyncOutbox(),
        ]);
        observations.push({
          title: visibleNovel?.title,
          revision: visibleNovel?.activeContentRevisionId,
          body: visibleParagraph?.text,
          outboxCount: outbox.length,
        });
      },
    });

    expect(observations.length).toBeGreaterThan(1);
    expect(observations).toEqual(
      observations.map(() => ({
        title: original.novel.title,
        revision: originalNovel?.activeContentRevisionId,
        body: original.paragraphs[0].text,
        outboxCount: originalOutbox.length,
      })),
    );
    expect(await getNovel(original.novel.id)).toMatchObject({ title: original.novel.title });
    expect(await getParagraph(original.paragraphs[0].id)).toMatchObject({ text: replacement.paragraphs[0].text });
    expect((await listSyncOutbox()).filter((item) => item.event.type === 'book_imported')).toHaveLength(2);
  });

  it('activates staged content without losing reader metadata changed during the import', async () => {
    const original = parsedNovel('novel-activation-race', 'original');
    await saveImportedNovel(original);
    const existingNovel = await getNovel(original.novel.id);
    await patchNovelMetadata(existingNovel!.id, { title: 'Existing reader title', favorite: true });
    const replacement = parsedNovel(original.novel.id, 'replacement', PARAGRAPHS_PER_PAGE + 2);
    let releaseProgress!: () => void;
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    let staged!: () => void;
    const stagedWrite = new Promise<void>((resolve) => {
      staged = resolve;
    });
    let paused = false;
    const replacementImport = saveImportedNovel(replacement, {
      batchPageCount: 1,
      onProgress: async () => {
        if (paused) return;
        paused = true;
        staged();
        await progressGate;
      },
    });

    await stagedWrite;
    await addNovelReadingTime(original.novel.id, 27, '2026-07-10T00:20:00.000Z');
    await saveReadingPosition({
      novelId: original.novel.id,
      chapterId: original.chapters[0].id,
      scrollTop: 320,
      chapterProgress: 0.7,
      paragraphId: original.paragraphs[0].id,
      paragraphIndex: 1,
      offsetInParagraph: 5,
    });
    const changedDuringImport = await getNovel(original.novel.id);
    expect(changedDuringImport).toBeDefined();
    await patchNovelMetadata(changedDuringImport!.id, {
      title: 'Reader title',
      favorite: true,
      analysisStatus: 'ready',
    });
    releaseProgress();
    await replacementImport;

    expect(await getNovel(original.novel.id)).toMatchObject({
      title: 'Reader title',
      favorite: true,
      readingSeconds: 27,
      lastReadAt: '2026-07-10T00:20:00.000Z',
      lastReadChapterId: undefined,
      lastReadParagraphId: undefined,
      lastReadOffset: 0,
      lastReadProgress: 0,
      analysisStatus: replacement.novel.analysisStatus,
      sourceFileName: replacement.novel.sourceFileName,
      normalizedTextHash: replacement.novel.normalizedTextHash,
      totalParagraphs: replacement.novel.totalParagraphs,
    });
    expect((await listSyncOutbox()).map((item) => item.event.type)).toEqual([
      'book_imported',
      'book_updated',
      'book_updated',
      'book_imported',
    ]);
    const db = await openReaderDb();
    const quarantine = await requestToPromise<unknown[]>(
      db.transaction('reader_anchor_quarantine').objectStore('reader_anchor_quarantine').getAll(),
    );
    expect(quarantine).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'reading_position',
          sourceEntityId: `reading_position_${original.novel.id}`,
        }),
        expect.objectContaining({ entityType: 'sync_outbox' }),
      ]),
    );
  });

  it('keeps user-managed metadata and cover while replacing the same book content', async () => {
    const original = parsedNovel('novel-user-metadata-reimport', 'original');
    await saveImportedNovel(original);
    const catalog = new IndexedDbLibraryCatalogRepository();
    const assets = new IndexedDbBookAssetRepository();
    await catalog.patchMetadata(
      original.novel.id,
      {
        title: '내가 정한 제목',
        author: '내가 정한 작가',
        seriesTitle: '내 시리즈',
        seriesIndex: 4,
        tags: ['보존', '사용자'],
        description: '내 설명',
        language: 'ko',
      },
      { metadataRevision: 0, activeContentRevisionId: original.novel.activeContentRevisionId },
    );
    const edited = (await getNovel(original.novel.id))!;
    const cover = await assets.saveCover(original.novel.id, {
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      fileName: 'user-cover.png',
      contentType: 'image/png',
      contentHash: `sha256:${'ab'.repeat(32)}`,
      pixelWidth: 30,
      pixelHeight: 40,
      fit: 'crop',
      positionX: 31,
      positionY: 72,
      expectedMetadataRevision: edited.metadataRevision,
    });
    const db = await openReaderDb();
    const seedTx = db.transaction('novels', 'readwrite');
    const seeded = (await requestToPromise(seedTx.objectStore('novels').get(original.novel.id)))!;
    seedTx.objectStore('novels').put({
      ...seeded,
      cloudVaultBookId: 'vault-stable-book-id',
      readingDirection: 'rtl',
    });
    await transactionDone(seedTx);
    const before = (await getNovel(original.novel.id))!;

    const replacement = parsedNovel(original.novel.id, 'replacement');
    replacement.novel.sourceFileName = 'replacement.txt';
    replacement.novel.author = 'source author';
    replacement.novel.seriesTitle = 'source series';
    replacement.novel.seriesIndex = 99;
    replacement.novel.tags = ['source'];
    replacement.novel.description = 'source description';
    replacement.novel.language = 'en';
    replacement.novel.readingDirection = 'ltr';
    replacement.novel.metadataRevision = 0;
    replacement.novel.coverAssetId = 'source-cover';
    replacement.novel.coverContentHash = 'source-cover-hash';
    await saveImportedNovel(replacement);

    expect(await getNovel(original.novel.id)).toMatchObject({
      cloudVaultBookId: 'vault-stable-book-id',
      title: '내가 정한 제목',
      author: '내가 정한 작가',
      seriesTitle: '내 시리즈',
      seriesIndex: 4,
      tags: ['보존', '사용자'],
      description: '내 설명',
      language: 'ko',
      readingDirection: 'rtl',
      coverAssetId: cover.id,
      coverContentHash: cover.contentHash,
      coverFit: 'crop',
      coverPositionX: 31,
      coverPositionY: 72,
      coverUpdatedAt: before.coverUpdatedAt,
      metadataRevision: before.metadataRevision,
      sourceFileName: 'replacement.txt',
      normalizedTextHash: replacement.novel.normalizedTextHash,
    });
  });

  it('rejects a delayed reader position write from a replaced content revision', async () => {
    const original = parsedNovel('novel-reader-position-revision-fence', 'original');
    await saveImportedNovel(original);
    const before = (await getNovel(original.novel.id))!;
    const replacement = parsedNovel(original.novel.id, 'replacement');
    await saveImportedNovel(replacement);

    await expect(
      saveReadingPosition({
        novelId: original.novel.id,
        expectedContentRevisionId: before.activeContentRevisionId,
        chapterId: original.chapters[0].id,
        paragraphId: original.paragraphs[0].id,
        paragraphIndex: 1,
        offsetInParagraph: 0,
        chapterProgress: 0.5,
        scrollTop: 120,
      }),
    ).rejects.toMatchObject({ name: 'ContentRevisionConflictError' });

    expect((await getNovel(original.novel.id))?.lastReadProgress).toBe(0);
  });

  it('remaps exact reader anchors during a same-id local replacement', async () => {
    const original = parsedNovel('novel-anchor-remap', 'stable text');
    await saveImportedNovel(original);
    await saveReadingPosition({
      novelId: original.novel.id,
      chapterId: original.chapters[0].id,
      paragraphId: original.paragraphs[0].id,
      paragraphIndex: original.paragraphs[0].index,
      offsetInParagraph: 2,
      chapterProgress: 0.4,
      scrollTop: 120,
    });
    const createdAt = '2026-07-10T00:30:00.000Z';
    await saveBookmark({
      id: 'bookmark-anchor-remap',
      novelId: original.novel.id,
      chapterId: original.chapters[0].id,
      paragraphId: original.paragraphs[0].id,
      label: 'Keep bookmark',
      progress: 0.4,
      scrollTop: 120,
      createdAt,
    });
    await saveHighlight({
      id: 'highlight-anchor-remap',
      novelId: original.novel.id,
      chapterId: original.chapters[0].id,
      paragraphId: original.paragraphs[0].id,
      quote: original.paragraphs[0].text,
      color: 'yellow',
      progress: 0.4,
      createdAt,
      updatedAt: createdAt,
    });
    await saveNote({
      id: 'note-anchor-remap',
      novelId: original.novel.id,
      chapterId: original.chapters[0].id,
      paragraphId: original.paragraphs[0].id,
      quote: original.paragraphs[0].text,
      body: 'Keep note',
      progress: 0.4,
      createdAt,
      updatedAt: createdAt,
    });

    const replacement = parsedNovel(original.novel.id, 'stable text');
    replacement.novel.normalizedTextHash = `${replacement.novel.normalizedTextHash}:replacement`;
    replacement.chapters[0].id = `${original.novel.id}:replacement-chapter:1`;
    replacement.paragraphs.forEach((paragraph) => {
      paragraph.chapterId = replacement.chapters[0].id;
      paragraph.id = `${paragraph.id}:replacement`;
    });
    await saveImportedNovel(replacement);

    expect(await getNovel(original.novel.id)).toMatchObject({
      lastReadChapterId: replacement.chapters[0].id,
      lastReadParagraphId: replacement.paragraphs[0].id,
    });
    const db = await openReaderDb();
    const tx = db.transaction(['reading_positions', 'bookmarks', 'highlights', 'notes', 'reader_anchor_quarantine']);
    await expect(
      requestToPromise(tx.objectStore('reading_positions').get(`reading_position_${original.novel.id}`)),
    ).resolves.toMatchObject({
      chapterId: replacement.chapters[0].id,
      paragraphId: replacement.paragraphs[0].id,
    });
    for (const [storeName, id] of [
      ['bookmarks', 'bookmark-anchor-remap'],
      ['highlights', 'highlight-anchor-remap'],
      ['notes', 'note-anchor-remap'],
    ] as const) {
      await expect(requestToPromise(tx.objectStore(storeName).get(id))).resolves.toMatchObject({
        chapterId: replacement.chapters[0].id,
        paragraphId: replacement.paragraphs[0].id,
      });
    }
    await expect(requestToPromise<unknown[]>(tx.objectStore('reader_anchor_quarantine').getAll())).resolves.toEqual([]);
  });

  it('persists an exact pending count while replacing mixed outbox states', async () => {
    const original = parsedNovel('novel-mixed-outbox', 'stable text');
    await saveImportedNovel(original);
    await saveReadingPosition({
      novelId: original.novel.id,
      chapterId: original.chapters[0].id,
      paragraphId: original.paragraphs[0].id,
      paragraphIndex: 1,
      chapterProgress: 0.4,
      scrollTop: 120,
    });
    const createdAt = '2026-07-10T00:30:00.000Z';
    await saveBookmark({
      id: 'bookmark-mixed-outbox',
      novelId: original.novel.id,
      chapterId: original.chapters[0].id,
      paragraphId: original.paragraphs[0].id,
      label: 'Bookmark',
      progress: 0.4,
      scrollTop: 120,
      createdAt,
    });
    await saveHighlight({
      id: 'highlight-mixed-outbox',
      novelId: original.novel.id,
      chapterId: original.chapters[0].id,
      paragraphId: original.paragraphs[0].id,
      quote: original.paragraphs[0].text,
      color: 'yellow',
      progress: 0.4,
      createdAt,
      updatedAt: createdAt,
    });
    await saveNote({
      id: 'note-mixed-outbox',
      novelId: original.novel.id,
      chapterId: original.chapters[0].id,
      paragraphId: original.paragraphs[0].id,
      body: 'Note',
      progress: 0.4,
      createdAt,
      updatedAt: createdAt,
    });

    const db = await openReaderDb();
    const seedTx = db.transaction(['sync_outbox', 'sync_state'], 'readwrite');
    const outboxStore = seedTx.objectStore('sync_outbox');
    const items = await requestToPromise<SyncOutboxItem[]>(outboxStore.getAll());
    const statusByType: Partial<Record<SyncOutboxItem['event']['type'], SyncOutboxItem['status']>> = {
      book_imported: 'sent',
      reading_position_updated: 'pending',
      bookmark_created: 'sending',
      highlight_created: 'failed',
      note_created: 'sent',
    };
    items.forEach((item) => {
      const status = statusByType[item.event.type];
      if (!status) return;
      outboxStore.put({
        ...item,
        status,
        leaseToken: status === 'sending' ? 'active-lease' : undefined,
        leaseExpiresAt: status === 'sending' ? '2026-07-10T01:00:00.000Z' : undefined,
      });
    });
    const stateStore = seedTx.objectStore('sync_state');
    const state = await requestToPromise<SyncState>(stateStore.get('sync-state'));
    stateStore.put({ ...state, pendingCount: 99 });
    await transactionDone(seedTx);

    const replacement = parsedNovel(original.novel.id, 'stable text');
    replacement.novel.normalizedTextHash = `${replacement.novel.normalizedTextHash}:replacement`;
    replacement.chapters[0].id = `${original.novel.id}:replacement-chapter:1`;
    replacement.paragraphs.forEach((paragraph) => {
      paragraph.chapterId = replacement.chapters[0].id;
      paragraph.id = `${paragraph.id}:replacement`;
    });
    await saveImportedNovel(replacement);

    const persistedTx = db.transaction(['sync_outbox', 'sync_state', 'reader_anchor_quarantine'], 'readonly');
    const [persistedItems, persistedState, quarantine] = await Promise.all([
      requestToPromise<SyncOutboxItem[]>(persistedTx.objectStore('sync_outbox').getAll()),
      requestToPromise<SyncState>(persistedTx.objectStore('sync_state').get('sync-state')),
      requestToPromise<unknown[]>(persistedTx.objectStore('reader_anchor_quarantine').getAll()),
    ]);
    await transactionDone(persistedTx);
    const queued = persistedItems.filter((item) => item.status !== 'sent');
    expect(queued).toHaveLength(5);
    expect(persistedState.pendingCount).toBe(queued.length);
    expect(persistedState.nextSequence).toBe(Math.max(...persistedItems.map((item) => item.localSequence)) + 1);
    expect(queued.filter((item) => item.status === 'pending')).toHaveLength(5);
    expect(quarantine).toContainEqual(
      expect.objectContaining({
        entityType: 'sync_outbox',
        reason: 'content_replaced_inflight_replaced',
      }),
    );
  });

  it('rejects stale activation with CAS and removes only the losing staging revision', async () => {
    const original = parsedNovel('novel-cas', 'original');
    await saveImportedNovel(original);
    const staleReplacement = parsedNovel(original.novel.id, 'stale replacement');
    const winningReplacement = parsedNovel(original.novel.id, 'winning replacement');
    let releaseProgress!: () => void;
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    let staged!: () => void;
    const stagedWrite = new Promise<void>((resolve) => {
      staged = resolve;
    });
    let paused = false;
    const losingImport = saveImportedNovel(staleReplacement, {
      batchPageCount: 1,
      onProgress: async () => {
        if (paused) return;
        paused = true;
        staged();
        await progressGate;
      },
    });

    await stagedWrite;
    await saveImportedNovel(winningReplacement);
    releaseProgress();
    await expect(losingImport).rejects.toMatchObject({ name: 'ContentRevisionConflictError' });

    expect(await getNovel(original.novel.id)).toMatchObject({ title: original.novel.title });
    expect(await getParagraph(original.paragraphs[0].id)).toMatchObject({
      text: winningReplacement.paragraphs[0].text,
    });
    const revisions = await getContentRevisions(original.novel.id);
    expect(revisions).toHaveLength(2);
    expect(revisions.filter((revision) => revision.status === 'active')).toHaveLength(1);
    expect(revisions.some((revision) => revision.status === 'staging')).toBe(false);
    expect((await listSyncOutbox()).filter((item) => item.event.type === 'book_imported')).toHaveLength(2);
  });

  it('rejects remote activation when a reader mutation advances the sync sequence after planning', async () => {
    const original = parsedNovel('novel-reader-plan-cas', 'original');
    await saveImportedNovel(original);
    const db = await openReaderDb();
    const current = (await getNovel(original.novel.id))!;
    const revision = await createStagingContentRevision(db, {
      novel: current,
      source: 'remote_snapshot',
      expected: { chapterCount: 0, pageCount: 0, paragraphCount: 0 },
    });
    const plannedSequence = (await getSyncState()).nextSequence;
    await patchNovelMetadata(current.id, { favorite: true });

    await expect(
      activateStagedContentRevision(db, {
        revision,
        actual: { chapterCount: 0, pageCount: 0, paragraphCount: 0, paragraphRefCount: 0, searchRowCount: 0 },
        novel: current,
        readerPlan: {
          expectedSyncNextSequence: plannedSequence,
          bookmarks: [],
          highlights: [],
          notes: [],
          outboxItems: [],
        },
      }),
    ).rejects.toMatchObject({ name: 'ContentRevisionConflictError' });

    expect(await getNovel(original.novel.id)).toMatchObject({ favorite: true });
  });
});
