import type {
  Bookmark,
  Chapter,
  Novel,
  Paragraph,
  ReaderAnchor,
  ReaderHighlight,
  ReaderSettings,
} from '../../domain/types';
import type { ActiveTTSPlayback } from '../../providers/tts-playback-session';
import type { ReadingPosition } from '../../sync/types';
import { ReaderDecorationStore, type ReaderDecorationInput } from './reader-decoration-store';

export type ReaderMode = 'read' | 'listen' | 'analysis' | 'correction';
export type ReaderAddonTab = 'info' | 'outline' | 'tts' | 'ai' | 'notes' | 'stats';
export type ReaderHighlightColor = ReaderHighlight['color'];

export interface ReaderSelection {
  readonly text: string;
  readonly paragraphId: string;
}

export interface ReaderLocationSnapshot {
  readonly progress: number;
  readonly scrollTop: number;
  readonly paragraphIndex: number;
  readonly paragraph?: Paragraph;
  readonly offsetInParagraph?: number;
  readonly ttsIndex: number;
}

export interface ReaderOpenRequest {
  readonly sequence: number;
  readonly chapterId: string;
  readonly restore: boolean;
  readonly position?: ReadingPosition;
  readonly fallbackScrollTop: number;
  readonly preserveSearch: boolean;
  readonly targetParagraphId?: string;
  readonly initialMode?: ReaderMode;
}

export interface OpenReaderChapterOptions {
  readonly restore?: boolean;
  readonly position?: ReadingPosition;
  readonly preserveSearch?: boolean;
  readonly targetParagraphId?: string;
  readonly initialMode?: ReaderMode;
}

export interface ReaderOverlayState {
  readonly settingsOpen: boolean;
  readonly syncPanelOpen: boolean;
  readonly importOpen: boolean;
}

export interface ReaderScreenModel {
  readonly novel: Pick<
    Novel,
    'id' | 'title' | 'totalChapters' | 'lastReadChapterId' | 'activeContentRevisionId' | 'format'
  >;
  readonly chapter: Chapter;
  readonly chapters: readonly Chapter[];
  readonly settings: ReaderSettings;
  readonly bookmarks: readonly Bookmark[];
  readonly highlights: readonly ReaderHighlight[];
  readonly localReadingPosition?: ReadingPosition;
  readonly addonOpen: boolean;
  readonly addonTab: ReaderAddonTab;
  readonly overlays: ReaderOverlayState;
  readonly ttsIndex?: number;
  readonly activeTTSPlayback?: ActiveTTSPlayback;
  readonly canRestoreSavedPosition: boolean;
  readonly statsVisible: boolean;
  readonly openRequestVersion: number;
}

export interface ReaderScreenActions {
  readonly openChapter: (chapter: Chapter, options?: OpenReaderChapterOptions) => Promise<void>;
  readonly returnToChapters: () => void;
  readonly openSettings: () => void;
  readonly openSync: () => void;
  readonly toggleAddon: () => void;
  readonly openAddon: (tab: ReaderAddonTab) => void;
  readonly closeActiveLayer: () => boolean;
  readonly adjustFontSize: (delta: number) => void;
  readonly adjustContentWidth: (delta: number) => void;
  readonly toggleNightTheme: () => void;
  readonly toggleBookmark: (location: ReaderLocationSnapshot) => Promise<void>;
  readonly addHighlight: (location: ReaderLocationSnapshot, selection?: ReaderSelection) => void;
  readonly highlightSelection: (
    location: ReaderLocationSnapshot,
    selection: ReaderSelection,
    color: ReaderHighlightColor,
  ) => void;
  readonly openSelectionNote: (selection: ReaderSelection) => void;
  readonly previewSelectionTTS: (selection: ReaderSelection) => void;
  readonly selectCorrectionSegment: (segmentId: string) => void;
  readonly startTTS: (paragraphIndex: number) => void;
  readonly toggleTTS: (paragraphIndex: number) => void;
  readonly modeChanged: (mode: ReaderMode) => void;
  readonly locationCommitted: (location: ReaderLocationSnapshot, bookProgress: number, updatedAt: string) => void;
  readonly locationPersistenceFailed: (error: unknown) => void;
  readonly sessionTimeCommitted: (novelId: string, seconds: number, readAt: string) => void;
  readonly sessionTimePersistenceFailed: (seconds: number) => void;
  readonly sessionDisplayChanged: (seconds: number) => void;
  readonly notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'danger') => void;
}

export interface ReaderScreenCommands {
  readonly resetContent: () => void;
  readonly revealChrome: () => void;
  readonly flushSession: () => Promise<void>;
  readonly setMode: (mode: ReaderMode) => void;
  readonly scrollToParagraph: (paragraphId: string) => Promise<boolean>;
  readonly scrollToParagraphIndex: (
    paragraphIndex: number,
    align?: 'start' | 'center' | 'end',
    behavior?: ScrollBehavior,
  ) => Promise<void>;
  readonly scrubTo: (progress: number) => Promise<void>;
  readonly goToReadingPosition: (position: ReadingPosition) => Promise<boolean>;
  readonly getParagraphAtIndex: (paragraphIndex: number) => Promise<Paragraph | undefined>;
  readonly getCachedParagraphById: (paragraphId: string) => Paragraph | undefined;
  readonly getLocation: () => ReaderLocationSnapshot | undefined;
  readonly getAnchor: () => ReaderAnchor | undefined;
  readonly scrollToAnchor: (anchor: ReaderAnchor) => Promise<boolean>;
  readonly getSelection: () => ReaderSelection | undefined;
  readonly clearSelection: () => void;
}

const NO_ACTIONS: ReaderScreenActions = {
  openChapter: async () => undefined,
  returnToChapters: () => undefined,
  openSettings: () => undefined,
  openSync: () => undefined,
  toggleAddon: () => undefined,
  openAddon: () => undefined,
  closeActiveLayer: () => false,
  adjustFontSize: () => undefined,
  adjustContentWidth: () => undefined,
  toggleNightTheme: () => undefined,
  toggleBookmark: async () => undefined,
  addHighlight: () => undefined,
  highlightSelection: () => undefined,
  openSelectionNote: () => undefined,
  previewSelectionTTS: () => undefined,
  selectCorrectionSegment: () => undefined,
  startTTS: () => undefined,
  toggleTTS: () => undefined,
  modeChanged: () => undefined,
  locationCommitted: () => undefined,
  locationPersistenceFailed: () => undefined,
  sessionTimeCommitted: () => undefined,
  sessionTimePersistenceFailed: () => undefined,
  sessionDisplayChanged: () => undefined,
  notify: () => undefined,
};

export class ReaderScreenHandle {
  readonly decorations = new ReaderDecorationStore();

  private actions: ReaderScreenActions = NO_ACTIONS;
  private commands?: ReaderScreenCommands;
  private openSequence = 0;
  private pendingOpen?: ReaderOpenRequest;
  private resetGeneration = 0;

  setActions(actions: ReaderScreenActions): void {
    this.actions = actions;
  }

  getActions(): ReaderScreenActions {
    return this.actions;
  }

  registerCommands(commands: ReaderScreenCommands): () => void {
    this.commands = commands;
    return () => {
      if (this.commands === commands) this.commands = undefined;
    };
  }

  prepareOpen(
    chapterId: string,
    options: {
      restore?: boolean;
      position?: ReadingPosition;
      fallbackScrollTop?: number;
      preserveSearch?: boolean;
      targetParagraphId?: string;
      initialMode?: ReaderMode;
    } = {},
  ): ReaderOpenRequest {
    const request: ReaderOpenRequest = {
      sequence: ++this.openSequence,
      chapterId,
      restore: options.restore ?? false,
      position: options.position,
      fallbackScrollTop: options.fallbackScrollTop ?? 0,
      preserveSearch: options.preserveSearch ?? false,
      targetParagraphId: options.targetParagraphId,
      initialMode: options.initialMode,
    };
    this.pendingOpen = request;
    return request;
  }

  peekOpen(chapterId: string): ReaderOpenRequest | undefined {
    return this.pendingOpen?.chapterId === chapterId ? this.pendingOpen : undefined;
  }

  acknowledgeOpen(sequence: number): void {
    if (this.pendingOpen?.sequence === sequence) this.pendingOpen = undefined;
  }

  updateDecorations(input: ReaderDecorationInput): void {
    this.decorations.update(input);
  }

  resetContent(): void {
    this.resetGeneration += 1;
    this.commands?.resetContent();
  }

  revealChrome(): void {
    this.commands?.revealChrome();
  }

  getResetGeneration(): number {
    return this.resetGeneration;
  }

  flushSession(): Promise<void> {
    return this.commands?.flushSession() ?? Promise.resolve();
  }

  setMode(mode: ReaderMode): void {
    this.commands?.setMode(mode);
  }

  scrollToParagraph(paragraphId: string): Promise<boolean> {
    return this.commands?.scrollToParagraph(paragraphId) ?? Promise.resolve(false);
  }

  scrollToParagraphIndex(
    paragraphIndex: number,
    align?: 'start' | 'center' | 'end',
    behavior?: ScrollBehavior,
  ): Promise<void> {
    return this.commands?.scrollToParagraphIndex(paragraphIndex, align, behavior) ?? Promise.resolve();
  }

  scrubTo(progress: number): Promise<void> {
    return this.commands?.scrubTo(progress) ?? Promise.resolve();
  }

  goToReadingPosition(position: ReadingPosition): Promise<boolean> {
    return this.commands?.goToReadingPosition(position) ?? Promise.resolve(false);
  }

  getParagraphAtIndex(paragraphIndex: number): Promise<Paragraph | undefined> {
    return this.commands?.getParagraphAtIndex(paragraphIndex) ?? Promise.resolve(undefined);
  }

  getCachedParagraphById(paragraphId: string): Paragraph | undefined {
    return this.commands?.getCachedParagraphById(paragraphId);
  }

  getLocation(): ReaderLocationSnapshot | undefined {
    return this.commands?.getLocation();
  }

  getAnchor(): ReaderAnchor | undefined {
    return this.commands?.getAnchor();
  }

  scrollToAnchor(anchor: ReaderAnchor): Promise<boolean> {
    return this.commands?.scrollToAnchor(anchor) ?? Promise.resolve(false);
  }

  getSelection(): ReaderSelection | undefined {
    return this.commands?.getSelection();
  }

  clearSelection(): void {
    this.commands?.clearSelection();
  }
}
