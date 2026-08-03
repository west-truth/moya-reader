import type { Paragraph } from '../domain/types';
import { READER_BOOK_SEARCH_LIMIT, READER_CHAPTER_SEARCH_LIMIT, type ReaderSearchScope } from '../reader/search-policy';

export type { ReaderSearchScope } from '../reader/search-policy';

export const READER_SEARCH_DEFAULT_PAGE_SIZE = 40;
export const READER_SEARCH_MAX_PAGE_SIZE = 80;
export const READER_SEARCH_SCAN_ROW_BUDGET = 256;
export const READER_SEARCH_SCAN_TEXT_BUDGET = 2 * 1024 * 1024;
export const READER_SEARCH_CURSOR_SLICE_ROWS = 16;
export const READER_SEARCH_MAX_QUERY_CODE_POINTS = 256;

export type ReaderSearchCursorSource = 'revision' | 'indexed' | 'pages' | 'legacy' | 'remote';

export interface ReaderSearchCursorState {
  readonly version: 1;
  readonly scope: ReaderSearchScope;
  readonly targetId: string;
  readonly query: string;
  readonly source: ReaderSearchCursorSource;
  readonly chapterIndex: number;
  readonly paragraphIndex: number;
  readonly pageIndex?: number;
  readonly matchedCount: number;
}

interface ReaderSearchPageRequestBase {
  readonly query: string;
  readonly cursor?: string;
  readonly pageSize?: number;
  readonly signal: AbortSignal;
}

export interface ChapterReaderSearchPageRequest extends ReaderSearchPageRequestBase {
  readonly scope: 'chapter';
  readonly chapterId: string;
}

export interface BookReaderSearchPageRequest extends ReaderSearchPageRequestBase {
  readonly scope: 'book';
  readonly novelId: string;
}

export type ReaderSearchPageRequest = ChapterReaderSearchPageRequest | BookReaderSearchPageRequest;

export interface ReaderSearchPage {
  readonly paragraphs: Paragraph[];
  readonly nextCursor?: string;
  readonly capped: boolean;
  readonly scannedRows: number;
  readonly scannedTextCharacters: number;
}

export class InvalidReaderSearchCursorError extends Error {
  constructor(message = 'Reader search cursor is invalid for this query.') {
    super(message);
    this.name = 'InvalidReaderSearchCursorError';
  }
}

export function readerSearchTargetId(request: ReaderSearchPageRequest): string {
  return request.scope === 'chapter' ? request.chapterId : request.novelId;
}

export function normalizedReaderSearchText(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function readerSearchHardLimit(scope: ReaderSearchScope): number {
  return scope === 'chapter' ? READER_CHAPTER_SEARCH_LIMIT : READER_BOOK_SEARCH_LIMIT;
}

export function readerSearchPageSize(requested: number | undefined, remaining?: number): number {
  const parsed = Number.isFinite(requested) ? Math.trunc(requested ?? READER_SEARCH_DEFAULT_PAGE_SIZE) : 0;
  const bounded = Math.min(READER_SEARCH_MAX_PAGE_SIZE, Math.max(1, parsed || READER_SEARCH_DEFAULT_PAGE_SIZE));
  return remaining === undefined ? bounded : Math.min(bounded, Math.max(0, remaining));
}

export function assertReaderSearchQuery(query: string): void {
  if (Array.from(query).length > READER_SEARCH_MAX_QUERY_CODE_POINTS) {
    throw new RangeError(`Reader search query must not exceed ${READER_SEARCH_MAX_QUERY_CODE_POINTS} characters.`);
  }
}

export function encodeReaderSearchCursor(state: ReaderSearchCursorState): string {
  return JSON.stringify(state);
}

function isCursorSource(value: unknown): value is ReaderSearchCursorSource {
  return ['revision', 'indexed', 'pages', 'legacy', 'remote'].includes(String(value));
}

function parseCursorState(cursor: string): ReaderSearchCursorState {
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new InvalidReaderSearchCursorError();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidReaderSearchCursorError();
  const row = value as Record<string, unknown>;
  const { version, scope, targetId, query, source, chapterIndex, paragraphIndex, pageIndex, matchedCount } = row;
  if (
    version !== 1 ||
    (scope !== 'chapter' && scope !== 'book') ||
    typeof targetId !== 'string' ||
    typeof query !== 'string' ||
    !isCursorSource(source) ||
    typeof chapterIndex !== 'number' ||
    typeof paragraphIndex !== 'number' ||
    typeof matchedCount !== 'number' ||
    !Number.isInteger(chapterIndex) ||
    !Number.isInteger(paragraphIndex) ||
    !Number.isInteger(matchedCount) ||
    chapterIndex < 0 ||
    paragraphIndex < 0 ||
    matchedCount < 0 ||
    (pageIndex !== undefined && (typeof pageIndex !== 'number' || !Number.isInteger(pageIndex) || pageIndex < 0))
  ) {
    throw new InvalidReaderSearchCursorError();
  }
  return { version, scope, targetId, query, source, chapterIndex, paragraphIndex, pageIndex, matchedCount };
}

export function decodeReaderSearchCursor(
  cursor: string | undefined,
  request: Pick<ReaderSearchPageRequest, 'scope' | 'query'> & { readonly targetId: string },
): ReaderSearchCursorState | undefined {
  if (!cursor) return undefined;
  const state = parseCursorState(cursor);
  const query = normalizedReaderSearchText(request.query);
  if (state.scope !== request.scope || state.targetId !== request.targetId || state.query !== query) {
    throw new InvalidReaderSearchCursorError();
  }
  if (state.matchedCount > readerSearchHardLimit(request.scope)) throw new InvalidReaderSearchCursorError();
  return state;
}

export function readerAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function throwIfReaderSearchAborted(signal: AbortSignal): void {
  if (signal.aborted) throw readerAbortError(signal);
}
