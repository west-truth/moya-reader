import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import {
  InvalidReaderSearchCursorError,
  assertReaderSearchQuery,
  decodeReaderSearchCursor,
  encodeReaderSearchCursor,
  normalizedReaderSearchText,
  readerSearchHardLimit,
  readerSearchPageSize,
  type ReaderSearchCursorState,
  type ReaderSearchScope,
} from '../../../../../src/repositories/reader-query-contract.js';
import type { Paragraph } from '@noveldesk/contracts';
import type { ServerConfig } from '../../config.js';

interface SearchQuerystring {
  readonly query?: string;
  readonly limit?: string;
  readonly pageSize?: string;
  readonly cursor?: string;
}

interface SearchRow extends Record<string, unknown> {
  readonly paragraph: unknown;
  readonly search_chapter_index?: number;
  readonly search_paragraph_index?: number;
}

interface ParsedSearchRequest {
  readonly query: string;
  readonly cursor?: ReaderSearchCursorState;
  readonly pageSize: number;
  readonly paginated: boolean;
  readonly hardLimit: number;
}

function parseLegacySearchLimit(value: string | undefined, cap: number): number {
  return Math.min(cap, Math.max(1, Number.parseInt(value ?? String(cap), 10) || cap));
}

function escapedContainsLikePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, '\\$&')}%`;
}

function paragraphFromSearchRow(row: SearchRow): Paragraph {
  if (!row.paragraph || typeof row.paragraph !== 'object' || Array.isArray(row.paragraph)) {
    throw new Error('Stored search paragraph is invalid.');
  }
  const paragraph = row.paragraph as Record<string, unknown>;
  const strings = ['id', 'novelId', 'chapterId', 'text', 'textHash'] as const;
  const numbers = ['index', 'startOffsetInChapter', 'endOffsetInChapter'] as const;
  for (const field of strings) {
    if (typeof paragraph[field] !== 'string') throw new Error(`Stored search paragraph ${field} is invalid.`);
  }
  for (const field of numbers) {
    if (typeof paragraph[field] !== 'number' || !Number.isFinite(paragraph[field])) {
      throw new Error(`Stored search paragraph ${field} is invalid.`);
    }
  }
  return {
    id: paragraph.id as string,
    novelId: paragraph.novelId as string,
    chapterId: paragraph.chapterId as string,
    index: paragraph.index as number,
    text: paragraph.text as string,
    startOffsetInChapter: paragraph.startOffsetInChapter as number,
    endOffsetInChapter: paragraph.endOffsetInChapter as number,
    textHash: paragraph.textHash as string,
  };
}

function parseSearchRequest(scope: ReaderSearchScope, targetId: string, input: SearchQuerystring): ParsedSearchRequest {
  const query = normalizedReaderSearchText(input.query ?? '');
  assertReaderSearchQuery(query);
  const cursor = decodeReaderSearchCursor(input.cursor, { scope, targetId, query });
  if (cursor && cursor.source !== 'remote') throw new InvalidReaderSearchCursorError();
  const hardLimit = readerSearchHardLimit(scope);
  const paginated = input.pageSize !== undefined || cursor !== undefined;
  const remaining = Math.max(0, hardLimit - (cursor?.matchedCount ?? 0));
  const pageSize = paginated
    ? readerSearchPageSize(Number(input.pageSize), remaining)
    : parseLegacySearchLimit(input.limit, hardLimit);
  return { query, cursor, pageSize, paginated, hardLimit };
}

function searchError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof InvalidReaderSearchCursorError || error instanceof RangeError) {
    return reply.code(400).send({ error: error.message });
  }
  return undefined;
}

function paginatedResponse(
  scope: ReaderSearchScope,
  targetId: string,
  search: ParsedSearchRequest,
  rows: SearchRow[],
  paragraphs: Paragraph[],
): {
  paragraphs: Paragraph[];
  nextCursor?: string;
  capped: boolean;
  scannedRows: number;
  scannedTextCharacters: number;
} {
  const returnedRows = rows.slice(0, search.pageSize);
  const returnedParagraphs = paragraphs.slice(0, search.pageSize);
  const matchedCount = (search.cursor?.matchedCount ?? 0) + returnedParagraphs.length;
  const capped = matchedCount >= search.hardLimit;
  const hasMore = rows.length > search.pageSize;
  const last = returnedRows[returnedRows.length - 1];
  const paragraphIndex = Number(last?.search_paragraph_index);
  const chapterIndex = scope === 'book' ? Number(last?.search_chapter_index) : 0;
  const nextCursor =
    hasMore && !capped && Number.isInteger(paragraphIndex) && Number.isInteger(chapterIndex)
      ? encodeReaderSearchCursor({
          version: 1,
          scope,
          targetId,
          query: search.query,
          source: 'remote',
          chapterIndex,
          paragraphIndex,
          matchedCount,
        })
      : undefined;
  return {
    paragraphs: returnedParagraphs,
    nextCursor,
    capped,
    scannedRows: returnedParagraphs.length,
    scannedTextCharacters: returnedParagraphs.reduce((total, paragraph) => total + paragraph.text.length, 0),
  };
}

export async function registerBookSearchRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get<{ Params: { bookId: string }; Querystring: SearchQuerystring }>(
    '/api/books/:bookId/search',
    async (request, reply) => {
      let search: ParsedSearchRequest;
      try {
        search = parseSearchRequest('book', request.params.bookId, request.query);
      } catch (error) {
        return searchError(reply, error) ?? Promise.reject(error);
      }
      if (!search.query || search.pageSize === 0) {
        return search.paginated
          ? { paragraphs: [], capped: search.pageSize === 0, scannedRows: 0, scannedTextCharacters: 0 }
          : { paragraphs: [] };
      }
      const cursorChapterIndex = search.cursor?.chapterIndex;
      const cursorParagraphIndex = search.cursor?.paragraphIndex;
      const sqlLimit = search.pageSize + (search.paginated ? 1 : 0);
      const result = search.paginated
        ? await pool.query(
            `
              select ps.paragraph,
                     c.chapter_index as search_chapter_index,
                     ps.paragraph_index as search_paragraph_index
              from paragraph_search ps
              join chapters c on c.id = ps.chapter_id
              join library_books b on b.id = ps.book_id
              where b.user_id = $1 and b.deleted_at is null
                and ps.book_id = $2
                and ps.text_lower like $3 escape '\\'
                and (
                  $4::integer is null
                  or c.chapter_index > $4
                  or (c.chapter_index = $4 and ps.paragraph_index > $5)
                )
              order by c.chapter_index asc, ps.paragraph_index asc
              limit $6
            `,
            [
              config.defaultUserId,
              request.params.bookId,
              escapedContainsLikePattern(search.query),
              cursorChapterIndex ?? null,
              cursorParagraphIndex ?? null,
              sqlLimit,
            ],
          )
        : await pool.query(
            `
              select ps.paragraph
              from paragraph_search ps
              join chapters c on c.id = ps.chapter_id
              join library_books b on b.id = ps.book_id
              where b.user_id = $1 and b.deleted_at is null
                and ps.book_id = $2
                and ps.text_lower like $3 escape '\\'
              order by c.chapter_index asc, ps.paragraph_index asc
              limit $4
            `,
            [config.defaultUserId, request.params.bookId, escapedContainsLikePattern(search.query), search.pageSize],
          );
      if (!result.rows.length) {
        const book = await pool.query(
          'select id from library_books where id = $1 and user_id = $2 and deleted_at is null',
          [request.params.bookId, config.defaultUserId],
        );
        if (!book.rows[0]) return reply.code(404).send({ error: 'book not found' });
      }
      const rows = result.rows as SearchRow[];
      if (!search.paginated) return { paragraphs: rows.map((row) => row.paragraph) };
      return paginatedResponse('book', request.params.bookId, search, rows, rows.map(paragraphFromSearchRow));
    },
  );

  app.get<{ Params: { chapterId: string }; Querystring: SearchQuerystring }>(
    '/api/chapters/:chapterId/search',
    async (request, reply) => {
      let search: ParsedSearchRequest;
      try {
        search = parseSearchRequest('chapter', request.params.chapterId, request.query);
      } catch (error) {
        return searchError(reply, error) ?? Promise.reject(error);
      }
      if (!search.query || search.pageSize === 0) {
        return search.paginated
          ? { paragraphs: [], capped: search.pageSize === 0, scannedRows: 0, scannedTextCharacters: 0 }
          : { paragraphs: [] };
      }
      const cursorParagraphIndex = search.cursor?.paragraphIndex;
      const sqlLimit = search.pageSize + (search.paginated ? 1 : 0);
      const result = search.paginated
        ? await pool.query(
            `
              select ps.paragraph,
                     ps.paragraph_index as search_paragraph_index
              from paragraph_search ps
              join library_books b on b.id = ps.book_id
              where b.user_id = $1 and b.deleted_at is null
                and ps.chapter_id = $2
                and ps.text_lower like $3 escape '\\'
                and ($4::integer is null or ps.paragraph_index > $4)
              order by ps.paragraph_index asc
              limit $5
            `,
            [
              config.defaultUserId,
              request.params.chapterId,
              escapedContainsLikePattern(search.query),
              cursorParagraphIndex ?? null,
              sqlLimit,
            ],
          )
        : await pool.query(
            `
              select ps.paragraph
              from paragraph_search ps
              join library_books b on b.id = ps.book_id
              where b.user_id = $1 and b.deleted_at is null
                and ps.chapter_id = $2
                and ps.text_lower like $3 escape '\\'
              order by ps.paragraph_index asc
              limit $4
            `,
            [config.defaultUserId, request.params.chapterId, escapedContainsLikePattern(search.query), search.pageSize],
          );
      const chapter = result.rows.length
        ? undefined
        : await pool.query(
            `
              select c.id
              from chapters c
              join library_books b on b.id = c.book_id
              where c.id = $1 and b.user_id = $2 and b.deleted_at is null
            `,
            [request.params.chapterId, config.defaultUserId],
          );
      if (chapter && !chapter.rows[0]) return reply.code(404).send({ error: 'chapter not found' });
      const rows = result.rows as SearchRow[];
      if (!search.paginated) return { paragraphs: rows.map((row) => row.paragraph) };
      return paginatedResponse('chapter', request.params.chapterId, search, rows, rows.map(paragraphFromSearchRow));
    },
  );
}
