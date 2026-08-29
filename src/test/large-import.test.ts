import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParsedNovel } from '../domain/types';
import {
  getChapters,
  getActiveContentRevisionDiagnostics,
  getNovel,
  getParagraph,
  getParagraphPages,
  openReaderDb,
  PARAGRAPHS_PER_PAGE,
  resetReaderDbForTests,
  saveImportedNovel,
  searchBookParagraphs,
  searchParagraphs,
} from '../storage/db';

function syntheticLargeParsedNovel(chapterCount: number, paragraphsPerChapter: number): ParsedNovel {
  const now = '2026-07-05T00:00:00.000Z';
  const novelId = 'synthetic-large';
  const chapters: ParsedNovel['chapters'] = [];
  const paragraphs: ParsedNovel['paragraphs'] = [];

  for (let chapterIndex = 1; chapterIndex <= chapterCount; chapterIndex += 1) {
    const chapterId = `${novelId}:chapter:${chapterIndex}`;
    const chapterParagraphs = Array.from({ length: paragraphsPerChapter }, (_, index) => {
      const paragraphIndex = index + 1;
      const marker = `marker-${chapterIndex}-${paragraphIndex}`;
      const text = `${marker} ${'대용량 저장 회귀 테스트 문단입니다. '.repeat(8)}${chapterIndex}/${paragraphIndex}`;
      return {
        id: `${chapterId}:paragraph:${paragraphIndex}`,
        novelId,
        chapterId,
        index: paragraphIndex,
        text,
        startOffsetInChapter: index * 100,
        endOffsetInChapter: index * 100 + text.length,
        textHash: `${chapterId}:paragraph:${paragraphIndex}:hash`,
      };
    });
    paragraphs.push(...chapterParagraphs);
    chapters.push({
      id: chapterId,
      novelId,
      index: chapterIndex,
      title: `${chapterIndex}화 대용량 테스트`,
      normalizedText: chapterParagraphs.map((paragraph) => paragraph.text).join('\n\n'),
      textHash: `${chapterId}:hash`,
      rawStartOffset: chapterIndex * 100_000,
      rawEndOffset:
        chapterIndex * 100_000 + chapterParagraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
      characterCount: chapterParagraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
      paragraphCount: chapterParagraphs.length,
      createdAt: now,
      updatedAt: now,
    });
  }

  const totalCharacters = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
  return {
    novel: {
      id: novelId,
      title: 'Synthetic Large Novel',
      sourceFileName: 'synthetic-large.txt',
      sourceEncoding: 'utf-8',
      rawText: 'raw text should not be persisted',
      normalizedText: 'normalized text should not be persisted',
      rawTextHash: `${novelId}:raw`,
      normalizedTextHash: `${novelId}:normalized`,
      createdAt: now,
      updatedAt: now,
      totalChapters: chapters.length,
      totalCharacters,
      totalParagraphs: paragraphs.length,
      coverSeed: 1,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters,
    paragraphs,
  };
}

describe('large import storage regression', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('stores synthetic large imports as metadata plus paragraph pages', async () => {
    const chapterCount = 6;
    const paragraphsPerChapter = PARAGRAPHS_PER_PAGE + 15;
    const parsed = syntheticLargeParsedNovel(chapterCount, paragraphsPerChapter);
    const progress: number[] = [];

    await saveImportedNovel(parsed, {
      batchPageCount: 2,
      onProgress: (next) => {
        progress.push(next.paragraphsWritten);
      },
    });

    const storedNovel = await getNovel(parsed.novel.id);
    const chapters = await getChapters(parsed.novel.id);
    const lateChapterId = `${parsed.novel.id}:chapter:${chapterCount}`;
    const latePages = await getParagraphPages(lateChapterId);
    const lateParagraph = await getParagraph(`${lateChapterId}:paragraph:${paragraphsPerChapter}`);
    const searchMatches = await searchBookParagraphs(
      parsed.novel.id,
      `marker-${chapterCount}-${paragraphsPerChapter}`,
      5,
    );
    const diagnostics = await getActiveContentRevisionDiagnostics(parsed.novel.id);
    const paragraphRefs = diagnostics.paragraphRefs;
    const pages = diagnostics.paragraphPages;
    const searchRows = diagnostics.paragraphSearchRows;
    const db = await openReaderDb();
    const headCount = await new Promise<number>((resolve, reject) => {
      const request = db
        .transaction('book_content_domain_heads', 'readonly')
        .objectStore('book_content_domain_heads')
        .index('novelId')
        .count(parsed.novel.id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    expect(storedNovel).toMatchObject({ rawText: '', normalizedText: '' });
    expect(chapters).toHaveLength(chapterCount);
    expect(chapters.every((chapter) => chapter.normalizedText === '')).toBe(true);
    expect(latePages).toHaveLength(2);
    expect(lateParagraph?.text).toContain(`marker-${chapterCount}-${paragraphsPerChapter}`);
    expect(searchMatches.map((paragraph) => paragraph.id)).toEqual([
      `${lateChapterId}:paragraph:${paragraphsPerChapter}`,
    ]);
    expect(paragraphRefs).toHaveLength(0);
    expect(pages).toHaveLength(chapterCount * 2);
    expect(searchRows).toHaveLength(0);
    expect(headCount).toBe(chapterCount);
    expect(progress.at(-1)).toBe(parsed.paragraphs.length);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('searches page-canonical paragraph rows without materializing every page through getAll', async () => {
    const parsed = syntheticLargeParsedNovel(1, PARAGRAPHS_PER_PAGE * 3);
    await saveImportedNovel(parsed, { batchPageCount: 1 });
    const objectStoreGetAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const indexGetAll = vi.spyOn(IDBIndex.prototype, 'getAll');

    const matches = await searchParagraphs(`${parsed.novel.id}:chapter:1`, 'marker-1-1', 1);
    const paragraph = await getParagraph(`${parsed.novel.id}:chapter:1:paragraph:1`);

    expect(matches.map((paragraph) => paragraph.id)).toEqual([`${parsed.novel.id}:chapter:1:paragraph:1`]);
    expect(paragraph?.text).toContain('marker-1-1');
    expect(objectStoreGetAll).not.toHaveBeenCalled();
    expect(indexGetAll).not.toHaveBeenCalled();
    objectStoreGetAll.mockRestore();
    indexGetAll.mockRestore();
  });
});
