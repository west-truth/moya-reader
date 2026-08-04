import { beforeEach, describe, expect, it } from 'vitest';
import type { ParsedNovel, Paragraph, ParagraphPage } from '../domain/types';
import { PARAGRAPHS_PER_PAGE } from '../repositories/reader-defaults';
import type { BulkBookSource, ReaderQueries } from '../repositories/reader-repository';
import { READER_SEARCH_MAX_PAGE_SIZE, readerSearchHardLimit } from '../repositories/reader-query-contract';

export interface ReaderQueryContractContext {
  readonly source: ReaderQueries & BulkBookSource;
  readonly parsed: ParsedNovel;
  readonly pages: ParagraphPage[];
}

type ReaderQueryContractSetup = () => Promise<ReaderQueryContractContext>;

const now = '2026-07-10T00:00:00.000Z';

export function createReaderQueryContractNovel(): ParsedNovel {
  const novelId = 'reader-query-contract-book';
  const chapterParagraphCounts = [210, 120];
  const chapters: ParsedNovel['chapters'] = [];
  const paragraphs: Paragraph[] = [];
  let bookOffset = 0;
  for (let chapterOffset = 0; chapterOffset < chapterParagraphCounts.length; chapterOffset += 1) {
    const chapterIndex = chapterOffset + 1;
    const chapterId = `${novelId}:chapter:${chapterIndex}`;
    const paragraphCount = chapterParagraphCounts[chapterOffset];
    const chapterParagraphs = Array.from({ length: paragraphCount }, (_, offset) => {
      const index = offset + 1;
      const text = `contract needle chapter ${chapterIndex} paragraph ${index}`;
      return {
        id: `${chapterId}:paragraph:${index}`,
        novelId,
        chapterId,
        index,
        text,
        startOffsetInChapter: offset * 64,
        endOffsetInChapter: offset * 64 + text.length,
        textHash: `hash-${chapterIndex}-${index}`,
      } satisfies Paragraph;
    });
    const characterCount = chapterParagraphs.reduce((total, paragraph) => total + paragraph.text.length, 0);
    paragraphs.push(...chapterParagraphs);
    chapters.push({
      id: chapterId,
      novelId,
      index: chapterIndex,
      title: `${chapterIndex}화`,
      normalizedText: '',
      textHash: `chapter-hash-${chapterIndex}`,
      rawStartOffset: bookOffset,
      rawEndOffset: bookOffset + characterCount,
      characterCount,
      paragraphCount,
      createdAt: now,
      updatedAt: now,
    });
    bookOffset += characterCount;
  }
  return {
    novel: {
      id: novelId,
      title: 'Reader query contract book',
      sourceFileName: 'reader-query-contract.txt',
      sourceEncoding: 'utf-8',
      rawText: '',
      normalizedText: '',
      rawTextHash: 'raw-hash',
      normalizedTextHash: 'normalized-hash',
      createdAt: now,
      updatedAt: now,
      totalChapters: chapters.length,
      totalCharacters: bookOffset,
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

export function paragraphPagesFromParsed(parsed: ParsedNovel): ParagraphPage[] {
  return parsed.chapters.flatMap((chapter) => {
    const paragraphs = parsed.paragraphs.filter((paragraph) => paragraph.chapterId === chapter.id);
    const pages: ParagraphPage[] = [];
    for (let offset = 0; offset < paragraphs.length; offset += PARAGRAPHS_PER_PAGE) {
      const pageParagraphs = paragraphs.slice(offset, offset + PARAGRAPHS_PER_PAGE);
      const pageIndex = Math.floor(offset / PARAGRAPHS_PER_PAGE);
      pages.push({
        id: `${chapter.id}:page:${pageIndex}`,
        novelId: parsed.novel.id,
        chapterId: chapter.id,
        pageIndex,
        startParagraphIndex: pageParagraphs[0].index,
        endParagraphIndex: pageParagraphs[pageParagraphs.length - 1].index,
        paragraphs: pageParagraphs,
        textHash: `page-hash-${chapter.index}-${pageIndex}`,
      });
    }
    return pages;
  });
}

async function collectSearchPages(
  source: ReaderQueries,
  request:
    | {
        readonly scope: 'chapter';
        readonly chapterId: string;
        readonly query: string;
        readonly signal: AbortSignal;
      }
    | {
        readonly scope: 'book';
        readonly novelId: string;
        readonly query: string;
        readonly signal: AbortSignal;
      },
): Promise<{ paragraphs: Paragraph[]; capped: boolean }> {
  const paragraphs: Paragraph[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  while (paragraphs.length <= readerSearchHardLimit(request.scope)) {
    const page = await source.searchParagraphPage(
      request.scope === 'chapter'
        ? { ...request, cursor, pageSize: READER_SEARCH_MAX_PAGE_SIZE }
        : { ...request, cursor, pageSize: READER_SEARCH_MAX_PAGE_SIZE },
    );
    paragraphs.push(...page.paragraphs);
    if (!page.nextCursor) return { paragraphs, capped: page.capped };
    expect(cursors.has(page.nextCursor)).toBe(false);
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Reader search contract exceeded its hard limit without terminating.');
}

export function readerQueryContract(name: string, setup: ReaderQueryContractSetup): void {
  describe(name, () => {
    let context: ReaderQueryContractContext;

    beforeEach(async () => {
      context = await setup();
    });

    it('reads bounded pages and streams all chapter pages in order', async () => {
      const chapter = context.parsed.chapters[0];
      const secondPage = await context.source.getParagraphPage(chapter.id, 1);
      expect(secondPage?.pageIndex).toBe(1);
      expect(secondPage?.paragraphs[0].index).toBe(PARAGRAPHS_PER_PAGE + 1);

      const streamed: ParagraphPage[] = [];
      const signal = new AbortController().signal;
      for await (const page of context.source.iterateParagraphPages({ chapterId: chapter.id, signal })) {
        streamed.push(page);
      }
      expect(streamed.map((page) => page.pageIndex)).toEqual(
        context.pages.filter((page) => page.chapterId === chapter.id).map((page) => page.pageIndex),
      );
      expect(streamed.flatMap((page) => page.paragraphs).map((paragraph) => paragraph.id)).toEqual(
        context.parsed.paragraphs
          .filter((paragraph) => paragraph.chapterId === chapter.id)
          .map((paragraph) => paragraph.id),
      );
    });

    it('uses stable cursors without duplicate chapter results', async () => {
      const chapter = context.parsed.chapters[0];
      const signal = new AbortController().signal;
      const first = await context.source.searchParagraphPage({
        scope: 'chapter',
        chapterId: chapter.id,
        query: 'needle',
        pageSize: 17,
        signal,
      });
      expect(first.paragraphs).toHaveLength(17);
      expect(first.nextCursor).toBeTypeOf('string');
      const second = await context.source.searchParagraphPage({
        scope: 'chapter',
        chapterId: chapter.id,
        query: 'needle',
        cursor: first.nextCursor,
        pageSize: 17,
        signal,
      });
      expect(second.paragraphs).toHaveLength(17);
      expect(new Set([...first.paragraphs, ...second.paragraphs].map((paragraph) => paragraph.id)).size).toBe(34);
      expect(second.paragraphs[0].index).toBe(18);
    });

    it('enforces chapter and book hard limits across pages', async () => {
      const chapter = context.parsed.chapters[0];
      const chapterResult = await collectSearchPages(context.source, {
        scope: 'chapter',
        chapterId: chapter.id,
        query: 'needle',
        signal: new AbortController().signal,
      });
      const bookResult = await collectSearchPages(context.source, {
        scope: 'book',
        novelId: context.parsed.novel.id,
        query: 'needle',
        signal: new AbortController().signal,
      });
      expect(chapterResult.paragraphs).toHaveLength(readerSearchHardLimit('chapter'));
      expect(chapterResult.capped).toBe(true);
      expect(bookResult.paragraphs).toHaveLength(readerSearchHardLimit('book'));
      expect(bookResult.capped).toBe(true);
      expect(new Set(bookResult.paragraphs.map((paragraph) => paragraph.id)).size).toBe(bookResult.paragraphs.length);
    });

    it('rejects cancelled page and bulk reads', async () => {
      const chapterId = context.parsed.chapters[0].id;
      const searchController = new AbortController();
      searchController.abort();
      await expect(
        context.source.searchParagraphPage({
          scope: 'chapter',
          chapterId,
          query: 'needle',
          signal: searchController.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });

      const bulkController = new AbortController();
      const iterable = context.source.iterateParagraphPages({ chapterId, signal: bulkController.signal });
      const iterator = iterable[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ done: false });
      bulkController.abort();
      await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
}
