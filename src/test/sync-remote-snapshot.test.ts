import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { integrityHash } from '../domain/id-hash-contract';
import type { Paragraph, ParagraphPage, ParsedNovel } from '../domain/types';
import {
  applyRemoteSyncEvents,
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
