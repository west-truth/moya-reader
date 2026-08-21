import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ParsedNovel } from '../domain/types';
import * as readerDb from '../storage/db';
import * as readerStateStore from '../storage/reader-state-store';

function readerFixture(): ParsedNovel {
  const now = '2026-07-10T00:00:00.000Z';
  return {
    novel: {
      id: 'reader-state-book',
      title: 'Reader state book',
      sourceFileName: 'reader-state.txt',
      sourceEncoding: 'utf-8',
      rawText: 'Chapter 1\n\nParagraph',
      normalizedText: 'Chapter 1\n\nParagraph',
      rawTextHash: 'reader-state:raw',
      normalizedTextHash: 'reader-state:normalized',
      createdAt: now,
      updatedAt: now,
      totalChapters: 1,
      totalCharacters: 9,
      totalParagraphs: 1,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters: [
      {
        id: 'reader-state-chapter',
        novelId: 'reader-state-book',
        index: 1,
        title: 'Chapter 1',
        normalizedText: 'Paragraph',
        textHash: 'reader-state:chapter',
        rawStartOffset: 0,
        rawEndOffset: 9,
        characterCount: 9,
        paragraphCount: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    paragraphs: [
      {
        id: 'reader-state-paragraph',
        novelId: 'reader-state-book',
        chapterId: 'reader-state-chapter',
        index: 1,
        text: 'Paragraph',
        startOffsetInChapter: 0,
        endOffsetInChapter: 9,
        textHash: 'reader-state:paragraph',
      },
    ],
  };
}

describe('reader state store', () => {
  beforeEach(async () => {
    await readerDb.resetReaderDbForTests();
  });

  it('keeps the db compatibility facade bound to the reader state module', () => {
    expect(readerDb.getSettings).toBe(readerStateStore.getSettings);
    expect(readerDb.saveSettings).toBe(readerStateStore.saveSettings);
    expect(readerDb.saveReadingPosition).toBe(readerStateStore.saveReadingPosition);
    expect(readerDb.getReadingPosition).toBe(readerStateStore.getReadingPosition);
  });

  it('persists settings, reading progress, and local-only reading time with existing sync semantics', async () => {
    await readerDb.saveImportedNovel(readerFixture());
    await readerStateStore.saveSettings({ ...readerDb.defaultSettings, fontSize: 21 });
    await readerStateStore.saveReadingPosition({
      novelId: 'reader-state-book',
      chapterId: 'reader-state-chapter',
      scrollTop: 120.4,
      chapterProgress: 0.6,
      paragraphId: 'reader-state-paragraph',
      paragraphIndex: 1,
      offsetInParagraph: 2,
    });
    await readerStateStore.addNovelReadingTime('reader-state-book', 12.9, '2026-07-10T00:10:00.000Z');

    expect(await readerStateStore.getSettings()).toMatchObject({ fontSize: 21 });
    expect(await readerStateStore.getReadingPosition('reader-state-book')).toMatchObject({
      paragraphIndex: 1,
      offsetInParagraph: 2,
      chapterProgress: 0.6,
      scrollTop: 120,
    });
    expect(await readerDb.getNovel('reader-state-book')).toMatchObject({
      readingSeconds: 12,
      lastReadAt: '2026-07-10T00:10:00.000Z',
    });
    expect((await readerDb.listSyncOutbox()).map((item) => item.event.type)).toEqual([
      'book_imported',
      'settings_updated',
      'reading_position_updated',
    ]);
  });

  it('patches metadata without overwriting newer content or reader state', async () => {
    await readerDb.saveImportedNovel(readerFixture());
    const before = await readerDb.getNovel('reader-state-book');
    await readerStateStore.saveReadingPosition({
      novelId: 'reader-state-book',
      chapterId: 'reader-state-chapter',
      scrollTop: 180,
      chapterProgress: 0.8,
      paragraphId: 'reader-state-paragraph',
      paragraphIndex: 1,
    });
    await readerStateStore.addNovelReadingTime('reader-state-book', 21, '2026-07-10T00:15:00.000Z');

    await readerStateStore.patchNovelMetadata('reader-state-book', {
      title: 'Renamed reader state book',
      favorite: true,
      analysisStatus: 'ready',
    });

    expect(await readerDb.getNovel('reader-state-book')).toMatchObject({
      title: 'Renamed reader state book',
      favorite: true,
      analysisStatus: 'ready',
      normalizedTextHash: before?.normalizedTextHash,
      activeContentRevisionId: before?.activeContentRevisionId,
      lastReadChapterId: 'reader-state-chapter',
      lastReadChapterIndex: 1,
      lastReadParagraphId: 'reader-state-paragraph',
      lastReadOffset: 180,
      lastReadProgress: 0.8,
      readingSeconds: 21,
      lastReadAt: '2026-07-10T00:15:00.000Z',
    });
    const metadataEvent = (await readerDb.listSyncOutbox()).at(-1)?.event;
    expect(metadataEvent?.type).toBe('book_updated');
    expect(metadataEvent?.payload).toMatchObject({
      novel: {
        id: 'reader-state-book',
        title: 'Renamed reader state book',
        favorite: true,
        analysisStatus: 'ready',
      },
    });
    expect(JSON.stringify(metadataEvent?.payload)).not.toContain('normalizedTextHash');
  });

  it('applies synced analysis status without replacing unrelated local metadata', async () => {
    await readerDb.saveImportedNovel(readerFixture());
    await readerStateStore.patchNovelMetadata('reader-state-book', { favorite: true });

    await readerDb.applyRemoteSyncEvents([
      {
        id: 'event-book-analysis-ready',
        type: 'book_updated',
        deviceId: 'remote-device',
        novelId: 'reader-state-book',
        entityId: 'reader-state-book',
        payload: { analysisStatus: 'ready' },
        createdAt: '2026-07-10T00:20:00.000Z',
      },
    ]);

    expect(await readerDb.getNovel('reader-state-book')).toMatchObject({
      title: 'Reader state book',
      favorite: true,
      analysisStatus: 'ready',
    });
  });

  it('merges progress into a concurrent reading-time update without adding a sync event for time', async () => {
    await readerDb.saveImportedNovel(readerFixture());

    await Promise.all([
      readerStateStore.saveReadingPosition({
        novelId: 'reader-state-book',
        chapterId: 'reader-state-chapter',
        scrollTop: 240,
        chapterProgress: 0.75,
        paragraphId: 'reader-state-paragraph',
        paragraphIndex: 1,
        offsetInParagraph: 4,
      }),
      readerStateStore.addNovelReadingTime('reader-state-book', 18, '2026-07-10T00:20:00.000Z'),
    ]);

    expect(await readerDb.getNovel('reader-state-book')).toMatchObject({
      lastReadChapterId: 'reader-state-chapter',
      lastReadChapterIndex: 1,
      lastReadParagraphId: 'reader-state-paragraph',
      lastReadOffset: 240,
      lastReadProgress: 0.75,
      readingSeconds: 18,
      lastReadAt: '2026-07-10T00:20:00.000Z',
    });
    expect((await readerDb.listSyncOutbox()).map((item) => item.event.type)).toEqual([
      'book_imported',
      'reading_position_updated',
    ]);
  });

  it('clears progress without overwriting a concurrent reading-time update', async () => {
    await readerDb.saveImportedNovel(readerFixture());
    await readerStateStore.saveReadingPosition({
      novelId: 'reader-state-book',
      chapterId: 'reader-state-chapter',
      scrollTop: 120,
      chapterProgress: 0.5,
      paragraphId: 'reader-state-paragraph',
      paragraphIndex: 1,
    });

    await Promise.all([
      readerStateStore.clearReadingPosition('reader-state-book'),
      readerStateStore.addNovelReadingTime('reader-state-book', 9, '2026-07-10T00:30:00.000Z'),
    ]);

    expect(await readerDb.getNovel('reader-state-book')).toMatchObject({
      lastReadChapterId: undefined,
      lastReadChapterIndex: undefined,
      lastReadParagraphId: undefined,
      lastReadOffset: 0,
      lastReadProgress: 0,
      readingSeconds: 9,
      lastReadAt: '2026-07-10T00:30:00.000Z',
    });
    expect(await readerStateStore.getReadingPosition('reader-state-book')).toBeUndefined();
    expect((await readerDb.listSyncOutbox()).map((item) => item.event.type)).toEqual([
      'book_imported',
      'reading_position_updated',
      'reading_position_deleted',
    ]);
  });
});
