import type { Chapter, Novel } from '../../domain/types';
import type { ReadingPosition } from '../../sync/types';
import { clamp, formatCount } from '../../utils/format';
import {
  buildChapterListModel,
  type ChapterAnnotationCounts,
  type ChapterListModel,
} from '../chapters/chapters-screen-model';
import {
  buildLibraryBookView,
  buildLibraryCollectionModel,
  type LibraryBookView,
  type LibraryCollectionModel,
  type NovelReadStateSelectors,
} from '../library/library-screen-model';
import type { BookWorkspaceState } from './book-workspace-contract';

export function hasNovelReadActivity(novel: Novel): boolean {
  return Boolean(
    novel.lastReadAt ||
    novel.lastReadChapterIndex !== undefined ||
    novel.lastReadProgress > 0 ||
    (novel.readingSeconds ?? 0) > 0,
  );
}

export function isNovelFinished(novel: Novel): boolean {
  return novel.lastReadProgress >= 0.995;
}

const READ_STATE: NovelReadStateSelectors = {
  hasReadActivity: hasNovelReadActivity,
  isFinished: isNovelFinished,
};

export function selectContinueChapter(
  chapters: readonly Chapter[],
  novel: Novel,
  position?: ReadingPosition,
): Chapter | undefined {
  return (
    (position ? chapters.find((chapter) => chapter.id === position.chapterId) : undefined) ??
    chapters.find((chapter) => chapter.id === novel.lastReadChapterId) ??
    chapters[0]
  );
}

export interface BookWorkspaceReadingProjection {
  readonly readChapter?: Chapter;
  readonly readChapterProgress: number;
  readonly readLocationLabel: string;
  readonly currentReadTargetChapter?: Chapter;
  readonly firstUnreadChapter?: Chapter;
  readonly canMarkCurrentChapterRead: boolean;
  readonly canMarkBookFinished: boolean;
  readonly canResetBookProgress: boolean;
}

type BookWorkspaceReadingState = Pick<BookWorkspaceState, 'chapters' | 'localReadingPosition' | 'selectedNovel'>;

export function buildBookWorkspaceReadingProjection(state: BookWorkspaceReadingState): BookWorkspaceReadingProjection {
  const { chapters, localReadingPosition, selectedNovel } = state;
  const readChapterId = localReadingPosition?.chapterId ?? selectedNovel?.lastReadChapterId;
  const readChapter = readChapterId ? chapters.find((chapter) => chapter.id === readChapterId) : undefined;
  const readChapterProgress =
    selectedNovel && readChapter
      ? localReadingPosition?.chapterId === readChapter.id
        ? clamp(localReadingPosition.chapterProgress, 0, 1)
        : clamp(
            selectedNovel.lastReadProgress * Math.max(1, selectedNovel.totalChapters) - (readChapter.index - 1),
            0,
            1,
          )
      : 0;
  const paragraphIndex =
    localReadingPosition && readChapter && localReadingPosition.chapterId === readChapter.id
      ? localReadingPosition.paragraphIndex
      : 0;
  const readLocationLabel = readChapter
    ? `${readChapter.index}. ${readChapter.title}${paragraphIndex > 0 ? ` · ${formatCount(paragraphIndex)}문단` : ''}`
    : '-';
  const sortedChapters = [...chapters].sort((a, b) => a.index - b.index);
  const currentReadTargetChapter = selectedNovel
    ? hasNovelReadActivity(selectedNovel) && readChapter
      ? readChapter
      : sortedChapters[0]
    : undefined;
  const firstUnreadChapter = !selectedNovel
    ? undefined
    : !hasNovelReadActivity(selectedNovel) || !readChapter
      ? sortedChapters[0]
      : readChapterProgress < 0.995
        ? readChapter
        : sortedChapters.find((chapter) => chapter.index > readChapter.index);

  return {
    readChapter,
    readChapterProgress,
    readLocationLabel,
    currentReadTargetChapter,
    firstUnreadChapter,
    canMarkCurrentChapterRead: Boolean(
      selectedNovel &&
      currentReadTargetChapter &&
      (!hasNovelReadActivity(selectedNovel) ||
        currentReadTargetChapter.id !== readChapter?.id ||
        readChapterProgress < 0.995),
    ),
    canMarkBookFinished: Boolean(selectedNovel && chapters.length > 0 && !isNovelFinished(selectedNovel)),
    canResetBookProgress: Boolean(
      selectedNovel &&
      (localReadingPosition?.novelId === selectedNovel.id ||
        selectedNovel.lastReadChapterId ||
        selectedNovel.lastReadProgress > 0 ||
        selectedNovel.lastReadOffset > 0),
    ),
  };
}

export interface BookWorkspaceProjection extends BookWorkspaceReadingProjection {
  readonly libraryCollection: LibraryCollectionModel;
  readonly selectedNovelScreenBook?: LibraryBookView;
  readonly chapterList: ChapterListModel;
  readonly filteredOutlineChapters: Chapter[];
  readonly readerParagraphProgressLabel: string;
  readonly readingStats: {
    readonly chapterCharacters: number;
    readonly readCharacters: number;
    readonly remainingCharacters: number;
    readonly charactersPerMinute: number;
    readonly estimatedRemainingSeconds?: number;
    readonly totalReadingSeconds: number;
  };
}

export type BookWorkspaceLibraryProjection = Pick<
  BookWorkspaceProjection,
  'libraryCollection' | 'selectedNovelScreenBook'
>;

type BookWorkspaceLibraryState = Pick<
  BookWorkspaceState,
  'libraryFilter' | 'libraryQuery' | 'librarySort' | 'novels' | 'selectedNovel'
>;

export function buildBookWorkspaceLibraryProjection(state: BookWorkspaceLibraryState): BookWorkspaceLibraryProjection {
  const libraryCollection = buildLibraryCollectionModel({
    novels: state.novels,
    query: state.libraryQuery,
    filter: state.libraryFilter,
    sort: state.librarySort,
    readState: READ_STATE,
  });
  return {
    libraryCollection,
    selectedNovelScreenBook: state.selectedNovel
      ? (libraryCollection.booksByNovelId.get(state.selectedNovel.id) ??
        buildLibraryBookView(state.selectedNovel, READ_STATE))
      : undefined,
  };
}

export type BookWorkspaceChapterProjection = Pick<BookWorkspaceProjection, 'chapterList' | 'filteredOutlineChapters'>;

export function buildBookWorkspaceChapterProjection(
  state: Pick<
    BookWorkspaceState,
    'chapterQuery' | 'chapterReadFilter' | 'chapterSort' | 'chapters' | 'outlineQuery' | 'selectedNovel'
  >,
  annotationCounts: ReadonlyMap<string, ChapterAnnotationCounts>,
  reading: BookWorkspaceReadingProjection,
): BookWorkspaceChapterProjection {
  const outlineQuery = state.outlineQuery.trim().toLocaleLowerCase();
  return {
    chapterList: buildChapterListModel({
      chapters: state.chapters,
      query: state.chapterQuery,
      readFilter: state.chapterReadFilter,
      sort: state.chapterSort,
      currentChapter: reading.readChapter,
      readPolicy:
        state.selectedNovel?.format === 'image_archive' && state.chapters.some((chapter) => chapter.documentSectionId)
          ? 'document_section'
          : 'sequential',
      annotationCounts,
    }),
    filteredOutlineChapters: outlineQuery
      ? state.chapters.filter((chapter) =>
          `${chapter.index} ${chapter.title}`.toLocaleLowerCase().includes(outlineQuery),
        )
      : state.chapters,
  };
}

export type BookWorkspaceReaderProjection = Pick<
  BookWorkspaceProjection,
  'readerParagraphProgressLabel' | 'readingStats'
>;

type BookWorkspaceReaderState = Pick<
  BookWorkspaceState,
  | 'currentChapter'
  | 'localReadingPosition'
  | 'readerProgress'
  | 'readerSessionCommittedSeconds'
  | 'readerSessionDisplaySeconds'
  | 'selectedNovel'
>;

export function buildBookWorkspaceReaderProjection(state: BookWorkspaceReaderState): BookWorkspaceReaderProjection {
  const chapterCharacters = state.currentChapter?.characterCount ?? 0;
  const readCharacters = Math.round(chapterCharacters * state.readerProgress);
  const remainingCharacters = Math.max(chapterCharacters - readCharacters, 0);
  const sessionMinutes = state.readerSessionDisplaySeconds / 60;
  const charactersPerMinute = sessionMinutes > 0 ? Math.round(readCharacters / sessionMinutes) : 0;
  const unsavedSessionSeconds = Math.max(0, state.readerSessionDisplaySeconds - state.readerSessionCommittedSeconds);
  return {
    readerParagraphProgressLabel: state.currentChapter?.paragraphCount
      ? `${formatCount(
          state.localReadingPosition?.chapterId === state.currentChapter.id &&
            state.localReadingPosition.paragraphIndex > 0
            ? state.localReadingPosition.paragraphIndex
            : clamp(
                Math.round(state.readerProgress * state.currentChapter.paragraphCount),
                1,
                state.currentChapter.paragraphCount,
              ),
        )} / ${formatCount(state.currentChapter.paragraphCount)} 문단`
      : '0 / 0 문단',
    readingStats: {
      chapterCharacters,
      readCharacters,
      remainingCharacters,
      charactersPerMinute,
      estimatedRemainingSeconds:
        charactersPerMinute > 0 ? Math.round((remainingCharacters / charactersPerMinute) * 60) : undefined,
      totalReadingSeconds: Math.max(0, state.selectedNovel?.readingSeconds ?? 0) + unsavedSessionSeconds,
    },
  };
}

export function buildBookWorkspaceProjection(
  state: BookWorkspaceState,
  annotationCounts: ReadonlyMap<string, ChapterAnnotationCounts>,
): BookWorkspaceProjection {
  const reading = buildBookWorkspaceReadingProjection(state);
  return {
    ...reading,
    ...buildBookWorkspaceLibraryProjection(state),
    ...buildBookWorkspaceChapterProjection(state, annotationCounts, reading),
    ...buildBookWorkspaceReaderProjection(state),
  };
}
