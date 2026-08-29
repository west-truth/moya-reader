import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedNovel } from '../domain/types';
import { READER_SEARCH_SCAN_ROW_BUDGET, READER_SEARCH_SCAN_TEXT_BUDGET } from '../repositories/reader-query-contract';
import { resetReaderDbForTests, saveImportedNovel } from '../storage/db';
import { searchParagraphPage } from '../storage/reader-query-store';

const FIXTURE_BYTES = 20 * 1024 * 1024;
const PARAGRAPH_COUNT = 320;

function singleChapterFixture(): ParsedNovel {
  const now = '2026-07-10T00:00:00.000Z';
  const novelId = 'reader-search-20mib';
  const chapterId = `${novelId}:chapter:1`;
  const charactersPerParagraph = Math.ceil(FIXTURE_BYTES / PARAGRAPH_COUNT);
  const paragraphs = Array.from({ length: PARAGRAPH_COUNT }, (_, offset) => {
    const index = offset + 1;
    const marker = `storage-budget-row-${index} `;
    const text = `${marker}${'x'.repeat(Math.max(0, charactersPerParagraph - marker.length))}`;
    return {
      id: `${chapterId}:paragraph:${index}`,
      novelId,
      chapterId,
      index,
      text,
      startOffsetInChapter: offset * charactersPerParagraph,
      endOffsetInChapter: offset * charactersPerParagraph + text.length,
      textHash: `paragraph-hash-${index}`,
    };
  });
  const totalCharacters = paragraphs.reduce((total, paragraph) => total + paragraph.text.length, 0);
  return {
    novel: {
      id: novelId,
      title: '20 MiB reader search fixture',
      sourceFileName: 'reader-search-20mib.txt',
      sourceEncoding: 'utf-8',
      rawText: '',
      normalizedText: '',
      rawTextHash: 'raw-hash',
      normalizedTextHash: 'normalized-hash',
      createdAt: now,
      updatedAt: now,
      totalChapters: 1,
      totalCharacters,
      totalParagraphs: paragraphs.length,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters: [
      {
        id: chapterId,
        novelId,
        index: 1,
        title: '1화',
        normalizedText: '',
        textHash: 'chapter-hash',
        rawStartOffset: 0,
        rawEndOffset: totalCharacters,
        characterCount: totalCharacters,
        paragraphCount: paragraphs.length,
        createdAt: now,
        updatedAt: now,
      },
    ],
    paragraphs,
  };
}

describe('reader search storage performance', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('bounds a 20 MiB single-chapter cursor scan and aborts the active IDB transaction promptly', async () => {
    const parsed = singleChapterFixture();
    expect(parsed.novel.totalCharacters).toBeGreaterThanOrEqual(FIXTURE_BYTES);
    await saveImportedNovel(parsed, { batchPageCount: 4 });
    const getAllSpy = vi.spyOn(IDBIndex.prototype, 'getAll');

    const page = await searchParagraphPage({
      scope: 'chapter',
      chapterId: parsed.chapters[0].id,
      query: 'not-present-in-the-fixture',
      pageSize: 10,
      signal: new AbortController().signal,
    });

    const maxParagraphLength = parsed.paragraphs[0].text.length;
    expect(page.paragraphs).toEqual([]);
    expect(page.nextCursor).toBeTypeOf('string');
    expect(page.scannedRows).toBeLessThanOrEqual(READER_SEARCH_SCAN_ROW_BUDGET);
    expect(page.scannedTextCharacters).toBeLessThanOrEqual(READER_SEARCH_SCAN_TEXT_BUDGET + maxParagraphLength);
    expect(getAllSpy).not.toHaveBeenCalled();

    const abortParsed = singleChapterFixture();
    abortParsed.paragraphs = abortParsed.paragraphs.map((paragraph) => ({
      ...paragraph,
      text: `abort-cursor-row-${paragraph.index}`,
      textHash: `abort-paragraph-hash-${paragraph.index}`,
    }));
    abortParsed.novel.totalCharacters = abortParsed.paragraphs.reduce(
      (total, paragraph) => total + paragraph.text.length,
      0,
    );
    abortParsed.chapters[0].characterCount = abortParsed.novel.totalCharacters;
    await saveImportedNovel(abortParsed, { batchPageCount: 4 });

    const controller = new AbortController();
    const transactionAbortSpy = vi.spyOn(IDBTransaction.prototype, 'abort');
    const cursorContinueSpy = vi.spyOn(IDBCursor.prototype, 'continue').mockImplementation(() => {
      controller.abort();
    });
    const startedAt = performance.now();
    try {
      await expect(
        searchParagraphPage({
          scope: 'chapter',
          chapterId: parsed.chapters[0].id,
          query: 'still-not-present',
          pageSize: 10,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(transactionAbortSpy).toHaveBeenCalled();
    } finally {
      cursorContinueSpy.mockRestore();
      transactionAbortSpy.mockRestore();
      getAllSpy.mockRestore();
    }
  }, 30_000);
});
