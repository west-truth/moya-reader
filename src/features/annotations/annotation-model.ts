import type { Bookmark, Chapter, ReaderHighlight, ReaderNote } from '../../domain/types';
import type { AnnotationCollections, AnnotationScope, AnnotationSort } from './annotation-contract';

const BOOKMARK_PROGRESS_TOLERANCE = 0.003;

export interface ChapterAnnotationCounts {
  bookmarks: number;
  highlights: number;
  notes: number;
}

export interface AnnotationViewModel {
  readonly chapterTitleById: ReadonlyMap<string, string>;
  readonly chapterCounts: ReadonlyMap<string, ChapterAnnotationCounts>;
  readonly scopedBookmarks: readonly Bookmark[];
  readonly scopedHighlights: readonly ReaderHighlight[];
  readonly scopedNotes: readonly ReaderNote[];
  readonly filteredBookmarks: readonly Bookmark[];
  readonly filteredHighlights: readonly ReaderHighlight[];
  readonly filteredNotes: readonly ReaderNote[];
  readonly activeBookmark?: Bookmark;
  readonly activeHighlight?: ReaderHighlight;
  readonly filteredCount: number;
}

export function findBookmarkAtPosition(
  bookmarks: readonly Bookmark[],
  chapterId: string,
  paragraphId: string | undefined,
  progress: number,
): Bookmark | undefined {
  if (paragraphId) {
    const exact = bookmarks.find(
      (bookmark) => bookmark.chapterId === chapterId && bookmark.paragraphId === paragraphId,
    );
    if (exact) return exact;
  }
  return bookmarks.find(
    (bookmark) =>
      bookmark.chapterId === chapterId &&
      !bookmark.paragraphId &&
      Math.abs(bookmark.progress - progress) <= BOOKMARK_PROGRESS_TOLERANCE,
  );
}

export function buildChapterAnnotationCounts(
  collections: AnnotationCollections,
): ReadonlyMap<string, ChapterAnnotationCounts> {
  const result = new Map<string, ChapterAnnotationCounts>();
  const countsFor = (chapterId: string) => {
    const counts = result.get(chapterId) ?? { bookmarks: 0, highlights: 0, notes: 0 };
    result.set(chapterId, counts);
    return counts;
  };
  collections.bookmarks.forEach((bookmark) => (countsFor(bookmark.chapterId).bookmarks += 1));
  collections.highlights.forEach((highlight) => (countsFor(highlight.chapterId).highlights += 1));
  collections.notes.forEach((note) => (countsFor(note.chapterId).notes += 1));
  return result;
}

function includesQuery(values: readonly (string | undefined)[], query: string): boolean {
  return values.join(' ').toLocaleLowerCase().includes(query);
}

export function buildAnnotationView(input: {
  readonly collections: AnnotationCollections;
  readonly chapters: readonly Chapter[];
  readonly currentChapterId?: string;
  readonly activeParagraphId?: string;
  readonly progress: number;
  readonly query: string;
  readonly scope: AnnotationScope;
  readonly sort: AnnotationSort;
}): AnnotationViewModel {
  const chapterTitleById = new Map(input.chapters.map((chapter) => [chapter.id, `${chapter.index}. ${chapter.title}`]));
  const chapterIndexById = new Map(input.chapters.map((chapter) => [chapter.id, chapter.index]));
  const inScope = <Item extends { chapterId: string }>(item: Item) =>
    input.scope !== 'chapter' || !input.currentChapterId || item.chapterId === input.currentChapterId;
  const scopedBookmarks = input.collections.bookmarks.filter(inScope);
  const scopedHighlights = input.collections.highlights.filter(inScope);
  const scopedNotes = input.collections.notes.filter(inScope);
  const query = input.query.trim().toLocaleLowerCase();
  const comparePosition = (a: { chapterId: string; progress: number }, b: { chapterId: string; progress: number }) => {
    const chapterDelta =
      (chapterIndexById.get(a.chapterId) ?? Number.MAX_SAFE_INTEGER) -
      (chapterIndexById.get(b.chapterId) ?? Number.MAX_SAFE_INTEGER);
    return chapterDelta || a.progress - b.progress;
  };
  const sortItems = <Item extends { chapterId: string; progress: number }>(
    items: Item[],
    recent: (item: Item) => string,
  ) => items.sort(input.sort === 'position' ? comparePosition : (a, b) => recent(b).localeCompare(recent(a)));
  const filteredBookmarks = sortItems(
    scopedBookmarks.filter(
      (bookmark) => !query || includesQuery([bookmark.label, chapterTitleById.get(bookmark.chapterId)], query),
    ),
    (bookmark) => bookmark.createdAt,
  );
  const filteredHighlights = sortItems(
    scopedHighlights.filter(
      (highlight) => !query || includesQuery([highlight.quote, chapterTitleById.get(highlight.chapterId)], query),
    ),
    (highlight) => highlight.updatedAt,
  );
  const filteredNotes = sortItems(
    scopedNotes.filter(
      (note) => !query || includesQuery([note.body, note.quote, chapterTitleById.get(note.chapterId)], query),
    ),
    (note) => note.updatedAt,
  );
  const activeHighlight = input.activeParagraphId
    ? input.collections.highlights.find((highlight) => highlight.paragraphId === input.activeParagraphId)
    : undefined;

  return {
    chapterTitleById,
    chapterCounts: buildChapterAnnotationCounts(input.collections),
    scopedBookmarks,
    scopedHighlights,
    scopedNotes,
    filteredBookmarks,
    filteredHighlights,
    filteredNotes,
    activeBookmark: input.currentChapterId
      ? findBookmarkAtPosition(
          input.collections.bookmarks,
          input.currentChapterId,
          input.activeParagraphId,
          input.progress,
        )
      : undefined,
    activeHighlight,
    filteredCount: filteredBookmarks.length + filteredHighlights.length + filteredNotes.length,
  };
}
