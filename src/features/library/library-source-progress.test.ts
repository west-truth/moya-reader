import { describe, expect, it } from 'vitest';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { applySourceProgress, withSourceProgress } from './library-source-progress';
import { buildLibraryCollectionModel } from './library-screen-model';

const readState = { hasReadActivity: () => true, isFinished: () => false };

function collection() {
  return buildLibraryCollectionModel({
    novels: [
      testNovel({
        id: 'source-book',
        title: '소스 작품',
        totalChapters: 3,
        lastReadProgress: 1,
        lastReadAt: '2026-09-02',
      }),
      testNovel({
        id: 'local-book',
        title: '로컬 작품',
        totalChapters: 10,
        lastReadProgress: 0.4,
        lastReadAt: '2026-09-01',
      }),
    ],
    query: '',
    filter: 'all',
    sort: 'recent',
    readState,
  });
}

describe('applySourceProgress', () => {
  it('replaces downloaded progress for source works everywhere the library shows a book', () => {
    const progress = new Map([['source-book', { readCount: 3, totalCount: 120, progress: 3 / 120 }]]);
    const next = applySourceProgress(collection(), progress);
    const views = [
      next.visibleBooks.find((book) => book.novel.id === 'source-book'),
      next.recentBooks.find((book) => book.novel.id === 'source-book'),
      next.booksByNovelId.get('source-book'),
      next.featuredBook,
    ];

    views.forEach((book) => {
      expect(book?.bookProgress).toBeCloseTo(0.025);
      expect(book?.readingPositionLabel).toBe('3 / 120화');
    });
    // One view per book keeps selection and focus comparisons stable.
    expect(new Set(views).size).toBe(1);
    expect(next.booksByNovelId.get('local-book')?.bookProgress).toBeCloseTo(0.4);
    expect(next.filterCounts).toEqual(collection().filterCounts);
  });

  it('returns the collection untouched when no source progress applies', () => {
    const base = collection();
    expect(applySourceProgress(base, undefined)).toBe(base);
    expect(applySourceProgress(base, new Map())).toBe(base);
  });
});

describe('withSourceProgress', () => {
  it('keeps the local book view when the work has no source progress', () => {
    const book = collection().visibleBooks[0]!;
    expect(withSourceProgress(book, undefined)).toBe(book);
  });
});
