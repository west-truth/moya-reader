import type { Chapter, Novel } from '../../domain/types';
import { isFixedDocumentFormat } from '../../domain/book-format';
import type { ReadingPosition } from '../../sync/types';
import type { ChapterReadFilter, ChapterSort } from '../chapters/chapters-screen-model';
import type { LibraryFilter, LibrarySort, LibraryViewMode } from '../library/library-screen-model';
import type { ReaderMode } from '../reader/reader-screen-contract';
import {
  INITIAL_BOOK_WORKSPACE_STATE,
  type BookWorkspaceLocationCommit,
  type BookWorkspacePorts,
  type BookWorkspaceReaderOpenOptions,
  type BookWorkspaceSelectionReplacement,
  type BookWorkspaceState,
  type BookWorkspaceUpdate,
  type BookWorkspaceView,
} from './book-workspace-contract';
import {
  buildBookWorkspaceReadingProjection,
  hasNovelReadActivity,
  selectContinueChapter,
} from './book-workspace-projection';

type Listener = () => void;

function normalizedDocumentSectionTitle(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function legacyDocumentSectionTitle(chapter: Chapter): string | undefined {
  const match = /^(.*?)\s*·\s*[1-9][0-9]*페이지$/u.exec(chapter.title.trim());
  return match?.[1]?.trim() || undefined;
}

function resolveUpdate<Value>(update: BookWorkspaceUpdate<Value>, previous: Value): Value {
  return typeof update === 'function' ? (update as (value: Value) => Value)(previous) : update;
}

export class BookWorkspaceController {
  private state: BookWorkspaceState;
  private ports: BookWorkspacePorts;
  private readonly listeners = new Set<Listener>();
  private navigationGeneration = 0;

  constructor(ports: BookWorkspacePorts, initialState: BookWorkspaceState = INITIAL_BOOK_WORKSPACE_STATE) {
    this.ports = ports;
    this.state = initialState;
  }

  updatePorts(ports: BookWorkspacePorts): void {
    this.ports = ports;
  }

  readonly getSnapshot = (): BookWorkspaceState => this.state;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private updateState(patch: Partial<BookWorkspaceState>): void {
    const changed = (Object.keys(patch) as Array<keyof BookWorkspaceState>).some(
      (key) => !Object.is(this.state[key], patch[key]),
    );
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private beginNavigation(): number {
    this.navigationGeneration += 1;
    return this.navigationGeneration;
  }

  private navigationIsCurrent(generation: number): boolean {
    return this.navigationGeneration === generation;
  }

  readonly setView = (update: BookWorkspaceUpdate<BookWorkspaceView>): void => {
    const view = resolveUpdate(update, this.state.view);
    if (view !== this.state.view) this.beginNavigation();
    this.updateState({ view });
  };

  readonly setNovels = (update: BookWorkspaceUpdate<Novel[]>): void => {
    this.updateState({ novels: resolveUpdate(update, this.state.novels) });
  };

  readonly setSelectedNovel = (update: BookWorkspaceUpdate<Novel | undefined>): void => {
    const previous = this.state.selectedNovel;
    const selectedNovel = resolveUpdate(update, previous);
    if (previous?.id !== selectedNovel?.id) this.beginNavigation();
    const selectionTitleChanged = previous?.id !== selectedNovel?.id || previous?.title !== selectedNovel?.title;
    this.updateState({
      selectedNovel,
      ...(selectionTitleChanged ? { bookTitleDraft: selectedNovel?.title ?? '', bookTitleEditing: false } : undefined),
    });
  };

  readonly setChapters = (update: BookWorkspaceUpdate<Chapter[]>): void => {
    this.updateState({ chapters: resolveUpdate(update, this.state.chapters) });
  };

  readonly setCurrentChapter = (update: BookWorkspaceUpdate<Chapter | undefined>): void => {
    const currentChapter = resolveUpdate(update, this.state.currentChapter);
    if (currentChapter?.id !== this.state.currentChapter?.id) this.beginNavigation();
    this.updateState({ currentChapter });
  };

  readonly setLocalReadingPosition = (update: BookWorkspaceUpdate<ReadingPosition | undefined>): void => {
    this.updateState({ localReadingPosition: resolveUpdate(update, this.state.localReadingPosition) });
  };

  readonly setRemoteReadingPosition = (update: BookWorkspaceUpdate<ReadingPosition | undefined>): void => {
    this.updateState({ remoteReadingPosition: resolveUpdate(update, this.state.remoteReadingPosition) });
  };

  readonly replaceSelection = (replacement: BookWorkspaceSelectionReplacement): void => {
    this.beginNavigation();
    const previousNovel = this.state.selectedNovel;
    const selectedNovel = 'selectedNovel' in replacement ? replacement.selectedNovel : previousNovel;
    const selectionTitleChanged =
      previousNovel?.id !== selectedNovel?.id || previousNovel?.title !== selectedNovel?.title;
    this.updateState({
      ...replacement,
      ...(selectionTitleChanged ? { bookTitleDraft: selectedNovel?.title ?? '', bookTitleEditing: false } : undefined),
    });
  };

  readonly setLibraryQuery = (libraryQuery: string): void => this.updateState({ libraryQuery });
  readonly setLibraryFilter = (libraryFilter: LibraryFilter): void => this.updateState({ libraryFilter });
  readonly setLibrarySort = (librarySort: LibrarySort): void => this.updateState({ librarySort });
  readonly setLibraryViewMode = (libraryViewMode: LibraryViewMode): void => this.updateState({ libraryViewMode });
  readonly setChapterQuery = (chapterQuery: string): void => this.updateState({ chapterQuery });
  readonly setChapterReadFilter = (chapterReadFilter: ChapterReadFilter): void =>
    this.updateState({ chapterReadFilter });
  readonly setChapterSort = (chapterSort: ChapterSort): void => this.updateState({ chapterSort });
  readonly setOutlineQuery = (outlineQuery: string): void => this.updateState({ outlineQuery });
  readonly setBookTitleDraft = (bookTitleDraft: string): void => this.updateState({ bookTitleDraft });
  readonly setReaderMode = (readerMode: ReaderMode): void => this.updateState({ readerMode });
  readonly setReaderSessionDisplaySeconds = (readerSessionDisplaySeconds: number): void =>
    this.updateState({ readerSessionDisplaySeconds });

  private async openNovelForNavigation(
    novel: Novel,
    generation: number,
    prefetched?: { chapters: Chapter[]; readingPosition?: ReadingPosition },
    documentSectionId?: string,
    documentSectionTitle?: string,
  ): Promise<boolean> {
    const [chapters, annotations, readingPosition] = await Promise.all([
      prefetched ? Promise.resolve(prefetched.chapters) : this.ports.repository.listChapters(novel.id),
      this.ports.adjacent.loadBookAnnotations(novel.id),
      prefetched ? Promise.resolve(prefetched.readingPosition) : this.ports.repository.getReadingPosition(novel.id),
    ]);
    if (!this.navigationIsCurrent(generation)) return false;
    const normalizedRequestedTitle = documentSectionTitle
      ? normalizedDocumentSectionTitle(documentSectionTitle)
      : undefined;
    const documentEntryChapter = documentSectionId
      ? (chapters.find((chapter) => chapter.documentSectionId === documentSectionId) ??
        (normalizedRequestedTitle
          ? chapters.find((chapter) => {
              const title = chapter.documentSectionTitle ?? legacyDocumentSectionTitle(chapter);
              return title ? normalizedDocumentSectionTitle(title) === normalizedRequestedTitle : false;
            })
          : undefined))
      : undefined;
    this.updateState({
      remoteReadingPosition: undefined,
      localReadingPosition: readingPosition,
      selectedNovel: novel,
      chapters,
      chapterQuery: '',
      chapterReadFilter: 'all',
      chapterSort: 'asc',
      outlineQuery: '',
      bookTitleDraft: novel.title,
      bookTitleEditing: false,
      fixedDocumentOpenChapterId: documentEntryChapter?.id,
    });
    this.ports.adjacent.applyBookAnnotations(annotations);
    this.updateState({
      currentChapter: isFixedDocumentFormat(novel.format)
        ? (documentEntryChapter ?? chapters.find((chapter) => chapter.id === readingPosition?.chapterId) ?? chapters[0])
        : this.state.currentChapter,
      view: isFixedDocumentFormat(novel.format) ? 'document' : 'chapters',
    });
    return true;
  }

  readonly openNovel = async (novel: Novel): Promise<void> => {
    await this.openNovelForNavigation(novel, this.beginNavigation());
  };

  readonly openDocumentSection = async (
    novel: Novel,
    documentSectionId: string,
    documentSectionTitle?: string,
  ): Promise<void> => {
    await this.openNovelForNavigation(
      novel,
      this.beginNavigation(),
      undefined,
      documentSectionId,
      documentSectionTitle,
    );
  };

  private async openChapterForNavigation(
    chapter: Chapter,
    options: BookWorkspaceReaderOpenOptions,
    generation: number,
  ): Promise<boolean> {
    const restore = options.restore ?? false;
    const novel = options.novel ?? this.state.selectedNovel;
    await this.ports.transition.flushReaderSession();
    if (!this.navigationIsCurrent(generation)) return false;
    this.ports.transition.resetAnalysis();
    if (!options.preserveTTS) this.ports.transition.stopChapterTTS();
    this.updateState({ remoteReadingPosition: undefined });
    const artifacts = await this.ports.adjacent.loadReaderArtifacts(chapter.id, novel?.id);
    if (!this.navigationIsCurrent(generation)) return false;
    this.ports.transition.activateChapter(chapter.id);
    const request = this.ports.transition.prepareReaderOpen(chapter.id, {
      restore,
      position: options.position,
      fallbackScrollTop: restore && novel?.lastReadChapterId === chapter.id ? novel.lastReadOffset : 0,
      preserveSearch: options.preserveSearch,
      targetParagraphId: options.targetParagraphId,
      initialMode: options.initialMode,
    });
    this.updateState({ currentChapter: chapter, readerOpenRequestVersion: request.sequence });
    this.ports.adjacent.applyReaderArtifacts(artifacts);
    this.ports.adjacent.resetCorrection();
    this.ports.adjacent.resetAnnotationEditor();
    this.updateState({
      readerMode: 'read',
      readerProgress: 0,
      readerSessionDisplaySeconds: 0,
      readerSessionCommittedSeconds: 0,
      view: 'reader',
    });
    return true;
  }

  readonly openChapter = async (chapter: Chapter, options: BookWorkspaceReaderOpenOptions = {}): Promise<void> => {
    await this.openChapterForNavigation(chapter, options, this.beginNavigation());
  };

  readonly continueReading = async (novel: Novel | undefined = this.state.selectedNovel): Promise<void> => {
    if (!novel) return;
    const generation = this.beginNavigation();
    const chaptersPromise =
      this.state.chapters.length > 0 && this.state.selectedNovel?.id === novel.id
        ? Promise.resolve(this.state.chapters)
        : this.ports.repository.listChapters(novel.id);
    const [chapters, readingPosition] = await Promise.all([
      chaptersPromise,
      this.ports.repository.getReadingPosition(novel.id),
    ]);
    if (!this.navigationIsCurrent(generation)) return;
    const chapter = selectContinueChapter(chapters, novel, readingPosition);
    if (this.state.selectedNovel?.id !== novel.id) {
      const opened = await this.openNovelForNavigation(novel, generation, { chapters, readingPosition });
      if (!opened) return;
    } else {
      this.updateState({ localReadingPosition: readingPosition });
    }
    if (isFixedDocumentFormat(novel.format)) {
      this.updateState({
        currentChapter: chapters.find((candidate) => candidate.id === readingPosition?.chapterId) ?? chapters[0],
        fixedDocumentOpenChapterId: undefined,
        view: 'document',
      });
      return;
    }
    if (chapter) {
      await this.openChapterForNavigation(chapter, { restore: true, novel, position: readingPosition }, generation);
    }
  };

  readonly openChapterFromList = async (chapter: Chapter, restore = false): Promise<void> => {
    const generation = this.beginNavigation();
    const novel = this.state.selectedNovel;
    const position = restore && novel ? await this.ports.repository.getReadingPosition(novel.id) : undefined;
    if (!this.navigationIsCurrent(generation)) return;
    if (position) this.updateState({ localReadingPosition: position });
    await this.openChapterForNavigation(chapter, { restore, novel, position }, generation);
  };

  readonly returnToChapters = (): void => {
    this.beginNavigation();
    this.ports.transition.stopReaderTTS();
    void this.ports.transition.flushReaderSession();
    this.updateState({ view: 'chapters' });
  };

  readonly saveFixedDocumentPage = async (pageIndex: number): Promise<void> => {
    const novel = this.state.selectedNovel;
    const chapter = [...this.state.chapters].sort((left, right) => left.index - right.index)[pageIndex];
    if (!novel || !chapter || !isFixedDocumentFormat(novel.format)) return;
    const progress = (pageIndex + 1) / this.state.chapters.length;
    try {
      await this.ports.repository.saveReadingPosition({
        novelId: novel.id,
        expectedContentRevisionId: novel.activeContentRevisionId,
        chapterId: chapter.id,
        scrollTop: pageIndex,
        chapterProgress: 1,
        paragraphIndex: 1,
        offsetInParagraph: 0,
      });
      const updatedAt = new Date().toISOString();
      const updatedNovel: Novel = {
        ...novel,
        lastReadChapterId: chapter.id,
        lastReadChapterIndex: chapter.index,
        lastReadOffset: pageIndex,
        lastReadProgress: progress,
        lastReadAt: updatedAt,
        updatedAt,
      };
      this.updateState({
        currentChapter: chapter,
        localReadingPosition: {
          id: `reading_position_${novel.id}`,
          novelId: novel.id,
          chapterId: chapter.id,
          paragraphIndex: 1,
          offsetInParagraph: 0,
          chapterProgress: 1,
          scrollTop: pageIndex,
          deviceId: 'device_local',
          updatedAt,
        },
        selectedNovel: updatedNovel,
        novels: this.state.novels.map((candidate) => (candidate.id === updatedNovel.id ? updatedNovel : candidate)),
      });
      void this.ports.adjacent.refreshAfterLocalMutation('progress');
    } catch (error) {
      this.locationPersistenceFailed(error);
    }
  };

  readonly removeNovel = async (novel: Novel): Promise<void> => {
    const confirmed = this.ports.environment.confirm(
      `"${novel.title}"을(를) 휴지통으로 이동할까요?\n\n본문, 읽던 위치와 주석은 복원할 때까지 보존됩니다.`,
    );
    if (!confirmed) return;
    try {
      await this.ports.repository.deleteNovel(novel.id, novel.metadataRevision ?? 0);
      this.beginNavigation();
      if (this.state.selectedNovel?.id === novel.id) {
        this.updateState({
          selectedNovel: undefined,
          chapters: [],
          currentChapter: undefined,
          localReadingPosition: undefined,
          remoteReadingPosition: undefined,
          view: 'library',
        });
      }
      await this.ports.adjacent.refreshNovels();
      await this.ports.adjacent.refreshAfterLocalMutation();
      this.ports.environment.notify('책을 휴지통으로 이동했습니다.', 'info', {
        label: '실행 취소',
        onSelect: async () => {
          if (!this.ports.catalog) return;
          await this.ports.catalog.restore(novel.id);
          await this.ports.adjacent.refreshNovels();
          await this.ports.adjacent.refreshAfterLocalMutation();
          this.ports.environment.notify('책을 복원했습니다.', 'success');
        },
      });
    } catch {
      this.ports.environment.notify('책을 삭제하지 못했습니다.', 'danger');
    }
  };

  readonly restoreNovel = async (novel: Novel): Promise<void> => {
    if (!this.ports.catalog) {
      this.ports.environment.notify('이 실행 환경에서는 휴지통 복원을 지원하지 않습니다.', 'warning');
      return;
    }
    try {
      await this.ports.catalog.restore(novel.id, novel.metadataRevision ?? 0);
      await this.ports.adjacent.refreshNovels();
      await this.ports.adjacent.refreshAfterLocalMutation();
      this.ports.environment.notify('책을 복원했습니다.', 'success');
    } catch {
      this.ports.environment.notify('책을 복원하지 못했습니다.', 'danger');
    }
  };

  readonly purgeNovel = async (novel: Novel): Promise<void> => {
    if (!this.ports.catalog) return;
    const confirmed = this.ports.environment.confirm(
      `"${novel.title}"을(를) 영구 삭제할까요?\n\n원본 파일, 본문, 읽던 위치와 주석을 복구할 수 없습니다.`,
    );
    if (!confirmed) return;
    try {
      await this.ports.catalog.purge(novel.id, novel.metadataRevision ?? 0);
      await this.ports.adjacent.refreshNovels();
      await this.ports.adjacent.refreshAfterLocalMutation();
      this.ports.environment.notify('책을 영구 삭제했습니다.', 'info');
    } catch {
      this.ports.environment.notify('책을 영구 삭제하지 못했습니다.', 'danger');
    }
  };

  readonly emptyTrash = async (): Promise<void> => {
    if (!this.ports.catalog) return;
    const confirmed = this.ports.environment.confirm(
      '휴지통을 비울까요?\n\n휴지통의 모든 책과 관련 데이터를 복구할 수 없게 됩니다.',
    );
    if (!confirmed) return;
    try {
      const count = await this.ports.catalog.emptyTrash();
      await this.ports.adjacent.refreshNovels();
      await this.ports.adjacent.refreshAfterLocalMutation();
      this.ports.environment.notify(`휴지통에서 ${count}권을 영구 삭제했습니다.`, 'info');
    } catch {
      this.ports.environment.notify('휴지통을 비우지 못했습니다.', 'danger');
    }
  };

  readonly toggleFavorite = async (novel: Novel): Promise<void> => {
    const next = { ...novel, favorite: !novel.favorite };
    await this.ports.repository.patchNovelMetadata(novel.id, { favorite: next.favorite });
    await this.ports.adjacent.refreshNovels();
    await this.ports.adjacent.refreshAfterLocalMutation();
    if (this.state.selectedNovel?.id === novel.id) this.setSelectedNovel(next);
  };

  readonly startBookTitleEdit = (): void => {
    if (!this.state.selectedNovel) return;
    this.updateState({ bookTitleDraft: this.state.selectedNovel.title, bookTitleEditing: true });
  };

  readonly cancelBookTitleEdit = (): void => {
    this.updateState({ bookTitleDraft: this.state.selectedNovel?.title ?? '', bookTitleEditing: false });
  };

  readonly saveBookTitle = async (): Promise<void> => {
    const novel = this.state.selectedNovel;
    if (!novel) return;
    const title = this.state.bookTitleDraft.trim();
    if (!title) {
      this.ports.environment.notify('책 제목을 입력하세요.', 'warning');
      return;
    }
    if (title === novel.title) {
      this.updateState({ bookTitleEditing: false });
      return;
    }
    try {
      const nextNovel = { ...novel, title };
      await this.ports.repository.patchNovelMetadata(novel.id, { title });
      const freshNovel = (await this.ports.repository.getNovel(novel.id)) ?? nextNovel;
      if (this.state.selectedNovel?.id === novel.id) {
        this.updateState({ selectedNovel: freshNovel, bookTitleDraft: freshNovel.title, bookTitleEditing: false });
      }
      await this.ports.adjacent.refreshNovels();
      await this.ports.adjacent.refreshAfterLocalMutation();
      this.ports.environment.notify('책 제목을 저장했습니다.', 'success');
    } catch {
      this.ports.environment.notify('책 제목을 저장하지 못했습니다.', 'danger');
    }
  };

  readonly resetBookProgress = async (): Promise<void> => {
    const novel = this.state.selectedNovel;
    const projection = buildBookWorkspaceReadingProjection(this.state);
    if (!novel || !projection.canResetBookProgress) return;
    const confirmed = this.ports.environment.confirm(
      `"${novel.title}"의 읽은 위치를 초기화할까요?\n\n이어 읽기 위치와 진행률만 지워지고 본문, 북마크, 하이라이트, 메모는 유지됩니다.`,
    );
    if (!confirmed) return;
    try {
      await this.ports.repository.clearReadingPosition(novel.id);
      const [freshNovel, readingPosition] = await Promise.all([
        this.ports.repository.getNovel(novel.id),
        this.ports.repository.getReadingPosition(novel.id),
      ]);
      await this.ports.adjacent.refreshNovels();
      await this.ports.adjacent.refreshAfterLocalMutation();
      if (this.state.selectedNovel?.id === novel.id) {
        this.updateState({
          remoteReadingPosition: undefined,
          localReadingPosition: readingPosition,
          selectedNovel: freshNovel ?? novel,
        });
      }
      this.ports.environment.notify('읽은 위치와 진행률을 초기화했습니다.', 'success');
    } catch (error) {
      await this.handleProgressFailure(
        error,
        '서버에 더 최신 읽은 위치가 있어 초기화하지 않았습니다. 동기화 후 다시 시도하세요.',
        '읽은 위치를 초기화하지 못했습니다.',
      );
    }
  };

  private async saveChapterAsRead(
    chapter: Chapter,
    successMessage: string,
    conflictMessage: string,
    fallbackMessage: string,
  ): Promise<void> {
    const novel = this.state.selectedNovel;
    if (!novel) return;
    try {
      await this.ports.repository.saveReadingPosition({
        novelId: novel.id,
        expectedContentRevisionId: novel.activeContentRevisionId,
        chapterId: chapter.id,
        scrollTop: Number.MAX_SAFE_INTEGER,
        chapterProgress: 1,
        paragraphIndex: chapter.paragraphCount,
        offsetInParagraph: 0,
      });
      const [freshNovel, readingPosition] = await Promise.all([
        this.ports.repository.getNovel(novel.id),
        this.ports.repository.getReadingPosition(novel.id),
      ]);
      await this.ports.adjacent.refreshNovels();
      await this.ports.adjacent.refreshAfterLocalMutation();
      if (this.state.selectedNovel?.id === novel.id) {
        this.updateState({
          remoteReadingPosition: undefined,
          localReadingPosition: readingPosition,
          selectedNovel: freshNovel ?? novel,
        });
      }
      this.ports.environment.notify(successMessage, 'success');
    } catch (error) {
      await this.handleProgressFailure(error, conflictMessage, fallbackMessage);
    }
  }

  private async handleProgressFailure(error: unknown, conflictMessage: string, fallbackMessage: string): Promise<void> {
    if (this.ports.environment.isMutationConflict(error)) {
      this.ports.environment.notify(conflictMessage, 'warning');
      await this.ports.adjacent.refreshSyncState();
      return;
    }
    this.ports.environment.notify(fallbackMessage, 'danger');
  }

  readonly markBookFinished = async (): Promise<void> => {
    const projection = buildBookWorkspaceReadingProjection(this.state);
    if (!this.state.selectedNovel || !projection.canMarkBookFinished) return;
    const lastChapter = [...this.state.chapters].sort((a, b) => b.index - a.index)[0];
    if (!lastChapter) {
      this.ports.environment.notify('완독 처리할 화를 찾지 못했습니다.', 'warning');
      return;
    }
    await this.saveChapterAsRead(
      lastChapter,
      '완독으로 표시했습니다.',
      '서버에 더 최신 읽기 위치가 있어 완독 처리하지 못했습니다. 동기화 후 다시 시도하세요.',
      '완독 처리하지 못했습니다.',
    );
  };

  readonly markCurrentChapterRead = async (): Promise<void> => {
    const projection = buildBookWorkspaceReadingProjection(this.state);
    const chapter = projection.currentReadTargetChapter;
    if (!chapter || !projection.canMarkCurrentChapterRead) return;
    await this.saveChapterAsRead(
      chapter,
      `${chapter.index}화를 읽음으로 표시했습니다.`,
      '서버에 더 최신 읽기 위치가 있어 현재 화를 읽음 처리하지 못했습니다. 동기화 후 다시 시도하세요.',
      '현재 화를 읽음 처리하지 못했습니다.',
    );
  };

  readonly openFirstUnreadChapter = async (): Promise<void> => {
    const projection = buildBookWorkspaceReadingProjection(this.state);
    const novel = this.state.selectedNovel;
    if (!novel || !projection.firstUnreadChapter) return;
    const restore = hasNovelReadActivity(novel) && projection.firstUnreadChapter.id === projection.readChapter?.id;
    await this.openChapterFromList(projection.firstUnreadChapter, restore);
  };

  readonly commitLocation = ({
    novelId,
    chapterId,
    location,
    bookProgress,
    updatedAt,
  }: BookWorkspaceLocationCommit): void => {
    const novel = this.state.selectedNovel;
    const chapter = this.state.currentChapter;
    if (!novel || !chapter || novel.id !== novelId || chapter.id !== chapterId) return;
    const position: ReadingPosition = {
      id: `reading_position_${novel.id}`,
      novelId: novel.id,
      chapterId: chapter.id,
      paragraphId: location.paragraph?.id,
      paragraphIndex: location.paragraphIndex,
      offsetInParagraph: 0,
      chapterProgress: location.progress,
      scrollTop: location.scrollTop,
      deviceId: 'device_local',
      updatedAt,
    };
    this.updateState({
      readerProgress: location.progress,
      localReadingPosition: position,
      selectedNovel: {
        ...novel,
        lastReadChapterId: chapter.id,
        lastReadChapterIndex: chapter.index,
        lastReadOffset: Math.round(location.scrollTop),
        lastReadProgress: bookProgress,
        lastReadParagraphId: location.paragraph?.id,
        updatedAt,
      },
    });
    void this.ports.adjacent.refreshAfterLocalMutation('progress');
  };

  readonly locationPersistenceFailed = (error: unknown): void => {
    if (this.ports.environment.isMutationConflict(error)) {
      this.ports.environment.notify('서버에 더 최신 읽기 위치가 있어 현재 위치를 저장하지 못했습니다.', 'warning');
      this.ports.adjacent.refreshAfterLocationConflict();
      return;
    }
    this.ports.environment.notify('읽기 위치를 저장하지 못했습니다.', 'warning');
  };

  readonly commitSessionTime = (novelId: string, deltaSeconds: number, readAt: string): void => {
    const applyReadingTime = (novel: Novel): Novel =>
      novel.id === novelId
        ? {
            ...novel,
            readingSeconds: Math.max(0, novel.readingSeconds ?? 0) + deltaSeconds,
            lastReadAt: readAt,
            updatedAt: readAt,
          }
        : novel;
    this.updateState({
      selectedNovel: this.state.selectedNovel ? applyReadingTime(this.state.selectedNovel) : undefined,
      novels: this.state.novels.map(applyReadingTime),
      readerSessionCommittedSeconds: this.state.readerSessionCommittedSeconds + deltaSeconds,
    });
    void this.ports.adjacent.refreshAfterLocalMutation('statistics');
  };
}
