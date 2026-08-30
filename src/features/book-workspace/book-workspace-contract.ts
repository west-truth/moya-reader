import type {
  Bookmark,
  Chapter,
  Character,
  LabeledSegment,
  Novel,
  ReaderHighlight,
  ReaderNote,
  VoiceProfile,
} from '../../domain/types';
import type { ReadingPosition } from '../../sync/types';
import type { NovelMetadataPatch, SaveReadingPositionInput } from '../../repositories/reader-repository';
import type { TrashPurgeReceipt } from '../../repositories/library-catalog-repository';
import type { BookLifecycleExpectation, BookMutationExpectation } from '../../repositories/library-catalog-repository';
import type { ChapterReadFilter, ChapterSort } from '../chapters/chapters-screen-model';
import type { LibraryFilter, LibrarySort, LibraryViewMode } from '../library/library-screen-model';
import type { ReaderLocationSnapshot, ReaderMode } from '../reader/reader-screen-contract';

export type BookWorkspaceView = 'library' | 'chapters' | 'reader' | 'document';
export type BookWorkspaceUpdate<Value> = Value | ((previous: Value) => Value);
export type BookWorkspaceNoticeTone = 'info' | 'success' | 'warning' | 'danger';
export interface FixedDocumentPageTarget {
  readonly novelId: string;
  readonly contentRevisionId?: string;
  readonly chapterId: string;
  readonly documentSectionId?: string;
  readonly chapterIndex: number;
  readonly totalPages: number;
}
export interface BookWorkspaceNoticeAction {
  readonly label: string;
  onSelect(): void | Promise<void>;
}

export interface BookWorkspaceState {
  readonly view: BookWorkspaceView;
  readonly novels: Novel[];
  readonly selectedNovel?: Novel;
  readonly chapters: Chapter[];
  readonly currentChapter?: Chapter;
  readonly localReadingPosition?: ReadingPosition;
  readonly remoteReadingPosition?: ReadingPosition;
  readonly libraryQuery: string;
  readonly libraryFilter: LibraryFilter;
  readonly librarySort: LibrarySort;
  readonly libraryViewMode: LibraryViewMode;
  readonly chapterQuery: string;
  readonly chapterReadFilter: ChapterReadFilter;
  readonly chapterSort: ChapterSort;
  readonly outlineQuery: string;
  readonly bookTitleEditing: boolean;
  readonly bookTitleDraft: string;
  readonly readerMode: ReaderMode;
  readonly readerProgress: number;
  readonly readerSessionDisplaySeconds: number;
  readonly readerSessionCommittedSeconds: number;
  readonly readerOpenRequestVersion: number;
  /** One-shot fixed-document entry target used by logical comic/webtoon releases. */
  readonly fixedDocumentOpenChapterId?: string;
}

export interface BookWorkspaceAnnotations {
  readonly bookmarks: Bookmark[];
  readonly highlights: ReaderHighlight[];
  readonly notes: ReaderNote[];
}

export interface BookWorkspaceReaderArtifacts {
  readonly segments: LabeledSegment[];
  readonly characters: Character[];
  readonly voiceProfiles: VoiceProfile[];
}

export interface BookWorkspaceRepositoryPort {
  listChapters(novelId: string, expectedContentRevisionId?: string): Promise<Chapter[]>;
  getNovel(novelId: string): Promise<Novel | undefined>;
  getReadingPosition(novelId: string): Promise<ReadingPosition | undefined>;
  patchNovelMetadata(novelId: string, patch: NovelMetadataPatch, expectation?: BookMutationExpectation): Promise<void>;
  deleteNovel(novelId: string, expectation?: BookLifecycleExpectation): Promise<void>;
  clearReadingPosition(novelId: string, expectedContentRevisionId?: string): Promise<void>;
  saveReadingPosition(input: SaveReadingPositionInput): Promise<void>;
}

export interface BookWorkspaceCatalogPort {
  listTrash(): Promise<Novel[]>;
  restore(bookId: string, expectation?: BookLifecycleExpectation): Promise<unknown>;
  purge(bookId: string, expectation?: BookLifecycleExpectation): Promise<void>;
  emptyTrash(): Promise<TrashPurgeReceipt>;
}

export interface BookWorkspaceAssociationPurgeTarget {
  readonly bookId: string;
  readonly activeContentRevisionId?: string;
}

export interface BookWorkspaceAssociationLifecyclePort {
  prepareBookAssociationPurge(
    targets: readonly BookWorkspaceAssociationPurgeTarget[],
  ): Promise<{ readonly id: string }>;
  completeBookAssociationPurge(intentId: string, confirmedBookIds?: readonly string[]): Promise<unknown>;
}

export interface BookWorkspaceReaderOpenOptions {
  readonly restore?: boolean;
  readonly novel?: Novel;
  readonly position?: ReadingPosition;
  readonly preserveSearch?: boolean;
  readonly targetParagraphId?: string;
  readonly initialMode?: ReaderMode;
  readonly preserveTTS?: boolean;
}

export interface BookWorkspaceTransitionPort {
  flushReaderSession(): Promise<void>;
  resetAnalysis(): void;
  stopChapterTTS(): void;
  stopReaderTTS(): void;
  activateChapter(chapterId: string): void;
  prepareReaderOpen(
    chapterId: string,
    options: {
      restore: boolean;
      position?: ReadingPosition;
      fallbackScrollTop: number;
      preserveSearch?: boolean;
      targetParagraphId?: string;
      initialMode?: ReaderMode;
    },
  ): { readonly sequence: number };
}

export interface BookWorkspaceAdjacentFeaturePort {
  loadBookAnnotations(novelId: string): Promise<BookWorkspaceAnnotations>;
  applyBookAnnotations(annotations: BookWorkspaceAnnotations): void;
  loadReaderArtifacts(chapterId: string, novelId?: string): Promise<BookWorkspaceReaderArtifacts>;
  applyReaderArtifacts(artifacts: BookWorkspaceReaderArtifacts): void;
  resetCorrection(): void;
  resetAnnotationEditor(): void;
  refreshNovels(): Promise<unknown>;
  refreshAfterLocalMutation(kind?: 'progress' | 'statistics'): Promise<unknown>;
  refreshSyncState(): Promise<unknown>;
  refreshAfterLocationConflict(): void;
}

export interface BookWorkspaceEnvironmentPort {
  confirm(message: string): boolean;
  notify(message: string, tone?: BookWorkspaceNoticeTone, action?: BookWorkspaceNoticeAction): void;
  isMutationConflict(error: unknown): boolean;
}

export interface BookWorkspacePorts {
  readonly repository: BookWorkspaceRepositoryPort;
  readonly catalog?: BookWorkspaceCatalogPort;
  readonly associationLifecycle?: BookWorkspaceAssociationLifecyclePort;
  readonly transition: BookWorkspaceTransitionPort;
  readonly adjacent: BookWorkspaceAdjacentFeaturePort;
  readonly environment: BookWorkspaceEnvironmentPort;
}

export interface BookWorkspaceLocationCommit {
  readonly novelId: string;
  readonly chapterId: string;
  readonly location: ReaderLocationSnapshot;
  readonly bookProgress: number;
  readonly updatedAt: string;
}

export type BookWorkspaceSelectionReplacement = Partial<
  Pick<
    BookWorkspaceState,
    'view' | 'selectedNovel' | 'chapters' | 'currentChapter' | 'localReadingPosition' | 'remoteReadingPosition'
  >
>;

export const INITIAL_BOOK_WORKSPACE_STATE: BookWorkspaceState = {
  view: 'library',
  novels: [],
  chapters: [],
  libraryQuery: '',
  libraryFilter: 'all',
  librarySort: 'recent',
  libraryViewMode: 'grid',
  chapterQuery: '',
  chapterReadFilter: 'all',
  chapterSort: 'asc',
  outlineQuery: '',
  bookTitleEditing: false,
  bookTitleDraft: '',
  readerMode: 'read',
  readerProgress: 0,
  readerSessionDisplaySeconds: 0,
  readerSessionCommittedSeconds: 0,
  readerOpenRequestVersion: 0,
};
