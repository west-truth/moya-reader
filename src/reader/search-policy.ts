export type ReaderSearchScope = 'chapter' | 'book';

export const READER_CHAPTER_SEARCH_LIMIT = 200;
export const READER_BOOK_SEARCH_LIMIT = 300;
export const READER_BOOK_SEARCH_MIN_QUERY_LENGTH = 2;
export const READER_SEARCH_HIGHLIGHT_MAX_QUERY_LENGTH = 80;

export function normalizedReaderSearchQuery(query: string): string {
  return query.trim();
}

export function readerSearchLimit(scope: ReaderSearchScope): number {
  return scope === 'chapter' ? READER_CHAPTER_SEARCH_LIMIT : READER_BOOK_SEARCH_LIMIT;
}

export function readerSearchBlockedReason(scope: ReaderSearchScope, query: string): string | undefined {
  const normalized = normalizedReaderSearchQuery(query);
  if (!normalized) return undefined;
  if (scope === 'book' && Array.from(normalized).length < READER_BOOK_SEARCH_MIN_QUERY_LENGTH) {
    return `책 전체 검색은 ${READER_BOOK_SEARCH_MIN_QUERY_LENGTH}글자 이상 입력하세요.`;
  }
  return undefined;
}

export function canRunReaderSearch(scope: ReaderSearchScope, query: string): boolean {
  return normalizedReaderSearchQuery(query).length > 0 && readerSearchBlockedReason(scope, query) === undefined;
}

export function canHighlightReaderSearchQuery(scope: ReaderSearchScope, query: string): boolean {
  return canRunReaderSearch(scope, query) &&
    Array.from(normalizedReaderSearchQuery(query)).length <= READER_SEARCH_HIGHLIGHT_MAX_QUERY_LENGTH;
}
