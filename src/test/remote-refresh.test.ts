import { describe, expect, it, vi } from 'vitest';
import type { Bookmark, Chapter, Novel, ReaderHighlight, ReaderNote } from '../domain/types';
import type { ReaderRepository } from '../repositories/reader-repository';
import { loadHostedRemoteRefreshState } from '../sync/remote-refresh';
import type { ReadingPosition } from '../sync/types';

const now = '2026-07-05T00:00:00.000Z';

function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'book_1',
    title: 'Hosted Book',
    sourceFileName: 'hosted.txt',
    sourceEncoding: 'utf-8',
    rawText: '',
    normalizedText: '',
    rawTextHash: '',
    normalizedTextHash: 'book-hash',
    createdAt: now,
    updatedAt: now,
    totalChapters: 2,
    totalCharacters: 200,
    totalParagraphs: 20,
    coverSeed: 1,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
    ...overrides,
  };
}

function chapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: 'chapter_1',
    novelId: 'book_1',
    index: 1,
    title: '1화',
    normalizedText: '',
    textHash: 'chapter-hash',
    rawStartOffset: 0,
    rawEndOffset: 100,
    characterCount: 100,
    paragraphCount: 10,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function repository(overrides: Partial<ReaderRepository>): ReaderRepository {
  return overrides as ReaderRepository;
}

describe('hosted remote refresh state', () => {
  it('refreshes only the hosted library list when no book is selected', async () => {
    const listed = [novel()];
    const repo = repository({
      listNovels: vi.fn(async () => listed),
    });

    const state = await loadHostedRemoteRefreshState({
      repository: repo,
      backendMode: 'remote',
      view: 'library',
      currentChapterProgress: 0,
    });

    expect(state).toEqual({ novels: listed, selection: { status: 'none' } });
    expect(repo.listNovels).toHaveBeenCalledTimes(1);
  });

  it('loads hosted book, chapter, annotation, and remote reading-position state for UI refresh', async () => {
    const selected = novel({ updatedAt: '2026-07-05T00:00:00.000Z' });
    const fresh = novel({ title: 'Hosted Book Updated', updatedAt: '2026-07-05T00:05:00.000Z' });
    const currentChapter = chapter();
    const freshCurrentChapter = chapter({ title: '1화 수정본', updatedAt: '2026-07-05T00:06:00.000Z' });
    const chapters = [freshCurrentChapter, chapter({ id: 'chapter_2', index: 2, title: '2화' })];
    const bookmarks: Bookmark[] = [
      {
        id: 'bookmark_1',
        novelId: 'book_1',
        chapterId: 'chapter_2',
        paragraphId: 'paragraph_12',
        label: 'Remote bookmark',
        progress: 0.75,
        scrollTop: 900,
        createdAt: '2026-07-05T00:07:00.000Z',
      },
    ];
    const highlights: ReaderHighlight[] = [
      {
        id: 'highlight_1',
        novelId: 'book_1',
        chapterId: 'chapter_2',
        paragraphId: 'paragraph_12',
        quote: 'remote highlight',
        color: 'green',
        progress: 0.75,
        createdAt: '2026-07-05T00:07:30.000Z',
        updatedAt: '2026-07-05T00:07:30.000Z',
      },
    ];
    const notes: ReaderNote[] = [
      {
        id: 'note_1',
        novelId: 'book_1',
        chapterId: 'chapter_2',
        paragraphId: 'paragraph_12',
        quote: 'remote note quote',
        body: 'remote note',
        progress: 0.75,
        createdAt: '2026-07-05T00:08:00.000Z',
        updatedAt: '2026-07-05T00:08:00.000Z',
      },
    ];
    const remotePosition: ReadingPosition = {
      id: 'reading_position_book_1',
      novelId: 'book_1',
      chapterId: 'chapter_2',
      paragraphId: 'paragraph_12',
      paragraphIndex: 12,
      offsetInParagraph: 3,
      chapterProgress: 0.75,
      scrollTop: 900,
      deviceId: 'phone',
      updatedAt: '2026-07-05T00:09:00.000Z',
    };
    const repo = repository({
      listNovels: vi.fn(async () => [fresh]),
      getNovel: vi.fn(async () => fresh),
      getReadingPosition: vi.fn(async () => remotePosition),
      listChapters: vi.fn(async () => chapters),
      getChapter: vi.fn(async () => freshCurrentChapter),
      listBookmarks: vi.fn(async () => bookmarks),
      listHighlights: vi.fn(async () => highlights),
      listNotes: vi.fn(async () => notes),
    });

    const state = await loadHostedRemoteRefreshState({
      repository: repo,
      backendMode: 'remote',
      view: 'reader',
      selectedNovel: selected,
      currentChapter,
      currentChapterProgress: 0.2,
    });

    expect(state.selection).toMatchObject({
      status: 'loaded',
      novel: { title: 'Hosted Book Updated' },
      chapters,
      currentChapter: { title: '1화 수정본' },
      bookmarks,
      highlights,
      notes,
      readingPosition: remotePosition,
      remoteReadingPosition: remotePosition,
    });
    expect(repo.getNovel).toHaveBeenCalledWith('book_1');
    expect(repo.listBookmarks).toHaveBeenCalledWith('book_1');
    expect(repo.listHighlights).toHaveBeenCalledWith('book_1');
    expect(repo.listNotes).toHaveBeenCalledWith('book_1');
  });

  it('falls back to the first hosted chapter and marks the reader cache stale when the current chapter disappeared', async () => {
    const selected = novel({ updatedAt: '2026-07-05T00:00:00.000Z' });
    const staleCurrentChapter = chapter({ id: 'chapter_removed', title: '삭제된 화' });
    const replacementChapter = chapter({ id: 'chapter_2', index: 2, title: '2화' });
    const repo = repository({
      listNovels: vi.fn(async () => [selected]),
      getNovel: vi.fn(async () => selected),
      getReadingPosition: vi.fn(async () => undefined),
      listChapters: vi.fn(async () => [replacementChapter]),
      getChapter: vi.fn(async () => undefined),
      listBookmarks: vi.fn(async () => []),
      listHighlights: vi.fn(async () => []),
      listNotes: vi.fn(async () => []),
    });

    const state = await loadHostedRemoteRefreshState({
      repository: repo,
      backendMode: 'remote',
      view: 'reader',
      selectedNovel: selected,
      currentChapter: staleCurrentChapter,
      currentChapterProgress: 0.4,
    });

    expect(state.selection).toMatchObject({
      status: 'loaded',
      currentChapter: { id: 'chapter_2', title: '2화' },
      currentChapterChanged: true,
    });
  });

  it('marks the reader cache stale when the hosted current chapter body metadata changed', async () => {
    const selected = novel({ updatedAt: '2026-07-05T00:00:00.000Z' });
    const currentChapter = chapter({ textHash: 'old-hash', updatedAt: '2026-07-05T00:00:00.000Z' });
    const freshCurrentChapter = chapter({ textHash: 'new-hash', updatedAt: '2026-07-05T00:10:00.000Z' });
    const repo = repository({
      listNovels: vi.fn(async () => [selected]),
      getNovel: vi.fn(async () => selected),
      getReadingPosition: vi.fn(async () => undefined),
      listChapters: vi.fn(async () => [freshCurrentChapter]),
      getChapter: vi.fn(async () => freshCurrentChapter),
      listBookmarks: vi.fn(async () => []),
      listHighlights: vi.fn(async () => []),
      listNotes: vi.fn(async () => []),
    });

    const state = await loadHostedRemoteRefreshState({
      repository: repo,
      backendMode: 'remote',
      view: 'reader',
      selectedNovel: selected,
      currentChapter,
      currentChapterProgress: 0.4,
    });

    expect(state.selection).toMatchObject({
      status: 'loaded',
      currentChapter: { textHash: 'new-hash' },
      currentChapterChanged: true,
    });
  });

  it('returns a missing selection without fetching child state when the selected hosted book is gone', async () => {
    const repo = repository({
      listNovels: vi.fn(async () => []),
      getNovel: vi.fn(async () => undefined),
      getReadingPosition: vi.fn(),
      listChapters: vi.fn(),
      getChapter: vi.fn(),
      listBookmarks: vi.fn(),
      listHighlights: vi.fn(),
      listNotes: vi.fn(),
    });

    const state = await loadHostedRemoteRefreshState({
      repository: repo,
      backendMode: 'remote',
      view: 'reader',
      selectedNovel: novel(),
      currentChapter: chapter(),
      currentChapterProgress: 0.1,
    });

    expect(state).toEqual({ novels: [], selection: { status: 'missing' } });
    expect(repo.getReadingPosition).not.toHaveBeenCalled();
    expect(repo.listBookmarks).not.toHaveBeenCalled();
    expect(repo.listHighlights).not.toHaveBeenCalled();
    expect(repo.listNotes).not.toHaveBeenCalled();
  });

  it('does not surface an equivalent hosted reading position as a jump prompt', async () => {
    const selected = novel({ updatedAt: '2026-07-05T00:00:00.000Z' });
    const currentChapter = chapter();
    const equivalentPosition: ReadingPosition = {
      id: 'reading_position_book_1',
      novelId: 'book_1',
      chapterId: currentChapter.id,
      paragraphIndex: 2,
      offsetInParagraph: 0,
      chapterProgress: 0.205,
      scrollTop: 120,
      deviceId: 'phone',
      updatedAt: '2026-07-05T00:10:00.000Z',
    };
    const repo = repository({
      listNovels: vi.fn(async () => [selected]),
      getNovel: vi.fn(async () => selected),
      getReadingPosition: vi.fn(async () => equivalentPosition),
      listChapters: vi.fn(async () => [currentChapter]),
      getChapter: vi.fn(async () => currentChapter),
      listBookmarks: vi.fn(async () => []),
      listHighlights: vi.fn(async () => []),
      listNotes: vi.fn(async () => []),
    });

    const state = await loadHostedRemoteRefreshState({
      repository: repo,
      backendMode: 'remote',
      view: 'reader',
      selectedNovel: selected,
      currentChapter,
      currentChapterProgress: 0.2,
    });

    expect(state.selection).toMatchObject({
      status: 'loaded',
      currentChapterChanged: false,
      readingPosition: equivalentPosition,
      remoteReadingPosition: undefined,
    });
  });
});
