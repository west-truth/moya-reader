import { afterEach, vi } from 'vitest';
import type { Paragraph } from '../domain/types';
import {
  decodeReaderSearchCursor,
  encodeReaderSearchCursor,
  normalizedReaderSearchText,
  readerSearchHardLimit,
} from '../repositories/reader-query-contract';
import { RemoteReaderRepository } from '../repositories/remote-reader-repository';
import { RemoteApiClient } from '../services/remote/remote-api-client';
import {
  createReaderQueryContractNovel,
  paragraphPagesFromParsed,
  readerQueryContract,
} from './reader-query-contract-suite';

afterEach(() => {
  vi.restoreAllMocks();
});

readerQueryContract('RemoteReaderRepository reader query contract', async () => {
  const parsed = createReaderQueryContractNovel();
  const pages = paragraphPagesFromParsed(parsed);
  const chapterIndex = new Map(parsed.chapters.map((chapter) => [chapter.id, chapter.index]));
  const contentRevisionId = 'reader-query-contract-content-r1';

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const url = new URL(String(input));
    const pageMatch = url.pathname.match(/^\/chapters\/([^/]+)\/pages$/);
    if (pageMatch) {
      const chapterId = decodeURIComponent(pageMatch[1]);
      const from = Number(url.searchParams.get('from') ?? 0);
      const count = Number(url.searchParams.get('count') ?? 5);
      const selected = pages
        .filter((page) => page.chapterId === chapterId && page.pageIndex >= from)
        .slice(0, count)
        .map((page) => ({
          id: page.id,
          book_id: page.novelId,
          chapter_id: page.chapterId,
          page_index: page.pageIndex,
          start_paragraph_index: page.startParagraphIndex,
          end_paragraph_index: page.endParagraphIndex,
          paragraphs: page.paragraphs,
          text_hash: page.textHash,
        }));
      return Response.json({ pages: selected, contentRevisionId });
    }

    const chapterMatch = url.pathname.match(/^\/chapters\/([^/]+)$/);
    if (chapterMatch) {
      const chapterId = decodeURIComponent(chapterMatch[1]);
      const chapter = parsed.chapters.find((candidate) => candidate.id === chapterId);
      if (!chapter) return new Response('not found', { status: 404 });
      return Response.json({
        chapter: {
          id: chapter.id,
          book_id: chapter.novelId,
          chapter_index: chapter.index,
          title: chapter.title,
          text_hash: chapter.textHash,
          raw_start_offset: chapter.rawStartOffset,
          raw_end_offset: chapter.rawEndOffset,
          character_count: chapter.characterCount,
          paragraph_count: chapter.paragraphCount,
          created_at: chapter.createdAt,
          updated_at: chapter.updatedAt,
        },
        contentRevisionId,
      });
    }

    const chapterSearch = url.pathname.match(/^\/chapters\/([^/]+)\/search$/);
    const bookSearch = url.pathname.match(/^\/books\/([^/]+)\/search$/);
    if (!chapterSearch && !bookSearch) return new Response('not found', { status: 404 });
    const scope = chapterSearch ? 'chapter' : 'book';
    const targetId = decodeURIComponent((chapterSearch ?? bookSearch)?.[1] ?? '');
    const query = normalizedReaderSearchText(url.searchParams.get('query') ?? '');
    const cursor = decodeReaderSearchCursor(url.searchParams.get('cursor') ?? undefined, {
      scope,
      targetId,
      query,
    });
    let matches = parsed.paragraphs.filter((paragraph) => {
      const targetMatches = scope === 'chapter' ? paragraph.chapterId === targetId : paragraph.novelId === targetId;
      return targetMatches && paragraph.text.toLocaleLowerCase().includes(query);
    });
    if (cursor) {
      matches = matches.filter((paragraph) => {
        const currentChapterIndex = chapterIndex.get(paragraph.chapterId) ?? 0;
        return scope === 'chapter'
          ? paragraph.index > cursor.paragraphIndex
          : currentChapterIndex > cursor.chapterIndex ||
              (currentChapterIndex === cursor.chapterIndex && paragraph.index > cursor.paragraphIndex);
      });
    }
    const hardLimit = readerSearchHardLimit(scope);
    const matchedCount = cursor?.matchedCount ?? 0;
    const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? 40), Math.max(0, hardLimit - matchedCount));
    const paragraphs: Paragraph[] = matches.slice(0, pageSize);
    const nextMatchedCount = matchedCount + paragraphs.length;
    const capped = nextMatchedCount >= hardLimit;
    const hasMore = matches.length > paragraphs.length;
    const last = paragraphs[paragraphs.length - 1];
    const nextCursor =
      hasMore && last && !capped
        ? encodeReaderSearchCursor({
            version: 1,
            scope,
            targetId,
            query,
            source: 'remote',
            chapterIndex: scope === 'book' ? (chapterIndex.get(last.chapterId) ?? 0) : 0,
            paragraphIndex: last.index,
            matchedCount: nextMatchedCount,
          })
        : undefined;
    return Response.json({
      paragraphs,
      nextCursor,
      capped,
      scannedRows: paragraphs.length,
      scannedTextCharacters: paragraphs.reduce((total, paragraph) => total + paragraph.text.length, 0),
    });
  });

  return {
    source: new RemoteReaderRepository(new RemoteApiClient('https://reader-contract.test')),
    parsed,
    pages,
  };
});
