export const READER_PAGE_CACHE_RETAIN_BEFORE = 2;
export const READER_PAGE_CACHE_RETAIN_AFTER = 3;

export interface ReaderPageRange {
  start: number;
  end: number;
}

export interface PruneReaderParagraphCacheOptions<T> {
  paragraphCache: Map<number, T>;
  loadedPageIndexes: Set<number>;
  failedPageIndexes?: Set<number>;
  visibleParagraphIndexes: number[];
  paragraphsPerPage: number;
  retainBefore?: number;
  retainAfter?: number;
}

export interface PruneReaderParagraphCacheResult {
  changed: boolean;
  removedParagraphs: number;
  removedLoadedPages: number;
  removedFailedPages: number;
}

export function readerPageIndexForParagraphIndex(paragraphIndex: number, paragraphsPerPage: number): number {
  if (paragraphsPerPage <= 0) return 0;
  return Math.floor(Math.max(0, paragraphIndex) / paragraphsPerPage);
}

export function retainedReaderPageRange(
  pageIndexes: number[],
  retainBefore = READER_PAGE_CACHE_RETAIN_BEFORE,
  retainAfter = READER_PAGE_CACHE_RETAIN_AFTER,
): ReaderPageRange | undefined {
  const validPageIndexes = pageIndexes.filter((pageIndex) => Number.isFinite(pageIndex) && pageIndex >= 0);
  if (!validPageIndexes.length) return undefined;

  return {
    start: Math.max(0, Math.min(...validPageIndexes) - retainBefore),
    end: Math.max(...validPageIndexes) + retainAfter,
  };
}

function isPageInsideRange(pageIndex: number, range: ReaderPageRange): boolean {
  return pageIndex >= range.start && pageIndex <= range.end;
}

export function pruneReaderParagraphCache<T>({
  paragraphCache,
  loadedPageIndexes,
  failedPageIndexes,
  visibleParagraphIndexes,
  paragraphsPerPage,
  retainBefore = READER_PAGE_CACHE_RETAIN_BEFORE,
  retainAfter = READER_PAGE_CACHE_RETAIN_AFTER,
}: PruneReaderParagraphCacheOptions<T>): PruneReaderParagraphCacheResult {
  const visiblePageIndexes = visibleParagraphIndexes.map((index) =>
    readerPageIndexForParagraphIndex(index, paragraphsPerPage),
  );
  const range = retainedReaderPageRange(visiblePageIndexes, retainBefore, retainAfter);
  if (!range) {
    return { changed: false, removedParagraphs: 0, removedLoadedPages: 0, removedFailedPages: 0 };
  }

  let removedParagraphs = 0;
  for (const paragraphIndex of Array.from(paragraphCache.keys())) {
    const pageIndex = readerPageIndexForParagraphIndex(paragraphIndex, paragraphsPerPage);
    if (!isPageInsideRange(pageIndex, range)) {
      paragraphCache.delete(paragraphIndex);
      removedParagraphs += 1;
    }
  }

  let removedLoadedPages = 0;
  for (const pageIndex of Array.from(loadedPageIndexes)) {
    if (!isPageInsideRange(pageIndex, range)) {
      loadedPageIndexes.delete(pageIndex);
      removedLoadedPages += 1;
    }
  }

  let removedFailedPages = 0;
  if (failedPageIndexes) {
    for (const pageIndex of Array.from(failedPageIndexes)) {
      if (!isPageInsideRange(pageIndex, range)) {
        failedPageIndexes.delete(pageIndex);
        removedFailedPages += 1;
      }
    }
  }

  return {
    changed: removedParagraphs > 0 || removedLoadedPages > 0 || removedFailedPages > 0,
    removedParagraphs,
    removedLoadedPages,
    removedFailedPages,
  };
}
