import type { Chapter, Novel } from '../../domain/types';
import type { LibraryBookView } from '../library/library-screen-model';
import type { ChapterListModel, ChapterReadFilter, ChapterSort } from './chapters-screen-model';

type MaybePromise = void | Promise<void>;

export interface ChaptersScreenModel {
  book: LibraryBookView;
  titleEditor: {
    editing: boolean;
    draft: string;
  };
  query: string;
  readFilter: ChapterReadFilter;
  sort: ChapterSort;
  chapterList: ChapterListModel;
  summary: {
    readChapterProgress: number;
    readLocationLabel: string;
    bookmarkCount: number;
    highlightCount: number;
    noteCount: number;
    syncLabel: string;
    firstUnreadChapter?: Chapter;
    currentReadTargetChapter?: Chapter;
    canMarkCurrentChapterRead: boolean;
    canMarkBookFinished: boolean;
    canResetBookProgress: boolean;
  };
}

export interface ChaptersScreenActions {
  navigation: {
    backToLibrary(): void;
    continueReading(): MaybePromise;
    openSettings(): void;
    openSync(): void;
    openImport(): void;
    openChapterAppend(): void;
    openStructureEditor(): void;
    openMetadata(): void;
  };
  titleEditor: {
    start(): void;
    cancel(): void;
    setDraft(value: string): void;
    save(): MaybePromise;
  };
  book: {
    toggleFavorite(novel: Novel): MaybePromise;
    openFirstUnreadChapter(): MaybePromise;
    markCurrentChapterRead(): MaybePromise;
    markFinished(): MaybePromise;
    resetProgress(): MaybePromise;
    exportSource(novel: Novel): MaybePromise;
    reselectSource(novel: Novel, file: File): MaybePromise;
    reconstructSource(novel: Novel): MaybePromise;
  };
  chapterList: {
    setQuery(value: string): void;
    setReadFilter(filter: ChapterReadFilter): void;
    setSort(sort: ChapterSort): void;
    openChapter(chapter: Chapter, restore: boolean): MaybePromise;
  };
}

export interface ChaptersScreenProps {
  model: ChaptersScreenModel;
  actions: ChaptersScreenActions;
}
