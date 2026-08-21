import { describe, expect, it, vi } from 'vitest';
import type { Bookmark, Chapter, Novel, Paragraph, ReaderHighlight, ReaderNote } from '../../domain/types';
import { persistentIdVersion } from '../../domain/id-hash-contract';
import type { AnnotationReaderPort, AnnotationRepository } from './annotation-contract';
import { buildAnnotationsMarkdown } from './annotation-export';
import { buildAnnotationView } from './annotation-model';
import { navigateToAnnotation } from './annotation-navigation';
import { AnnotationPersistence } from './annotation-persistence';

const NOW = '2026-07-10T01:02:03.000Z';
const novel = { id: 'novel_1', title: '테스트 소설' } as Novel;
const chapters = [
  { id: 'chapter_1', novelId: novel.id, index: 1, title: '첫 화', paragraphCount: 1 } as Chapter,
  { id: 'chapter_2', novelId: novel.id, index: 2, title: '둘째 화', paragraphCount: 1 } as Chapter,
];
const paragraph: Paragraph = {
  id: 'paragraph_1',
  novelId: novel.id,
  chapterId: chapters[0].id,
  index: 0,
  text: '본문 문장',
  startOffsetInChapter: 0,
  endOffsetInChapter: 5,
  textHash: 'hash',
};

function createHarness() {
  let bookmarks: Bookmark[] = [];
  let highlights: ReaderHighlight[] = [];
  let notes: ReaderNote[] = [];
  const repository: AnnotationRepository = {
    getChapter: vi.fn(async (id) => chapters.find((chapter) => chapter.id === id)),
    getParagraph: vi.fn(async (id) => (id === paragraph.id ? paragraph : undefined)),
    listBookmarks: vi.fn(async () => [...bookmarks]),
    saveBookmark: vi.fn(async (bookmark) => {
      bookmarks = [...bookmarks.filter((item) => item.id !== bookmark.id), bookmark];
    }),
    deleteBookmark: vi.fn(async (id) => {
      bookmarks = bookmarks.filter((item) => item.id !== id);
    }),
    listHighlights: vi.fn(async () => [...highlights]),
    saveHighlight: vi.fn(async (highlight) => {
      highlights = [...highlights.filter((item) => item.id !== highlight.id), highlight];
    }),
    deleteHighlight: vi.fn(async (id) => {
      highlights = highlights.filter((item) => item.id !== id);
    }),
    listNotes: vi.fn(async () => [...notes]),
    saveNote: vi.fn(async (note) => {
      notes = [...notes.filter((item) => item.id !== note.id), note];
    }),
    deleteNote: vi.fn(async (id) => {
      notes = notes.filter((item) => item.id !== id);
    }),
  };
  const reader: AnnotationReaderPort = {
    getLocation: () => ({ progress: 0.42, scrollTop: 120, paragraphIndex: 0, paragraph }),
    getSelection: () => ({ text: '본문', paragraphId: paragraph.id }),
    getCachedParagraphById: () => paragraph,
    clearSelection: vi.fn(),
    scrollToParagraph: vi.fn(async () => true),
    scrubTo: vi.fn(async () => undefined),
  };
  return {
    repository,
    reader,
    persistence: new AnnotationPersistence(repository, () => NOW),
    collections: () => ({ bookmarks, highlights, notes }),
  };
}

describe('annotations controller contracts', () => {
  it('creates v2 IDs and preserves IDs when annotations are edited', async () => {
    const harness = createHarness();
    const context = {
      novel,
      chapter: chapters[0],
      reader: harness.reader,
      readerProgress: 0.42,
    };
    const bookmarkResult = await harness.persistence.toggleBookmark({ ...context, bookmarks: [] });
    expect(bookmarkResult?.bookmarks[0].id).toMatch(/^bookmark_[0-9a-f]{32}$/);
    expect(persistentIdVersion(bookmarkResult?.bookmarks[0].id ?? '')).toBe('v2-sha256-128');
    expect(harness.repository.listBookmarks).not.toHaveBeenCalled();

    const deletedBookmark = await harness.persistence.toggleBookmark({
      ...context,
      bookmarks: bookmarkResult?.bookmarks ?? [],
    });
    expect(deletedBookmark).toEqual({ status: 'deleted', bookmarks: [] });
    expect(harness.repository.listBookmarks).not.toHaveBeenCalled();

    const noteResult = await harness.persistence.saveNote({ ...context, notes: [] }, '첫 메모');
    const note = noteResult?.notes[0];
    expect(note?.id).toMatch(/^note_[0-9a-f]{32}$/);
    const edited = await harness.persistence.saveNote({ ...context, notes: note ? [note] : [] }, '수정 메모', note?.id);
    expect(edited?.notes[0]).toMatchObject({ id: note?.id, body: '수정 메모' });

    const highlightResult = await harness.persistence.setHighlight({ ...context, highlights: [] }, 'yellow');
    const highlight = highlightResult?.highlights[0];
    expect(highlight?.id).toMatch(/^highlight_[0-9a-f]{32}$/);
    const recolored = await harness.persistence.setHighlight(
      { ...context, highlights: highlight ? [highlight] : [] },
      'blue',
    );
    expect(recolored?.highlights[0]).toMatchObject({ id: highlight?.id, color: 'blue' });
  });

  it('filters by chapter/query, sorts by position, and exports the visible set', () => {
    const bookmark: Bookmark = {
      id: 'bookmark_existing',
      novelId: novel.id,
      chapterId: chapters[1].id,
      label: '둘째 화 50%',
      progress: 0.5,
      scrollTop: 0,
      createdAt: NOW,
    };
    const note: ReaderNote = {
      id: 'note_existing',
      novelId: novel.id,
      chapterId: chapters[0].id,
      paragraphId: paragraph.id,
      body: '찾을 메모',
      progress: 0.2,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const view = buildAnnotationView({
      collections: { bookmarks: [bookmark], highlights: [], notes: [note] },
      chapters,
      currentChapterId: chapters[0].id,
      progress: 0,
      query: '찾을',
      scope: 'chapter',
      sort: 'position',
    });
    expect(view.filteredBookmarks).toEqual([]);
    expect(view.filteredNotes).toEqual([note]);
    expect(view.chapterCounts.get(chapters[0].id)?.notes).toBe(1);
    const markdown = buildAnnotationsMarkdown({
      novel,
      currentChapterTitle: chapters[0].title,
      scope: 'chapter',
      query: '찾을',
      view,
      exportedAt: NOW,
    });
    expect(markdown).toContain('찾을 메모');
    expect(markdown).not.toContain(bookmark.label);
  });

  it('opens the target chapter with the annotation paragraph anchor', async () => {
    const harness = createHarness();
    const openChapter = vi.fn(async () => undefined);
    const target: ReaderHighlight = {
      id: 'highlight_existing',
      novelId: novel.id,
      chapterId: chapters[0].id,
      paragraphId: paragraph.id,
      quote: paragraph.text,
      color: 'yellow',
      progress: 0.42,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const moved = await navigateToAnnotation({
      target: { kind: 'highlight', item: target },
      novelId: novel.id,
      currentChapterId: chapters[1].id,
      chapters,
      repository: harness.repository,
      reader: harness.reader,
      openChapter,
      now: () => NOW,
    });
    expect(moved).toBe(true);
    expect(openChapter).toHaveBeenCalledWith(
      chapters[0],
      expect.objectContaining({ paragraphId: paragraph.id, paragraphIndex: paragraph.index, chapterProgress: 0.42 }),
    );
  });
});
