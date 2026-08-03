import type { Bookmark, Chapter, Novel, Paragraph, ReaderHighlight, ReaderNote } from '../../domain/types';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { ReadingPosition } from '../../sync/types';

export type AnnotationScope = 'all' | 'chapter';
export type AnnotationSort = 'recent' | 'position';
export type AnnotationNoticeTone = 'info' | 'success' | 'warning' | 'danger';

export type AnnotationRepository = Pick<
  ReaderRepository,
  | 'getChapter'
  | 'getParagraph'
  | 'listBookmarks'
  | 'saveBookmark'
  | 'deleteBookmark'
  | 'listHighlights'
  | 'saveHighlight'
  | 'deleteHighlight'
  | 'listNotes'
  | 'saveNote'
  | 'deleteNote'
>;

export interface AnnotationSelection {
  readonly text: string;
  readonly paragraphId?: string;
}

export interface AnnotationLocation {
  readonly progress: number;
  readonly scrollTop: number;
  readonly paragraphIndex: number;
  readonly paragraph?: Paragraph;
}

export interface AnnotationReaderPort {
  getLocation(): AnnotationLocation | undefined;
  getSelection(): AnnotationSelection | undefined;
  getCachedParagraphById(paragraphId: string): Paragraph | undefined;
  clearSelection(): void;
  scrollToParagraph(paragraphId: string): Promise<boolean>;
  scrubTo(progress: number): Promise<void>;
}

export interface AnnotationControllerOptions {
  readonly repository: AnnotationRepository;
  readonly reader: AnnotationReaderPort;
  readonly novel?: Novel;
  readonly chapter?: Chapter;
  readonly chapters: readonly Chapter[];
  readonly activeParagraphId?: string;
  readonly readerProgress: number;
  readonly openChapter: (chapter: Chapter, position: ReadingPosition) => Promise<void>;
  readonly onMutationCommitted: () => Promise<unknown>;
  readonly onPersistenceError: (error: unknown) => Promise<boolean> | boolean;
  readonly notify: (message: string, tone?: AnnotationNoticeTone) => void;
}

export interface AnnotationCollections {
  readonly bookmarks: readonly Bookmark[];
  readonly highlights: readonly ReaderHighlight[];
  readonly notes: readonly ReaderNote[];
}
