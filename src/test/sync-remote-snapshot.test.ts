import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { integrityHash } from '../domain/id-hash-contract';
import type { Paragraph, ParagraphPage, ParsedNovel } from '../domain/types';
import { getRemoteBookSnapshotStream } from '../services/remote/remote-book-snapshot';
import {
  applyRemoteSyncEvents,
  cacheRemoteBookSnapshot,
  cacheRemoteBookSnapshotStream,
  getBookmarks,
  getChapters,
  getHighlights,
  getNovel,
  getNotes,
  getParagraph,
  getParagraphPage,
  getReadingPosition,
  listSyncOutbox,
  openReaderDb,
  resetReaderDbForTests,
  saveImportedNovel,
  searchBookParagraphs,
  saveReadingPosition,
} from '../storage/db';
import type { BookContentRevisionRecord } from '../storage/content-revisions';
import { CONTENT_REVISION_STORES } from '../storage/content-revision-migration';
import type { RevisionChapterRow } from '../storage/content-revision-store';
import { LocalOutboxSyncService, type SyncEventSource } from '../sync/local-outbox-sync-service';
import type { RemoteBookSnapshot, RemoteBookSnapshotStream, SyncEvent } from '../sync/types';

const NOW = '2026-07-04T00:00:00.000Z';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function contentRevisions(novelId: string): Promise<BookContentRevisionRecord[]> {
  const db = await openReaderDb();
  const tx = db.transaction('book_content_revisions', 'readonly');
  return requestToPromise<BookContentRevisionRecord[]>(
    tx.objectStore('book_content_revisions').index('novelId').getAll(novelId),
  );
}

async function revisionChapters(contentRevisionId: string): Promise<RevisionChapterRow[]> {
  const db = await openReaderDb();
  const tx = db.transaction(CONTENT_REVISION_STORES.chapters, 'readonly');
  return requestToPromise<RevisionChapterRow[]>(
    tx.objectStore(CONTENT_REVISION_STORES.chapters).index('contentRevisionId').getAll(contentRevisionId),
  );
}

function parsedNovel(id: string): ParsedNovel {
  const text = 'body';
  const chapterId = `${id}:chapter:1`;
  return {
    novel: {
      id,
      title: 'Remote Test',
      sourceFileName: 'remote-test.txt',
      sourceEncoding: 'utf-8',
      rawText: text,
      normalizedText: text,
      rawTextHash: integrityHash(text),
      normalizedTextHash: integrityHash(text),
      createdAt: NOW,
      updatedAt: NOW,
      totalChapters: 1,
      totalCharacters: text.length,
      totalParagraphs: 1,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters: [
      {
        id: chapterId,
        novelId: id,
        index: 1,
        title: 'Chapter 1',
        normalizedText: text,
        textHash: integrityHash(text),
        rawStartOffset: 0,
        rawEndOffset: text.length,
        characterCount: text.length,
        paragraphCount: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    paragraphs: [
      {
        id: `${id}:paragraph:1`,
        novelId: id,
        chapterId,
        index: 1,
        text,
        startOffsetInChapter: 0,
        endOffsetInChapter: text.length,
        textHash: integrityHash(text),
      },
    ],
  };
}

function page(id: string, paragraph: Paragraph, pageIndex = 0): ParagraphPage {
  return {
    id,
    novelId: paragraph.novelId,
    chapterId: paragraph.chapterId,
    pageIndex,
    startParagraphIndex: paragraph.index,
    endParagraphIndex: paragraph.index,
    paragraphs: [paragraph],
    textHash: integrityHash(JSON.stringify([paragraph.textHash])),
  };
}

function fixedDocumentSnapshot(bookId: string, bodyVersion: string): RemoteBookSnapshot {
  const chapters = Array.from({ length: 6 }, (_, zeroIndex) => {
    const index = zeroIndex + 1;
    const text = `${bodyVersion} section ${index}`;
    return {
      id: `${bookId}:chapter:${index}`,
      novelId: bookId,
      index,
      title: `${index}화`,
      normalizedText: text,
      textHash: integrityHash(text),
      rawStartOffset: zeroIndex * 100,
      rawEndOffset: zeroIndex * 100 + text.length,
      characterCount: text.length,
      paragraphCount: 1,
      documentSectionId: `section:${index}`,
      documentSectionTitle: `${index}화`,
      documentSectionIndex: index,
      documentPageIndexInSection: 0,
      documentSectionSourceContentHash: integrityHash(`${bodyVersion}:release:${index}`),
      createdAt: NOW,
      updatedAt: NOW,
    };
  });
  const paragraphs = chapters.map((chapter) => ({
    id: `${chapter.id}:paragraph:1`,
    novelId: bookId,
    chapterId: chapter.id,
    index: 1,
    text: chapter.normalizedText,
    startOffsetInChapter: 0,
    endOffsetInChapter: chapter.normalizedText.length,
    textHash: integrityHash(chapter.normalizedText),
  }));
  const fullText = chapters.map((chapter) => chapter.normalizedText).join('\n');
  const base = parsedNovel(bookId).novel;
  return {
    novel: {
      ...base,
      format: 'image_archive',
      title: `Fixed document ${bodyVersion}`,
      rawText: '',
      normalizedText: '',
      rawTextHash: integrityHash(fullText),
      normalizedTextHash: integrityHash(fullText),
      totalChapters: chapters.length,
      totalCharacters: fullText.length,
      totalParagraphs: paragraphs.length,
      documentSectionCount: chapters.length,
    },
    chapters,
    paragraphPages: paragraphs.map((paragraph) => page(`${paragraph.chapterId}:page:0`, paragraph)),
    expectedChapterCount: chapters.length,
    expectedPageCount: paragraphs.length,
    expectedParagraphCount: paragraphs.length,
  };
}

function readingPositionEvent(input: {
  id: string;
  bookId: string;
  chapterId: string;
  contentRevisionId: string;
  updatedAt: string;
  documentSectionId?: string;
}): SyncEvent {
  return {
    id: input.id,
    type: 'reading_position_updated',
    deviceId: 'remote-device',
    novelId: input.bookId,
    entityId: `reading_position_${input.bookId}`,
    payload: {
      position: {
        id: `reading_position_${input.bookId}`,
        novelId: input.bookId,
        chapterId: input.chapterId,
        paragraphIndex: 1,
        offsetInParagraph: 0,
        chapterProgress: 0.5,
        scrollTop: 100,
        deviceId: 'remote-device',
        updatedAt: input.updatedAt,
        ...(input.documentSectionId ? { documentSectionId: input.documentSectionId } : {}),
        contentRevisionId: input.contentRevisionId,
      },
    },
    createdAt: input.updatedAt,
  };
}

function readingPositionResetEvent(input: {
  id: string;
  bookId: string;
  contentRevisionId: string;
  deletedAt: string;
}): SyncEvent {
  return {
    id: input.id,
    type: 'reading_position_deleted',
    deviceId: 'remote-device',
    novelId: input.bookId,
    entityId: `reading_position_${input.bookId}`,
    payload: {
      id: `reading_position_${input.bookId}`,
      deletedAt: input.deletedAt,
      expectedContentRevisionId: input.contentRevisionId,
    },
    createdAt: input.deletedAt,
  };
}

function importEvent(bookId: string): SyncEvent {
  return {
    id: `${bookId}:imported`,
    type: 'book_imported',
    deviceId: 'server',
    novelId: bookId,
    entityId: bookId,
    payload: { bookId },
    createdAt: NOW,
  };
}

describe('remote sync snapshot hydration', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('hydrates a full remote snapshot and removes its searchable content on delete', async () => {
    const parsed = parsedNovel('remote-book');
    const snapshot: RemoteBookSnapshot = {
      novel: { ...parsed.novel, title: 'Remote Book' },
      chapters: parsed.chapters,
      paragraphPages: [page('remote-book:page:0', parsed.paragraphs[0])],
    };
    const hydrated: string[] = [];
    const source: SyncEventSource = {
      async pushSync() {
        throw new Error('push should not run without pending events');
      },
      async pullSync() {
        return { cursor: 20, events: [importEvent(parsed.novel.id)] };
      },
      async getBookSnapshot(bookId) {
        hydrated.push(bookId);
        return snapshot;
      },
    };

    const state = await new LocalOutboxSyncService(source).flushPending();

    expect(hydrated).toEqual([parsed.novel.id]);
    expect(await getNovel(parsed.novel.id)).toMatchObject({ title: 'Remote Book' });
    expect(await getChapters(parsed.novel.id)).toMatchObject([{ id: parsed.chapters[0].id }]);
    expect(await getParagraphPage(parsed.chapters[0].id, 0)).toMatchObject({
      paragraphs: [{ id: parsed.paragraphs[0].id, text: 'body' }],
    });
    expect((await searchBookParagraphs(parsed.novel.id, 'body', 5)).map((item) => item.id)).toEqual([
      parsed.paragraphs[0].id,
    ]);
    expect(state).toMatchObject({ status: 'idle', lastRemoteCursor: 20, pendingCount: 0 });

    await applyRemoteSyncEvents([
      {
        id: 'remote-book:deleted',
        type: 'book_deleted',
        deviceId: 'server',
        novelId: parsed.novel.id,
        entityId: parsed.novel.id,
        payload: {},
        createdAt: NOW,
      },
    ]);
    expect(await getParagraph(parsed.paragraphs[0].id)).toBeUndefined();
    expect(await searchBookParagraphs(parsed.novel.id, 'body', 5)).toEqual([]);
  });

  it('hydrates streamed page batches without requesting a full snapshot', async () => {
    const parsed = parsedNovel('remote-batched-book');
    const second: Paragraph = {
      ...parsed.paragraphs[0],
      id: 'remote-batched-book:paragraph:2',
      index: 2,
      text: 'second body',
      textHash: integrityHash('second body'),
    };
    const snapshot: Omit<RemoteBookSnapshotStream, 'pageBatches'> = {
      novel: { ...parsed.novel, title: 'Remote Batched Book', totalParagraphs: 2 },
      chapters: parsed.chapters.map((chapter) => ({ ...chapter, paragraphCount: 2 })),
      expectedChapterCount: 1,
      expectedPageCount: 2,
      expectedParagraphCount: 2,
    };
    const yielded: string[] = [];
    async function* pageBatches(): AsyncGenerator<ParagraphPage[]> {
      const firstPage = page('remote-batched-book:page:0', parsed.paragraphs[0], 0);
      yielded.push(firstPage.id);
      yield [firstPage];
      const secondPage = page('remote-batched-book:page:1', second, 1);
      yielded.push(secondPage.id);
      yield [secondPage];
    }
    const source: SyncEventSource = {
      async pushSync() {
        throw new Error('push should not run without pending events');
      },
      async pullSync() {
        return { cursor: 21, events: [importEvent(parsed.novel.id)] };
      },
      async getBookSnapshotStream() {
        return { ...snapshot, pageBatches: pageBatches() };
      },
      async getBookSnapshot() {
        throw new Error('full snapshot fallback should not run');
      },
    };

    const state = await new LocalOutboxSyncService(source).flushPending();

    expect(yielded).toEqual(['remote-batched-book:page:0', 'remote-batched-book:page:1']);
    expect(await getParagraphPage(parsed.chapters[0].id, 1)).toMatchObject({
      paragraphs: [{ id: second.id, text: 'second body' }],
    });
    expect(state).toMatchObject({ status: 'idle', lastRemoteCursor: 21, pendingCount: 0 });
  });

  it('preserves the server content revision token through a cached physical revision and reader outbox', async () => {
    const bookId = 'remote-token-book';
    const serverRevision = 'server-content-r2';
    const chapterId = `${bookId}:chapter:1`;
    const paragraph: Paragraph = {
      id: `${chapterId}:paragraph:1`,
      novelId: bookId,
      chapterId,
      index: 1,
      text: 'remote token body',
      startOffsetInChapter: 0,
      endOffsetInChapter: 17,
      textHash: integrityHash('remote token body'),
    };
    const manifest = {
      book: {
        id: bookId,
        format: 'txt',
        active_content_revision_id: serverRevision,
        title: 'Remote token book',
        source_file_name: 'remote-token.txt',
        source_encoding: 'utf-8',
        normalized_text_hash: integrityHash(paragraph.text),
        created_at: NOW,
        updated_at: NOW,
        total_chapters: 1,
        total_characters: paragraph.text.length,
        total_paragraphs: 1,
        cover_seed: 1,
      },
      readingPosition: null,
    };
    const transport = {
      getBookManifest: async () => manifest,
      listChapters: async () => ({
        contentRevisionId: serverRevision,
        chapters: [
          {
            id: chapterId,
            book_id: bookId,
            chapter_index: 1,
            title: '1화',
            text_hash: integrityHash(paragraph.text),
            raw_start_offset: 0,
            raw_end_offset: paragraph.text.length,
            character_count: paragraph.text.length,
            paragraph_count: 1,
            created_at: NOW,
            updated_at: NOW,
          },
        ],
      }),
      listPages: async () => ({
        contentRevisionId: serverRevision,
        pages: [
          {
            id: `${chapterId}:page:0`,
            book_id: bookId,
            chapter_id: chapterId,
            page_index: 0,
            start_paragraph_index: 1,
            end_paragraph_index: 1,
            paragraphs: [paragraph],
            text_hash: integrityHash(JSON.stringify([paragraph.textHash])),
          },
        ],
      }),
    };

    const snapshot = await getRemoteBookSnapshotStream(transport, bookId);
    expect(snapshot?.sourceRevision).toBe(serverRevision);
    await cacheRemoteBookSnapshotStream(snapshot!);

    const cached = await getNovel(bookId);
    expect(cached?.activeContentRevisionId).toBeTruthy();
    expect(cached?.activeContentRevisionId).not.toBe(serverRevision);
    expect(await contentRevisions(bookId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: cached?.activeContentRevisionId,
          sourceRevision: serverRevision,
          status: 'active',
        }),
      ]),
    );

    await saveReadingPosition({
      novelId: bookId,
      expectedContentRevisionId: cached?.activeContentRevisionId,
      chapterId,
      scrollTop: 24,
      chapterProgress: 0.25,
      paragraphId: paragraph.id,
      paragraphIndex: 1,
      offsetInParagraph: 0,
    });

    expect((await listSyncOutbox()).at(-1)?.event).toMatchObject({
      type: 'reading_position_updated',
      payload: {
        position: {
          novelId: bookId,
          contentRevisionId: serverRevision,
        },
      },
    });
  });

  it('keeps exact section reads independent and fences stale reader events across purge/re-add incarnations', async () => {
    const bookId = 'remote-reader-incarnation';
    const firstSnapshot = fixedDocumentSnapshot(bookId, 'r1');
    await cacheRemoteBookSnapshot({ ...firstSnapshot, sourceRevision: 'server-r1' });
    const firstPhysicalRevision = (await getNovel(bookId))?.activeContentRevisionId;
    expect(firstPhysicalRevision).toBeTruthy();

    await applyRemoteSyncEvents([
      readingPositionEvent({
        id: 'r1-section-2',
        bookId,
        chapterId: `${bookId}:chapter:2`,
        documentSectionId: 'section:2',
        contentRevisionId: 'server-r1',
        updatedAt: '2026-07-04T00:10:00.000Z',
      }),
    ]);
    expect(
      (await revisionChapters(firstPhysicalRevision!)).find((row) => row.documentSectionId === 'section:2'),
    ).toMatchObject({ documentSectionReadAt: '2026-07-04T00:10:00.000Z' });

    const secondSnapshot = fixedDocumentSnapshot(bookId, 'r2');
    await cacheRemoteBookSnapshot({ ...secondSnapshot, sourceRevision: 'server-r2' });
    const secondPhysicalRevision = (await getNovel(bookId))?.activeContentRevisionId;
    expect(secondPhysicalRevision).toBeTruthy();
    expect(secondPhysicalRevision).not.toBe(firstPhysicalRevision);

    await applyRemoteSyncEvents([
      readingPositionEvent({
        id: 'r2-global-section-3',
        bookId,
        chapterId: `${bookId}:chapter:3`,
        contentRevisionId: 'server-r2',
        updatedAt: '2026-07-04T00:30:00.000Z',
      }),
      readingPositionEvent({
        id: 'r2-exact-section-6',
        bookId,
        chapterId: `${bookId}:chapter:6`,
        documentSectionId: 'section:6',
        contentRevisionId: 'server-r2',
        updatedAt: '2026-07-04T00:20:00.000Z',
      }),
    ]);

    expect(await getReadingPosition(bookId)).toMatchObject({ chapterId: `${bookId}:chapter:3` });
    expect(
      (await getChapters(bookId)).map((chapter) => [chapter.documentSectionId, chapter.documentSectionReadAt]),
    ).toEqual([
      ['section:1', undefined],
      ['section:2', undefined],
      ['section:3', undefined],
      ['section:4', undefined],
      ['section:5', undefined],
      ['section:6', '2026-07-04T00:20:00.000Z'],
    ]);

    await applyRemoteSyncEvents([
      readingPositionEvent({
        id: 'stale-r1-section-4',
        bookId,
        chapterId: `${bookId}:chapter:4`,
        documentSectionId: 'section:4',
        contentRevisionId: 'server-r1',
        updatedAt: '2026-07-04T00:40:00.000Z',
      }),
      readingPositionResetEvent({
        id: 'stale-r1-reset',
        bookId,
        contentRevisionId: 'server-r1',
        deletedAt: '2026-07-04T00:41:00.000Z',
      }),
    ]);

    expect(await getReadingPosition(bookId)).toMatchObject({ chapterId: `${bookId}:chapter:3` });
    expect((await getChapters(bookId)).find((chapter) => chapter.documentSectionId === 'section:4')).not.toHaveProperty(
      'documentSectionReadAt',
    );
    expect((await getChapters(bookId)).find((chapter) => chapter.documentSectionId === 'section:6')).toMatchObject({
      documentSectionReadAt: '2026-07-04T00:20:00.000Z',
    });

    await applyRemoteSyncEvents([
      readingPositionResetEvent({
        id: 'active-r2-reset',
        bookId,
        contentRevisionId: 'server-r2',
        deletedAt: '2026-07-04T00:42:00.000Z',
      }),
    ]);

    expect(await getReadingPosition(bookId)).toBeUndefined();
    expect((await getChapters(bookId)).every((chapter) => !chapter.documentSectionReadAt)).toBe(true);
    expect((await revisionChapters(secondPhysicalRevision!)).every((chapter) => !chapter.documentSectionReadAt)).toBe(
      true,
    );
    expect(
      (await revisionChapters(firstPhysicalRevision!)).find((row) => row.documentSectionId === 'section:2'),
    ).toMatchObject({ documentSectionReadAt: '2026-07-04T00:10:00.000Z' });
  });

  it('keeps active content, anchors, search, and outbox when a later remote page throws', async () => {
    const original = parsedNovel('remote-stream-failure');
    await saveImportedNovel(original);
    await saveReadingPosition({
      novelId: original.novel.id,
      chapterId: original.chapters[0].id,
      scrollTop: 80,
      chapterProgress: 0.5,
      paragraphId: original.paragraphs[0].id,
      paragraphIndex: 1,
      offsetInParagraph: 0,
    });
    const before = await Promise.all([
      getNovel(original.novel.id),
      getReadingPosition(original.novel.id),
      listSyncOutbox(),
      contentRevisions(original.novel.id),
    ]);
    const replacement = {
      ...original.paragraphs[0],
      text: 'replacement body',
      textHash: integrityHash('replacement body'),
    };
    async function* failingPages(): AsyncGenerator<ParagraphPage[]> {
      yield [page('remote-stream-failure:new-page:0', replacement)];
      throw new Error('page 1 failed');
    }

    await expect(
      cacheRemoteBookSnapshotStream({
        novel: { ...original.novel, title: 'replacement title', totalParagraphs: 2 },
        chapters: [{ ...original.chapters[0], paragraphCount: 2 }],
        expectedChapterCount: 1,
        expectedParagraphCount: 2,
        pageBatches: failingPages(),
      }),
    ).rejects.toThrow('page 1 failed');

    expect(await getNovel(original.novel.id)).toEqual(before[0]);
    expect(await getReadingPosition(original.novel.id)).toEqual(before[1]);
    expect(await getParagraph(original.paragraphs[0].id)).toMatchObject({ text: 'body' });
    expect((await searchBookParagraphs(original.novel.id, 'body', 5)).map((item) => item.id)).toEqual([
      original.paragraphs[0].id,
    ]);
    expect(await listSyncOutbox()).toEqual(before[2]);
    expect(await contentRevisions(original.novel.id)).toEqual(before[3]);
  });

  it('rejects an early stream count mismatch without promoting staged content', async () => {
    const parsed = parsedNovel('remote-early-end');
    async function* earlyPages(): AsyncGenerator<ParagraphPage[]> {
      yield [page('remote-early-end:page:0', parsed.paragraphs[0])];
    }

    await expect(
      cacheRemoteBookSnapshotStream({
        novel: { ...parsed.novel, totalParagraphs: 2 },
        chapters: [{ ...parsed.chapters[0], paragraphCount: 2 }],
        expectedChapterCount: 1,
        expectedParagraphCount: 2,
        pageBatches: earlyPages(),
      }),
    ).rejects.toMatchObject({ name: 'ContentRevisionValidationError' });

    expect(await getNovel(parsed.novel.id)).toBeUndefined();
    expect(await getParagraph(parsed.paragraphs[0].id)).toBeUndefined();
    expect(await contentRevisions(parsed.novel.id)).toEqual([]);
    expect(await listSyncOutbox()).toEqual([]);
  });

  it('keeps stale remote reader entities deleted after tombstones', async () => {
    const parsed = parsedNovel('novel-tombstone');
    await saveImportedNovel(parsed);
    const deletedAt = '2026-07-04T00:05:00.000Z';
    const staleAt = '2026-07-04T00:04:00.000Z';
    const events: SyncEvent[] = [
      {
        id: 'bookmark-delete',
        type: 'bookmark_deleted',
        deviceId: 'server',
        novelId: parsed.novel.id,
        entityId: 'bookmark-stale',
        payload: { id: 'bookmark-stale', deletedAt },
        createdAt: deletedAt,
      },
      {
        id: 'bookmark-create-stale',
        type: 'bookmark_created',
        deviceId: 'server',
        novelId: parsed.novel.id,
        entityId: 'bookmark-stale',
        payload: {
          bookmark: {
            id: 'bookmark-stale',
            novelId: parsed.novel.id,
            chapterId: parsed.chapters[0].id,
            label: 'stale bookmark',
            progress: 0.2,
            scrollTop: 10,
            createdAt: staleAt,
          },
        },
        createdAt: staleAt,
      },
      {
        id: 'highlight-delete',
        type: 'highlight_deleted',
        deviceId: 'server',
        novelId: parsed.novel.id,
        entityId: 'highlight-stale',
        payload: { id: 'highlight-stale', deletedAt },
        createdAt: deletedAt,
      },
      {
        id: 'highlight-create-stale',
        type: 'highlight_created',
        deviceId: 'server',
        novelId: parsed.novel.id,
        entityId: 'highlight-stale',
        payload: {
          highlight: {
            id: 'highlight-stale',
            novelId: parsed.novel.id,
            chapterId: parsed.chapters[0].id,
            paragraphId: parsed.paragraphs[0].id,
            quote: 'stale highlight',
            color: 'yellow',
            progress: 0.2,
            createdAt: staleAt,
            updatedAt: staleAt,
          },
        },
        createdAt: staleAt,
      },
      {
        id: 'note-delete',
        type: 'note_deleted',
        deviceId: 'server',
        novelId: parsed.novel.id,
        entityId: 'note-stale',
        payload: { id: 'note-stale', deletedAt },
        createdAt: deletedAt,
      },
      {
        id: 'note-update-stale',
        type: 'note_updated',
        deviceId: 'server',
        novelId: parsed.novel.id,
        entityId: 'note-stale',
        payload: {
          note: {
            id: 'note-stale',
            novelId: parsed.novel.id,
            chapterId: parsed.chapters[0].id,
            body: 'stale note',
            progress: 0.2,
            createdAt: staleAt,
            updatedAt: staleAt,
          },
        },
        createdAt: staleAt,
      },
    ];
    const source: SyncEventSource = {
      async pushSync(localEvents) {
        return { accepted: localEvents.length };
      },
      async pullSync() {
        return { cursor: 30, events };
      },
    };

    await new LocalOutboxSyncService(source).flushPending();

    expect(await getBookmarks(parsed.novel.id)).toEqual([]);
    expect(await getHighlights(parsed.novel.id)).toEqual([]);
    expect(await getNotes(parsed.novel.id)).toEqual([]);
  });
});
