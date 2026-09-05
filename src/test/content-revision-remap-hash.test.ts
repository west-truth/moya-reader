import { describe, expect, it } from 'vitest';
import { hashSync } from '../domain/hash';
import { integrityHash, persistentId128 } from '../domain/id-hash-contract';
import { syncPayloadIntegrityHash } from '../domain/identity/sync-identities';
import type {
  Bookmark,
  Chapter,
  Novel,
  Paragraph,
  ParagraphPage,
  ReaderHighlight,
  ReaderNote,
  ReadingPosition,
} from '../domain/types';
import type { RemoteBookSnapshotStream, SyncOutboxItem } from '../sync/types';
import { SYNC_CONTRACT_V2 } from '../sync/contract';
import { validateV2SyncEvent } from '../sync/event-contract-validation';
import {
  addParagraphPagesToChildIdIndex,
  createBookChildIdIndex,
  prepareRemoteContentActivation,
} from '../storage/content-revision-remote-state';

const now = '2026-07-10T00:00:00.000Z';

function chapter(id: string): Chapter {
  return {
    id,
    novelId: 'book-1',
    index: 1,
    title: 'Chapter 1',
    normalizedText: '',
    textHash: integrityHash('Same paragraph'),
    rawStartOffset: 0,
    rawEndOffset: 14,
    characterCount: 14,
    paragraphCount: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function paragraph(id: string, chapterId: string, textHash: string): Paragraph {
  return {
    id,
    novelId: 'book-1',
    chapterId,
    index: 1,
    text: 'Same paragraph',
    startOffsetInChapter: 0,
    endOffsetInChapter: 14,
    textHash,
  };
}

function page(id: string, value: Paragraph): ParagraphPage {
  return {
    id,
    novelId: 'book-1',
    chapterId: value.chapterId,
    pageIndex: 0,
    startParagraphIndex: 1,
    endParagraphIndex: 1,
    paragraphs: [value],
    textHash: integrityHash(JSON.stringify([integrityHash(value.text)])),
  };
}

function novel(): Novel {
  return {
    id: 'book-1',
    title: 'Book',
    sourceFileName: 'Book.txt',
    rawText: '',
    normalizedText: '',
    rawTextHash: integrityHash('Same paragraph'),
    normalizedTextHash: integrityHash('Same paragraph'),
    createdAt: now,
    updatedAt: now,
    totalChapters: 1,
    totalCharacters: 14,
    totalParagraphs: 1,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0.5,
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
}

describe('remote snapshot child remap hash compatibility', () => {
  it('does not attach a changed remote release anchor to the same numeric position', () => {
    const oldChapter = { ...chapter('release-old'), documentSectionId: 'source-old' };
    const nextChapter = { ...chapter('release-new'), documentSectionId: 'source-new' };
    const oldIndex = createBookChildIdIndex([oldChapter]);
    const nextIndex = createBookChildIdIndex([nextChapter]);
    addParagraphPagesToChildIdIndex(oldIndex, [
      page('old', paragraph('old-p', oldChapter.id, integrityHash('Same paragraph'))),
    ]);
    addParagraphPagesToChildIdIndex(nextIndex, [
      page('new', paragraph('new-p', nextChapter.id, integrityHash('Same paragraph'))),
    ]);
    const result = prepareRemoteContentActivation({
      snapshot: { novel: novel(), chapters: [nextChapter] },
      baseNovel: novel(),
      localSnapshot: {
        bookmarks: [],
        highlights: [],
        notes: [
          {
            id: 'note',
            novelId: 'book-1',
            chapterId: oldChapter.id,
            paragraphId: 'old-p',
            body: 'Keep my annotation',
            progress: 0.5,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      outboxItems: [],
      oldIndex,
      nextIndex,
      now,
    });
    expect(result.readerPlan.deleteNoteIds).toEqual(['note']);
    expect(result.readerPlan.notes).toEqual([]);
    expect(result.readerPlan.quarantineRecords).toEqual([expect.objectContaining({ entityType: 'note' })]);
  });

  it('updates the numeric position when an exact remote paragraph moves after insertion', () => {
    const stableChapter = { ...chapter('release'), documentSectionId: 'source', paragraphCount: 4 };
    const oldIndex = createBookChildIdIndex([stableChapter]);
    const nextIndex = createBookChildIdIndex([stableChapter]);
    const stable = paragraph('unique-p', stableChapter.id, integrityHash('Same paragraph'));
    addParagraphPagesToChildIdIndex(oldIndex, [page('old', stable)]);
    addParagraphPagesToChildIdIndex(nextIndex, [page('next', { ...stable, index: 2 })]);
    const result = prepareRemoteContentActivation({
      snapshot: { novel: novel(), chapters: [stableChapter] },
      baseNovel: novel(),
      localSnapshot: {
        bookmarks: [],
        highlights: [],
        notes: [],
        readingPosition: {
          id: 'position',
          novelId: 'book-1',
          chapterId: stableChapter.id,
          paragraphId: stable.id,
          paragraphIndex: 1,
          offsetInParagraph: 2,
          chapterProgress: 0.25,
          scrollTop: 300,
          deviceId: 'local',
          updatedAt: now,
        },
      },
      outboxItems: [],
      oldIndex,
      nextIndex,
      now,
    });
    expect(result.readerPlan.readingPosition).toMatchObject({
      paragraphId: stable.id,
      paragraphIndex: 2,
      chapterProgress: 0.5,
      scrollTop: 0,
      offsetInParagraph: 2,
    });
    expect(result.readerPlan.quarantineRecords).toEqual([]);
  });

  it('keeps exact fixed-document anchors when a new section is inserted before them', () => {
    const stableChapter = { ...chapter('chapter-stable'), documentSectionId: 'section-stable' };
    const insertedChapter = {
      ...chapter('chapter-inserted'),
      index: 1,
      title: 'Inserted',
      documentSectionId: 'section-inserted',
    };
    const movedStableChapter = { ...stableChapter, index: 2 };
    const stableParagraph = paragraph('paragraph-stable', stableChapter.id, integrityHash('Same paragraph'));
    const insertedParagraph = paragraph('paragraph-inserted', insertedChapter.id, integrityHash('Same paragraph'));
    const oldIndex = createBookChildIdIndex([stableChapter]);
    const nextIndex = createBookChildIdIndex([insertedChapter, movedStableChapter]);
    addParagraphPagesToChildIdIndex(oldIndex, [page('page-stable-old', stableParagraph)]);
    addParagraphPagesToChildIdIndex(nextIndex, [
      page('page-inserted', insertedParagraph),
      page('page-stable-next', stableParagraph),
    ]);
    const readingPosition: ReadingPosition = {
      id: 'reading-position-stable',
      novelId: 'book-1',
      chapterId: stableChapter.id,
      paragraphId: stableParagraph.id,
      paragraphIndex: 1,
      offsetInParagraph: 2,
      chapterProgress: 0.5,
      scrollTop: 20,
      deviceId: 'device-local',
      updatedAt: now,
    };
    const bookmark: Bookmark = {
      id: 'bookmark-stable',
      novelId: 'book-1',
      chapterId: stableChapter.id,
      paragraphId: stableParagraph.id,
      label: 'anchor',
      progress: 0.5,
      scrollTop: 20,
      createdAt: now,
    };
    const highlight: ReaderHighlight = {
      id: 'highlight-stable',
      novelId: 'book-1',
      chapterId: stableChapter.id,
      paragraphId: stableParagraph.id,
      quote: stableParagraph.text,
      color: 'yellow',
      progress: 0.5,
      createdAt: now,
      updatedAt: now,
    };
    const note: ReaderNote = {
      id: 'note-stable',
      novelId: 'book-1',
      chapterId: stableChapter.id,
      paragraphId: stableParagraph.id,
      body: 'note',
      progress: 0.5,
      createdAt: now,
      updatedAt: now,
    };

    const result = prepareRemoteContentActivation({
      snapshot: {
        novel: { ...novel(), totalChapters: 2 },
        chapters: [insertedChapter, movedStableChapter],
      },
      baseNovel: novel(),
      localSnapshot: { readingPosition, bookmarks: [bookmark], highlights: [highlight], notes: [note] },
      outboxItems: [],
      oldIndex,
      nextIndex,
      now,
    });

    expect(result.readerPlan.readingPosition).toMatchObject({
      chapterId: stableChapter.id,
      paragraphId: stableParagraph.id,
    });
    expect(result.readerPlan.bookmarks).toEqual([]);
    expect(result.readerPlan.highlights).toEqual([]);
    expect(result.readerPlan.notes).toEqual([]);
    expect(result.readerPlan.deleteBookmarkIds).toEqual([]);
    expect(result.readerPlan.deleteHighlightIds).toEqual([]);
    expect(result.readerPlan.deleteNoteIds).toEqual([]);
    expect(result.readerPlan.quarantineRecords).toEqual([]);
  });

  it('remaps v1-FNV local anchors to v2-tagged server paragraphs by canonical text', () => {
    const oldChapter = chapter('ch_deadbeef');
    const nextChapter = chapter('chapter_0123456789abcdef0123456789abcdef');
    const oldParagraph = paragraph('p_deadbeef', oldChapter.id, hashSync('Same paragraph'));
    const nextParagraph = paragraph(
      'paragraph_0123456789abcdef0123456789abcdef',
      nextChapter.id,
      integrityHash('Same paragraph'),
    );
    const oldIndex = createBookChildIdIndex([oldChapter]);
    const nextIndex = createBookChildIdIndex([nextChapter]);
    addParagraphPagesToChildIdIndex(oldIndex, [page('page-old', oldParagraph)]);
    addParagraphPagesToChildIdIndex(nextIndex, [page('page-new', nextParagraph)]);

    const readingPosition: ReadingPosition = {
      id: 'reading_position_book-1',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      paragraphIndex: 1,
      offsetInParagraph: 2,
      chapterProgress: 0.5,
      scrollTop: 20,
      deviceId: 'device-local',
      updatedAt: now,
    };
    const bookmark: Bookmark = {
      id: 'bookmark-1',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      label: 'anchor',
      progress: 0.5,
      scrollTop: 20,
      createdAt: now,
    };
    const highlight: ReaderHighlight = {
      id: 'highlight-1',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      quote: oldParagraph.text,
      color: 'yellow',
      progress: 0.5,
      createdAt: now,
      updatedAt: now,
    };
    const note: ReaderNote = {
      id: 'note-1',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      body: 'note',
      progress: 0.5,
      createdAt: now,
      updatedAt: now,
    };
    const outbox: SyncOutboxItem = {
      id: 'outbox-1',
      event: {
        id: 'event-1',
        type: 'bookmark_created',
        deviceId: 'device-local',
        novelId: 'book-1',
        entityId: bookmark.id,
        payload: JSON.parse(JSON.stringify({ bookmark })),
        revision: {
          entityType: 'bookmark',
          entityId: bookmark.id,
          novelId: 'book-1',
          localSequence: 1,
          updatedAt: now,
          payloadHash: hashSync(JSON.stringify({ bookmark })),
        },
        createdAt: now,
      },
      status: 'pending',
      localSequence: 1,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    const snapshot: RemoteBookSnapshotStream = {
      novel: novel(),
      chapters: [nextChapter],
      pageBatches: (async function* () {
        yield [page('page-new', nextParagraph)];
      })(),
    };

    const result = prepareRemoteContentActivation({
      snapshot,
      baseNovel: novel(),
      localSnapshot: { readingPosition, bookmarks: [bookmark], highlights: [highlight], notes: [note] },
      outboxItems: [outbox],
      oldIndex,
      nextIndex,
      now,
    });

    expect(result.readerPlan.readingPosition).toMatchObject({
      chapterId: nextChapter.id,
      paragraphId: nextParagraph.id,
    });
    expect(result.readerPlan.bookmarks[0]).toMatchObject({
      chapterId: nextChapter.id,
      paragraphId: nextParagraph.id,
    });
    expect(result.readerPlan.highlights[0].paragraphId).toBe(nextParagraph.id);
    expect(result.readerPlan.notes[0].paragraphId).toBe(nextParagraph.id);
    expect(result.readerPlan.outboxItems[0].event.payload).toMatchObject({
      bookmark: { chapterId: nextChapter.id, paragraphId: nextParagraph.id },
    });
    expect(result.readerPlan.outboxItems[0].event.revision?.payloadHash).toBe(
      hashSync(JSON.stringify(result.readerPlan.outboxItems[0].event.payload)),
    );
  });

  it('recomputes a remapped v2 revision payload hash with the canonical sync contract', () => {
    const oldChapter = chapter('ch_deadbeef');
    const nextChapter = chapter('chapter_0123456789abcdef0123456789abcdef');
    const oldParagraph = paragraph('p_deadbeef', oldChapter.id, hashSync('Same paragraph'));
    const nextParagraph = paragraph(
      'paragraph_0123456789abcdef0123456789abcdef',
      nextChapter.id,
      integrityHash('Same paragraph'),
    );
    const oldIndex = createBookChildIdIndex([oldChapter]);
    const nextIndex = createBookChildIdIndex([nextChapter]);
    addParagraphPagesToChildIdIndex(oldIndex, [page('page-old', oldParagraph)]);
    addParagraphPagesToChildIdIndex(nextIndex, [page('page-new', nextParagraph)]);

    const bookmark: Bookmark = {
      id: persistentId128('bookmark', ['book-1', 'anchor']),
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      label: 'anchor',
      progress: 0.5,
      scrollTop: 20,
      createdAt: now,
    };
    const payload = JSON.parse(JSON.stringify({ bookmark }));
    const outbox: SyncOutboxItem = {
      id: 'outbox-v2',
      event: {
        ...SYNC_CONTRACT_V2,
        id: persistentId128('sync_event', ['remap-event']),
        type: 'bookmark_created',
        deviceId: 'device-local',
        novelId: 'book-1',
        entityId: bookmark.id,
        payload,
        revision: {
          entityType: 'bookmark',
          entityId: bookmark.id,
          novelId: 'book-1',
          localSequence: 1,
          updatedAt: now,
          payloadHash: syncPayloadIntegrityHash(payload),
        },
        createdAt: now,
      },
      status: 'pending',
      localSequence: 1,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    const snapshot: RemoteBookSnapshotStream = {
      novel: novel(),
      chapters: [nextChapter],
      pageBatches: (async function* () {
        yield [page('page-new', nextParagraph)];
      })(),
    };

    const result = prepareRemoteContentActivation({
      snapshot,
      baseNovel: novel(),
      localSnapshot: { bookmarks: [], highlights: [], notes: [] },
      outboxItems: [outbox],
      oldIndex,
      nextIndex,
      now,
    });

    const remappedEvent = result.readerPlan.outboxItems[0].event;
    expect(remappedEvent.payload).toMatchObject({
      bookmark: { chapterId: nextChapter.id, paragraphId: nextParagraph.id },
    });
    expect(remappedEvent.revision?.payloadHash).toBe(syncPayloadIntegrityHash(remappedEvent.payload));
    expect(remappedEvent.revision?.payloadHash).not.toBe(hashSync(JSON.stringify(remappedEvent.payload)));
    expect(() => validateV2SyncEvent(remappedEvent)).not.toThrow();
  });

  it('re-enqueues sent and sending remaps under fresh pending event identities', () => {
    const oldChapter = chapter('chapter-old');
    const nextChapter = chapter('chapter-old');
    const oldParagraph = paragraph('paragraph-old', oldChapter.id, integrityHash('Same paragraph'));
    const nextParagraph = paragraph('paragraph-old', nextChapter.id, integrityHash('Same paragraph'));
    const oldIndex = createBookChildIdIndex([oldChapter]);
    const nextIndex = createBookChildIdIndex([nextChapter]);
    addParagraphPagesToChildIdIndex(oldIndex, [page('page-old', oldParagraph)]);
    addParagraphPagesToChildIdIndex(nextIndex, [page('page-new', nextParagraph)]);
    const position: ReadingPosition = {
      id: 'reading_position_book-1',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      paragraphIndex: 1,
      offsetInParagraph: 0,
      chapterProgress: 0.5,
      scrollTop: 20,
      deviceId: 'device-local',
      updatedAt: now,
    };
    const bookmark: Bookmark = {
      id: 'bookmark-inflight',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      label: 'In flight',
      progress: 0.5,
      scrollTop: 20,
      createdAt: now,
    };
    const outboxItem = (
      id: string,
      status: SyncOutboxItem['status'],
      type: 'reading_position_updated' | 'bookmark_created',
      entityId: string,
      payload: object,
      localSequence: number,
    ): SyncOutboxItem => {
      const sourceEventTime = '2026-07-09T00:00:00.000Z';
      const jsonPayload = JSON.parse(JSON.stringify(payload));
      return {
        id,
        event: {
          ...SYNC_CONTRACT_V2,
          id: `event-${id}`,
          type,
          deviceId: 'device-local',
          novelId: 'book-1',
          entityId,
          payload: jsonPayload,
          revision: {
            entityType: type === 'reading_position_updated' ? 'reading_position' : 'bookmark',
            entityId,
            novelId: 'book-1',
            localSequence,
            updatedAt: sourceEventTime,
            payloadHash: syncPayloadIntegrityHash(jsonPayload),
          },
          createdAt: sourceEventTime,
        },
        status,
        localSequence,
        attempts: 1,
        leaseToken: status === 'sending' ? 'active-lease' : undefined,
        leaseExpiresAt: status === 'sending' ? '2026-07-10T00:05:00.000Z' : undefined,
        createdAt: sourceEventTime,
        updatedAt: sourceEventTime,
      };
    };
    const sent = outboxItem('outbox-sent', 'sent', 'reading_position_updated', position.id, { position }, 5);
    const sending = outboxItem('outbox-sending', 'sending', 'bookmark_created', bookmark.id, { bookmark }, 6);

    const result = prepareRemoteContentActivation({
      snapshot: { novel: novel(), chapters: [nextChapter] },
      localSnapshot: { bookmarks: [], highlights: [], notes: [] },
      outboxItems: [sent, sending],
      oldIndex,
      nextIndex,
      expectedSyncNextSequence: 8,
      targetContentRevisionId: 'revision-new',
      now,
    });

    expect(result.readerPlan.outboxItems).toHaveLength(2);
    expect(result.readerPlan.outboxItems.map((item) => item.status)).toEqual(['pending', 'pending']);
    expect(result.readerPlan.outboxItems.map((item) => item.localSequence)).toEqual([8, 9]);
    expect(result.readerPlan.outboxItems.map((item) => item.event.revision?.localSequence)).toEqual([8, 9]);
    expect(result.readerPlan.outboxItems.map((item) => item.event.revision?.updatedAt)).toEqual([now, now]);
    expect(result.readerPlan.outboxItems.map((item) => item.event.id)).not.toContain(sent.event.id);
    expect(result.readerPlan.outboxItems.map((item) => item.event.id)).not.toContain(sending.event.id);
    expect(result.readerPlan.outboxItems.map((item) => item.id)).not.toContain(sent.id);
    expect(result.readerPlan.outboxItems.map((item) => item.id)).not.toContain(sending.id);
    expect(result.readerPlan.deleteOutboxItemIds).toEqual([sending.id]);
    expect(result.readerPlan.nextSyncSequence).toBe(10);
    expect(result.readerPlan.quarantineRecords).toContainEqual(
      expect.objectContaining({
        entityType: 'sync_outbox',
        sourceEntityId: sending.id,
        reason: 'content_replaced_inflight_replaced',
      }),
    );
  });

  it('quarantines chapter-only legacy anchors instead of treating the chapter match as exact', () => {
    const oldChapter = chapter('chapter-old');
    const nextChapter = chapter('chapter-new');
    const oldIndex = createBookChildIdIndex([oldChapter]);
    const nextIndex = createBookChildIdIndex([nextChapter]);
    const position: ReadingPosition = {
      id: 'reading_position_book-1',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphIndex: 1,
      offsetInParagraph: 0,
      chapterProgress: 0.5,
      scrollTop: 20,
      deviceId: 'device-local',
      updatedAt: now,
    };
    const bookmark: Bookmark = {
      id: 'bookmark-legacy',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      label: 'Legacy',
      progress: 0.5,
      scrollTop: 20,
      createdAt: now,
    };
    const payload = JSON.parse(JSON.stringify({ bookmark }));
    const sent: SyncOutboxItem = {
      id: 'outbox-legacy',
      event: {
        id: 'event-legacy',
        type: 'bookmark_created',
        deviceId: 'device-local',
        novelId: 'book-1',
        entityId: bookmark.id,
        payload,
        createdAt: now,
      },
      status: 'sent',
      localSequence: 1,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };

    const result = prepareRemoteContentActivation({
      snapshot: { novel: novel(), chapters: [nextChapter] },
      localSnapshot: { readingPosition: position, bookmarks: [bookmark], highlights: [], notes: [] },
      outboxItems: [sent],
      oldIndex,
      nextIndex,
      now,
    });

    expect(result.readerPlan).toMatchObject({
      readingPosition: undefined,
      deleteReadingPosition: true,
      bookmarks: [],
      deleteBookmarkIds: [bookmark.id],
      outboxItems: [],
      deleteOutboxItemIds: [sent.id],
    });
    expect(result.readerPlan.quarantineRecords?.map((record) => record.entityType)).toEqual(
      expect.arrayContaining(['reading_position', 'bookmark', 'sync_outbox']),
    );
  });

  it('keeps a newer remote reading position over an older exact local remap', () => {
    const oldChapter = chapter('chapter-old');
    const nextChapter = chapter('chapter-new');
    const oldParagraph = paragraph('paragraph-old', oldChapter.id, integrityHash('Same paragraph'));
    const nextParagraph = paragraph('paragraph-new', nextChapter.id, integrityHash('Same paragraph'));
    const oldIndex = createBookChildIdIndex([oldChapter]);
    const nextIndex = createBookChildIdIndex([nextChapter]);
    addParagraphPagesToChildIdIndex(oldIndex, [page('page-old', oldParagraph)]);
    addParagraphPagesToChildIdIndex(nextIndex, [page('page-new', nextParagraph)]);
    const localPosition: ReadingPosition = {
      id: 'reading_position_book-1',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      paragraphIndex: 1,
      offsetInParagraph: 0,
      chapterProgress: 0.2,
      scrollTop: 20,
      deviceId: 'device-local',
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    const remotePosition: ReadingPosition = {
      ...localPosition,
      chapterId: nextChapter.id,
      paragraphId: nextParagraph.id,
      chapterProgress: 0.9,
      scrollTop: 900,
      deviceId: 'device-remote',
      updatedAt: '2026-07-11T00:00:00.000Z',
    };

    const result = prepareRemoteContentActivation({
      snapshot: { novel: novel(), chapters: [nextChapter], readingPosition: remotePosition },
      localSnapshot: { readingPosition: localPosition, bookmarks: [], highlights: [], notes: [] },
      outboxItems: [],
      oldIndex,
      nextIndex,
      now,
    });

    expect(result.readerPlan.readingPosition).toEqual(remotePosition);
    expect(result.novel).toMatchObject({
      lastReadChapterId: nextChapter.id,
      lastReadParagraphId: nextParagraph.id,
      lastReadOffset: 900,
      lastReadProgress: 0.9,
    });
  });

  it('quarantines reader rows and outbox entries when the replacement anchor is not exact', () => {
    const oldChapter = chapter('chapter-old');
    const nextChapter = chapter('chapter-new');
    const oldParagraph = paragraph('paragraph-old', oldChapter.id, integrityHash('Old paragraph'));
    const nextParagraph = {
      ...paragraph('paragraph-new', nextChapter.id, integrityHash('Changed paragraph')),
      text: 'Changed paragraph',
    };
    const oldIndex = createBookChildIdIndex([oldChapter]);
    const nextIndex = createBookChildIdIndex([nextChapter]);
    addParagraphPagesToChildIdIndex(oldIndex, [page('page-old', oldParagraph)]);
    addParagraphPagesToChildIdIndex(nextIndex, [page('page-new', nextParagraph)]);
    const readingPosition: ReadingPosition = {
      id: 'reading_position_book-1',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      paragraphIndex: 1,
      offsetInParagraph: 0,
      chapterProgress: 0.4,
      scrollTop: 10,
      deviceId: 'device-local',
      updatedAt: now,
    };
    const bookmark: Bookmark = {
      id: 'bookmark-unmatched',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      label: 'Unmatched',
      progress: 0.4,
      scrollTop: 10,
      createdAt: now,
    };
    const highlight: ReaderHighlight = {
      id: 'highlight-unmatched',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      quote: oldParagraph.text,
      color: 'yellow',
      progress: 0.4,
      createdAt: now,
      updatedAt: now,
    };
    const note: ReaderNote = {
      id: 'note-unmatched',
      novelId: 'book-1',
      chapterId: oldChapter.id,
      paragraphId: oldParagraph.id,
      body: 'Unmatched',
      progress: 0.4,
      createdAt: now,
      updatedAt: now,
    };
    const outbox: SyncOutboxItem = {
      id: 'outbox-unmatched',
      event: {
        id: 'event-unmatched',
        type: 'bookmark_created',
        deviceId: 'device-local',
        novelId: 'book-1',
        entityId: bookmark.id,
        payload: JSON.parse(JSON.stringify({ bookmark })),
        createdAt: now,
      },
      status: 'pending',
      localSequence: 1,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };

    const result = prepareRemoteContentActivation({
      snapshot: { novel: novel(), chapters: [nextChapter] },
      baseNovel: novel(),
      localSnapshot: { readingPosition, bookmarks: [bookmark], highlights: [highlight], notes: [note] },
      outboxItems: [outbox],
      oldIndex,
      nextIndex,
      sourceContentRevisionId: 'revision-old',
      targetContentRevisionId: 'revision-new',
      now,
    });

    expect(result.readerPlan).toMatchObject({
      readingPosition: undefined,
      deleteReadingPosition: true,
      deleteBookmarkIds: [bookmark.id],
      deleteHighlightIds: [highlight.id],
      deleteNoteIds: [note.id],
      deleteOutboxItemIds: [outbox.id],
    });
    expect(result.readerPlan.quarantineRecords).toEqual(
      expect.arrayContaining(
        ['reading_position', 'bookmark', 'highlight', 'note', 'sync_outbox'].map((entityType) =>
          expect.objectContaining({ entityType, targetContentRevisionId: 'revision-new' }),
        ),
      ),
    );
  });
});
