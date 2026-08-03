import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bookmark, Chapter, Paragraph, ReaderHighlight } from '../../domain/types';
import { useAppRuntime } from '../../app/runtime/RuntimeProvider';
import type { ReadingPosition } from '../../sync/types';
import { ReaderChrome } from './ReaderChrome';
import { ReaderSearchResults } from './ReaderSearchResults';
import { ReaderSelectionToolbar } from './ReaderSelectionToolbar';
import { ReaderViewport, type ReaderViewportApi } from './ReaderViewport';
import type {
  ReaderLocationSnapshot,
  ReaderMode,
  OpenReaderChapterOptions,
  ReaderScreenCommands,
  ReaderScreenHandle,
  ReaderScreenModel,
  ReaderSelection,
} from './reader-screen-contract';
import { useReaderChrome } from './use-reader-chrome';
import { flushReaderBoundary, useReaderLifecycleFlush } from './use-reader-lifecycle-flush';
import { useReaderSearch } from './use-reader-search';
import { useReaderSession } from './use-reader-session';
import { isInteractiveShortcutTarget, useStableDocumentShortcuts } from './use-stable-document-shortcuts';
import { dispatchReaderAction } from './reader-action-dispatcher';
import { isAndroidBackKeyboardEvent, resolveReaderTransientBackAction } from '../../platform/android/app-navigation';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { EpubFootnoteSheet } from './EpubFootnoteSheet';

const BOOKMARK_PROGRESS_TOLERANCE = 0.003;

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function activeBookmarkAt(
  bookmarks: readonly Bookmark[],
  chapterId: string,
  location?: ReaderLocationSnapshot,
): Bookmark | undefined {
  if (!location) return undefined;
  return bookmarks.find(
    (bookmark) =>
      bookmark.chapterId === chapterId &&
      (bookmark.paragraphId && location.paragraph?.id
        ? bookmark.paragraphId === location.paragraph.id
        : Math.abs(bookmark.progress - location.progress) <= BOOKMARK_PROGRESS_TOLERANCE),
  );
}

function activeHighlightAt(
  highlights: readonly ReaderHighlight[],
  location?: ReaderLocationSnapshot,
): ReaderHighlight | undefined {
  return location?.paragraph
    ? highlights.find((highlight) => highlight.paragraphId === location.paragraph?.id)
    : undefined;
}

export interface ReaderScreenProps {
  readonly model: ReaderScreenModel;
  readonly screenHandle: ReaderScreenHandle;
}

function ReaderScreenComponent({ model, screenHandle }: ReaderScreenProps) {
  const { readerRuntime } = useAppRuntime();
  const repository = readerRuntime.readerRepository;
  const personalizationRepository = readerRuntime.personalizationRepository;
  const viewportApiRef = useRef<ReaderViewportApi>();
  const [viewportApi, setViewportApi] = useState<ReaderViewportApi>();
  const [mode, setModeState] = useState<ReaderMode>('read');
  const [location, setLocation] = useState<ReaderLocationSnapshot>();
  const locationRef = useRef<ReaderLocationSnapshot>();
  const [selection, setSelection] = useState<ReaderSelection>();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [footnote, setFootnote] = useState<{
    chapter: Chapter;
    paragraphs: readonly Paragraph[];
  }>();
  const openRequest = screenHandle.peekOpen(model.chapter.id);
  const openSequence = openRequest?.sequence;
  const preserveSearch = openRequest?.preserveSearch;
  const initialMode = openRequest?.initialMode;

  const notify = useCallback(
    (message: string, tone: 'info' | 'success' | 'warning' | 'danger' = 'warning') => {
      screenHandle.getActions().notify(message, tone);
    },
    [screenHandle],
  );
  const openChapter = useCallback(
    (chapter: Chapter, options: OpenReaderChapterOptions = {}) =>
      screenHandle.getActions().openChapter(chapter, options),
    [screenHandle],
  );
  const scrollToParagraph = useCallback(
    (paragraphId: string) => viewportApiRef.current?.scrollToParagraph(paragraphId) ?? Promise.resolve(false),
    [],
  );
  const search = useReaderSearch({
    repository,
    novel: model.novel,
    chapter: model.chapter,
    chapters: model.chapters,
    scrollToParagraph,
    openChapter,
    notify,
  });
  const clearSearch = search.clear;
  const chrome = useReaderChrome(model.settings.keepScreenChrome, notify);

  const onSessionCommitted = useCallback(
    (novelId: string, seconds: number, readAt: string) =>
      screenHandle.getActions().sessionTimeCommitted(novelId, seconds, readAt),
    [screenHandle],
  );
  const onSessionFailed = useCallback(
    (seconds: number) => screenHandle.getActions().sessionTimePersistenceFailed(seconds),
    [screenHandle],
  );
  const onSessionDisplay = useCallback(
    (seconds: number) => screenHandle.getActions().sessionDisplayChanged(seconds),
    [screenHandle],
  );
  const session = useReaderSession({
    repository,
    novelId: model.novel.id,
    chapterId: model.chapter.id,
    statsVisible: model.statsVisible,
    onCommitted: onSessionCommitted,
    onFailed: onSessionFailed,
    onDisplayChanged: onSessionDisplay,
    personalizationRepository,
  });
  const flushReaderState = useCallback(
    () => flushReaderBoundary(() => viewportApiRef.current?.flushPosition(), session.flush),
    [session.flush],
  );
  useReaderLifecycleFlush(flushReaderState);

  const setMode = useCallback(
    (nextMode: ReaderMode) => {
      setModeState(nextMode);
      screenHandle.getActions().modeChanged(nextMode);
    },
    [screenHandle],
  );

  const handleVisualLocation = useCallback((nextLocation: ReaderLocationSnapshot) => {
    locationRef.current = nextLocation;
    setLocation(nextLocation);
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(undefined);
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleApiReady = useCallback((api?: ReaderViewportApi) => {
    viewportApiRef.current = api;
    setViewportApi(api);
  }, []);

  const goToReadingPosition = useCallback(
    async (position: ReadingPosition): Promise<boolean> => {
      if (position.novelId !== model.novel.id) return false;
      const chapter =
        model.chapters.find((item) => item.id === position.chapterId) ??
        (await repository.getChapter(position.chapterId));
      if (!chapter) return false;
      if (chapter.id !== model.chapter.id) {
        await screenHandle.getActions().openChapter(chapter, { restore: true, position });
        return true;
      }
      if (position.paragraphIndex > 0) {
        await viewportApiRef.current?.scrollToParagraphIndex(position.paragraphIndex - 1, 'start');
        return true;
      }
      if (position.paragraphId && (await viewportApiRef.current?.scrollToParagraph(position.paragraphId))) return true;
      await viewportApiRef.current?.scrubTo(position.chapterProgress);
      chrome.reveal();
      return true;
    },
    [chrome, model.chapter.id, model.chapters, model.novel.id, repository, screenHandle],
  );

  const goToSavedPosition = useCallback(async () => {
    const saved =
      model.localReadingPosition?.novelId === model.novel.id
        ? model.localReadingPosition
        : await repository.getReadingPosition(model.novel.id);
    if (saved && (await goToReadingPosition(saved))) {
      notify('저장된 읽기 위치로 이동했습니다.', 'success');
      return;
    }
    const fallback = model.novel.lastReadChapterId
      ? (model.chapters.find((chapter) => chapter.id === model.novel.lastReadChapterId) ??
        (await repository.getChapter(model.novel.lastReadChapterId)))
      : undefined;
    if (fallback) {
      await screenHandle.getActions().openChapter(fallback, { restore: true });
      notify('저장된 읽기 위치로 이동했습니다.', 'success');
    } else {
      notify('저장된 읽기 위치가 없습니다.');
    }
  }, [goToReadingPosition, model.chapters, model.localReadingPosition, model.novel, notify, repository, screenHandle]);

  const implementationRef = useRef<ReaderScreenCommands>();
  implementationRef.current = {
    resetContent: () => viewportApiRef.current?.resetContent(),
    revealChrome: chrome.reveal,
    flushSession: flushReaderState,
    setMode,
    scrollToParagraph,
    scrollToParagraphIndex: (index, align, behavior) =>
      viewportApiRef.current?.scrollToParagraphIndex(index, align, behavior) ?? Promise.resolve(),
    scrubTo: (progress) => viewportApiRef.current?.scrubTo(progress) ?? Promise.resolve(),
    goToReadingPosition,
    getParagraphAtIndex: (index) => viewportApiRef.current?.getParagraphAtIndex(index) ?? Promise.resolve(undefined),
    getCachedParagraphById: (paragraphId) => viewportApiRef.current?.getCachedParagraphById(paragraphId),
    getLocation: () => viewportApiRef.current?.getLocation() ?? locationRef.current,
    getSelection: () => viewportApiRef.current?.getSelection() ?? selection,
    clearSelection,
  };
  const commands = useMemo<ReaderScreenCommands>(
    () => ({
      resetContent: () => implementationRef.current?.resetContent(),
      revealChrome: () => implementationRef.current?.revealChrome(),
      flushSession: () => implementationRef.current?.flushSession() ?? Promise.resolve(),
      setMode: (nextMode) => implementationRef.current?.setMode(nextMode),
      scrollToParagraph: (paragraphId) =>
        implementationRef.current?.scrollToParagraph(paragraphId) ?? Promise.resolve(false),
      scrollToParagraphIndex: (index, align, behavior) =>
        implementationRef.current?.scrollToParagraphIndex(index, align, behavior) ?? Promise.resolve(),
      scrubTo: (progress) => implementationRef.current?.scrubTo(progress) ?? Promise.resolve(),
      goToReadingPosition: (position) =>
        implementationRef.current?.goToReadingPosition(position) ?? Promise.resolve(false),
      getParagraphAtIndex: (index) =>
        implementationRef.current?.getParagraphAtIndex(index) ?? Promise.resolve(undefined),
      getCachedParagraphById: (paragraphId) => implementationRef.current?.getCachedParagraphById(paragraphId),
      getLocation: () => implementationRef.current?.getLocation(),
      getSelection: () => implementationRef.current?.getSelection(),
      clearSelection: () => implementationRef.current?.clearSelection(),
    }),
    [],
  );

  useEffect(() => screenHandle.registerCommands(commands), [commands, screenHandle]);

  useEffect(() => {
    if (openSequence === undefined) return;
    setSelection(undefined);
    setFootnote(undefined);
    setOverflowOpen(false);
    if (!preserveSearch) clearSearch();
    setMode(initialMode ?? 'read');
  }, [clearSearch, initialMode, openSequence, preserveSearch, setMode]);

  const navigateToDocumentParagraph = useCallback(
    async (targetChapter: Chapter, paragraph: Paragraph) => {
      if (targetChapter.id !== model.chapter.id) {
        await screenHandle.getActions().openChapter(targetChapter, { targetParagraphId: paragraph.id });
      } else {
        await viewportApiRef.current?.scrollToParagraph(paragraph.id);
      }
    },
    [model.chapter.id, screenHandle],
  );

  const handleDocumentLink = useCallback(
    async (href: string, isFootnote: boolean) => {
      if (/^https?:\/\//i.test(href)) {
        if (window.confirm('외부 링크를 브라우저에서 열까요?')) window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      const targetHref = href.split('#', 1)[0];
      const currentChapter = model.chapters.find((candidate) => candidate.id === model.chapter.id);
      const candidates = [
        currentChapter,
        ...model.chapters.filter((candidate) => candidate.id !== model.chapter.id),
      ].filter((candidate): candidate is Chapter => Boolean(candidate));
      for (const candidate of candidates) {
        const matches: Paragraph[] = [];
        for (let pageIndex = 0; pageIndex < Math.ceil(candidate.paragraphCount / PARAGRAPHS_PER_PAGE); pageIndex += 1) {
          const page = await repository.getParagraphPage(candidate.id, pageIndex);
          matches.push(
            ...(page?.paragraphs.filter(
              (paragraph) =>
                paragraph.sourceHref === href ||
                (!href.includes('#') && paragraph.sourceHref?.split('#', 1)[0] === targetHref),
            ) ?? []),
          );
        }
        const target = matches[0];
        if (!target) continue;
        if (isFootnote) {
          setFootnote({ chapter: candidate, paragraphs: matches });
          return;
        }
        await navigateToDocumentParagraph(candidate, target);
        return;
      }
      notify('링크가 가리키는 위치를 찾을 수 없습니다.', 'warning');
    },
    [model.chapter.id, model.chapters, navigateToDocumentParagraph, notify, repository],
  );

  const dispatchAction = (action: 'previous_page' | 'next_page') =>
    dispatchReaderAction(action, {
      previousPage: () => viewportApiRef.current?.pageJump(-1),
      nextPage: () => viewportApiRef.current?.pageJump(1),
      toggleChrome: chrome.visible ? chrome.hide : chrome.reveal,
      openToc: () => screenHandle.getActions().openAddon('outline'),
      openSettings: () => screenHandle.getActions().openSettings(),
      toggleTTS: () => screenHandle.getActions().toggleTTS(locationRef.current?.ttsIndex ?? 0),
    });

  useStableDocumentShortcuts(true, (event) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && footnote) {
      event.preventDefault();
      setFootnote(undefined);
      return;
    }
    if (isInteractiveShortcutTarget(event.target)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const actions = screenHandle.getActions();
    if (model.overlays.settingsOpen || model.overlays.syncPanelOpen || model.overlays.importOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        actions.closeActiveLayer();
      }
      return;
    }
    if (event.key === 'Escape') {
      if (isAndroidBackKeyboardEvent(event)) {
        const backAction = resolveReaderTransientBackAction({
          overflowOpen,
          selectionOpen: Boolean(selection),
          mobileSearchOpen,
          searchActive: Boolean(search.query.trim()),
        });
        let handled = true;
        if (backAction === 'close-overflow') setOverflowOpen(false);
        else if (backAction === 'close-selection') clearSelection();
        else if (backAction === 'close-mobile-search') setMobileSearchOpen(false);
        else if (backAction === 'clear-search') search.clear();
        else handled = actions.closeActiveLayer();
        if (handled) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (mobileSearchOpen) setMobileSearchOpen(false);
      else if (search.query.trim()) search.clear();
      else if (!actions.closeActiveLayer()) chrome.hide();
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      chrome.reveal();
      if (window.matchMedia('(max-width: 980px)').matches) setMobileSearchOpen(true);
      window.setTimeout(search.focus, 0);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      void viewportApiRef.current?.scrubTo(event.key === 'Home' ? 0 : 1);
      return;
    }
    if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      const direction = event.key === '[' ? -1 : 1;
      const chapter = model.chapters.find((item) => item.index === model.chapter.index + direction);
      if (chapter) void actions.openChapter(chapter, { restore: direction < 0 });
      return;
    }
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) {
      event.preventDefault();
      dispatchAction('next_page');
      return;
    }
    if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      dispatchAction('previous_page');
      return;
    }
    const key = event.key.toLowerCase();
    const currentLocation = viewportApiRef.current?.getLocation() ?? locationRef.current;
    if (key === 'b' && currentLocation) {
      event.preventDefault();
      actions.toggleBookmark(currentLocation);
    } else if (key === 'h' && currentLocation) {
      event.preventDefault();
      actions.addHighlight(currentLocation);
    } else if (key === 's') {
      event.preventDefault();
      actions.openSettings();
    } else if (key === 'f') {
      event.preventDefault();
      void chrome.toggleFullscreen();
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      actions.adjustFontSize(1);
    } else if (event.key === '-') {
      event.preventDefault();
      actions.adjustFontSize(-1);
    } else if (event.key === ',') {
      event.preventDefault();
      actions.adjustContentWidth(-40);
    } else if (event.key === '.') {
      event.preventDefault();
      actions.adjustContentWidth(40);
    } else if (key === 'o' || key === 'i' || key === 'n') {
      event.preventDefault();
      actions.openAddon(key === 'o' ? 'outline' : key === 'i' ? 'info' : 'notes');
    }
  });

  const activeBookmark = activeBookmarkAt(model.bookmarks, model.chapter.id, location);
  const activeHighlight = activeHighlightAt(model.highlights, location);
  return (
    <main
      className={classNames(
        'reader-screen',
        model.addonOpen && 'addon-open',
        mobileSearchOpen && 'mobile-search-open',
        (chrome.visible || model.settings.keepScreenChrome) && 'chrome-visible',
      )}
      onMouseMove={chrome.reveal}
      onClick={chrome.reveal}
    >
      <ReaderChrome
        model={model}
        screenHandle={screenHandle}
        viewport={viewportApi}
        chrome={chrome}
        search={search}
        location={location}
        mode={mode}
        activeBookmark={activeBookmark}
        activeHighlight={activeHighlight}
        mobileSearchOpen={mobileSearchOpen}
        overflowOpen={overflowOpen}
        onSetMode={setMode}
        onMobileSearchOpenChanged={setMobileSearchOpen}
        onOverflowOpenChanged={setOverflowOpen}
        onGoToSavedPosition={() => void goToSavedPosition()}
      />
      {search.query.trim() && (
        <aside className="reader-search-results-layer" aria-label="본문 검색 결과">
          <ReaderSearchResults search={search} chapters={model.chapters} />
        </aside>
      )}
      <ReaderViewport
        key={model.chapter.id}
        repository={repository}
        novel={model.novel}
        chapter={model.chapter}
        chapters={model.chapters}
        settings={model.settings}
        mode={mode}
        ttsIndex={model.ttsIndex}
        search={search}
        screenHandle={screenHandle}
        openRequest={openRequest}
        apiRef={viewportApiRef}
        onApiReady={handleApiReady}
        onVisualLocation={handleVisualLocation}
        onSelectionChanged={setSelection}
        onRevealChrome={chrome.reveal}
        onToggleChrome={chrome.visible ? chrome.hide : chrome.reveal}
        onDocumentLink={(href, isFootnote) => void handleDocumentLink(href, isFootnote)}
        assetRepository={readerRuntime.bookAssetRepository}
      />
      {footnote && (
        <EpubFootnoteSheet
          paragraphs={footnote.paragraphs}
          onClose={() => setFootnote(undefined)}
          onOpenInDocument={() => {
            const target = footnote.paragraphs[0];
            setFootnote(undefined);
            if (target) void navigateToDocumentParagraph(footnote.chapter, target);
          }}
        />
      )}
      {selection && (
        <ReaderSelectionToolbar
          selection={selection}
          location={location}
          screenHandle={screenHandle}
          onClear={clearSelection}
        />
      )}
    </main>
  );
}

export default memo(ReaderScreenComponent);
