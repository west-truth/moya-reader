import { describe, expect, it } from 'vitest';
import {
  pruneReaderParagraphCache,
  readerPageIndexForParagraphIndex,
  retainedReaderPageRange,
} from '../reader/page-cache-policy';

describe('reader page cache policy', () => {
  it('maps zero-based paragraph indexes to page indexes', () => {
    expect(readerPageIndexForParagraphIndex(0, 120)).toBe(0);
    expect(readerPageIndexForParagraphIndex(119, 120)).toBe(0);
    expect(readerPageIndexForParagraphIndex(120, 120)).toBe(1);
    expect(readerPageIndexForParagraphIndex(-4, 120)).toBe(0);
  });

  it('keeps a bounded page window around visible pages', () => {
    expect(retainedReaderPageRange([5, 6], 2, 3)).toEqual({ start: 3, end: 9 });
    expect(retainedReaderPageRange([1], 2, 3)).toEqual({ start: 0, end: 4 });
    expect(retainedReaderPageRange([], 2, 3)).toBeUndefined();
  });

  it('prunes paragraphs and loaded-page markers outside the retained window', () => {
    const paragraphCache = new Map<number, string>([
      [0, 'page-0'],
      [120, 'page-1'],
      [240, 'page-2'],
      [480, 'page-4'],
      [960, 'page-8'],
    ]);
    const loadedPageIndexes = new Set([0, 1, 2, 4, 8]);
    const failedPageIndexes = new Set([0, 8]);

    const result = pruneReaderParagraphCache({
      paragraphCache,
      loadedPageIndexes,
      failedPageIndexes,
      visibleParagraphIndexes: [480],
      paragraphsPerPage: 120,
      retainBefore: 1,
      retainAfter: 1,
    });

    expect(result).toEqual({
      changed: true,
      removedParagraphs: 4,
      removedLoadedPages: 4,
      removedFailedPages: 2,
    });
    expect([...paragraphCache.keys()]).toEqual([480]);
    expect([...loadedPageIndexes]).toEqual([4]);
    expect([...failedPageIndexes]).toEqual([]);
  });

  it('does not prune when there is no visible paragraph anchor', () => {
    const paragraphCache = new Map([[0, 'page-0']]);
    const loadedPageIndexes = new Set([0]);

    const result = pruneReaderParagraphCache({
      paragraphCache,
      loadedPageIndexes,
      visibleParagraphIndexes: [],
      paragraphsPerPage: 120,
    });

    expect(result.changed).toBe(false);
    expect([...paragraphCache.keys()]).toEqual([0]);
    expect([...loadedPageIndexes]).toEqual([0]);
  });
});
