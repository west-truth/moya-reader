import { describe, expect, it } from 'vitest';
import { buildBookWorkspaceProjection } from './book-workspace-projection';
import { testChapter, testNovel, testPosition, testWorkspaceState } from './book-workspace-test-fixtures';

describe('book workspace projection', () => {
  it('does not display the parser default first chapter as an actual read', () => {
    const chapters = [testChapter(1), testChapter(2)];
    const selectedNovel = testNovel({ lastReadChapterId: chapters[0]!.id });
    const projection = buildBookWorkspaceProjection(testWorkspaceState({ selectedNovel, chapters }), new Map());
    expect(projection.chapterList.rows.every((row) => !row.isRead && !row.isCurrent)).toBe(true);
  });
  it('projects library filters, chapter rows, and the persisted reading position from one state boundary', () => {
    const chapters = [testChapter(1), testChapter(2), testChapter(3)];
    const selectedNovel = testNovel({
      lastReadChapterId: 'chapter-3',
      lastReadProgress: 0.75,
      lastReadAt: '2026-07-11T01:00:00.000Z',
    });
    const unreadNovel = testNovel({ id: 'book-2', title: '미독 소설', sourceFileName: 'book-2.txt' });
    const state = testWorkspaceState({
      novels: [selectedNovel, unreadNovel],
      selectedNovel,
      chapters,
      currentChapter: chapters[1],
      localReadingPosition: testPosition({ chapterId: 'chapter-2', paragraphIndex: 4, chapterProgress: 0.4 }),
      libraryFilter: 'reading',
      chapterQuery: '2화',
      outlineQuery: '3화',
      readerProgress: 0.5,
    });

    const projection = buildBookWorkspaceProjection(
      state,
      new Map([['chapter-2', { bookmarks: 1, highlights: 2, notes: 3 }]]),
    );

    expect(projection.libraryCollection.visibleBooks.map((book) => book.novel.id)).toEqual(['book-1']);
    expect(projection.chapterList.rows.map((row) => row.chapter.id)).toEqual(['chapter-2']);
    expect(projection.chapterList.rows[0].annotationCounts).toEqual({ bookmarks: 1, highlights: 2, notes: 3 });
    expect(projection.filteredOutlineChapters.map((chapter) => chapter.id)).toEqual(['chapter-3']);
    expect(projection.readChapter?.id).toBe('chapter-2');
    expect(projection.readChapterProgress).toBe(0.4);
    expect(projection.readLocationLabel).toContain('4문단');
    expect(projection.readerParagraphProgressLabel).toBe('4 / 10 문단');
  });

  it('keeps session totals separate from committed time and derives reader statistics', () => {
    const novel = testNovel({ readingSeconds: 120 });
    const chapter = testChapter(1, { characterCount: 1_000, paragraphCount: 20 });
    const projection = buildBookWorkspaceProjection(
      testWorkspaceState({
        selectedNovel: novel,
        novels: [novel],
        chapters: [chapter],
        currentChapter: chapter,
        readerProgress: 0.5,
        readerSessionDisplaySeconds: 90,
        readerSessionCommittedSeconds: 30,
      }),
      new Map(),
    );

    expect(projection.readingStats).toEqual({
      chapterCharacters: 1_000,
      readCharacters: 500,
      remainingCharacters: 500,
      charactersPerMinute: 333,
      estimatedRemainingSeconds: 90,
      totalReadingSeconds: 180,
    });
  });
});
