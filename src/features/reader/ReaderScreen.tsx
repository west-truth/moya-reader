import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bookmark, Chapter, Paragraph, ReaderAnchor, ReaderHighlight } from '../../domain/types';
import { useAppRuntime } from '../../app/runtime/RuntimeProvider';
import type { ReadingPosition } from '../../sync/types';
import { ReaderChrome } from './ReaderChrome';
import { ReaderSearchResults } from './ReaderSearchResults';
import { ReaderSelectionToolbar } from './ReaderSelectionToolbar';
import {
  ReaderViewport,
  type ReaderAnchorPlacement,
  type ReaderRuntimeFlow,
  type ReaderViewportApi,
} from './ReaderViewport';
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
const SCROLL_HANDOFF_MIN_DURATION_MS = 72;
const SCROLL_HANDOFF_MAX_DURATION_MS = 120;
const SCROLL_HANDOFF_MAX_VIEWPORT_RATIO = 0.8;

function clampScrollHandoffDelta(deltaY: number): number {
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
  const maximumDelta = Math.max(160, viewportHeight * SCROLL_HANDOFF_MAX_VIEWPORT_RATIO);
  return Math.max(-maximumDelta, Math.min(maximumDelta, deltaY));
}

function scrollHandoffDuration(deltaY: number): number {
  return Math.max(
    SCROLL_HANDOFF_MIN_DURATION_MS,
    Math.min(SCROLL_HANDOFF_MAX_DURATION_MS, SCROLL_HANDOFF_MIN_DURATION_MS + Math.abs(deltaY) * 0.08),
  );
}

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
  const modeLock = model.settings.readingProfile.modeLock ?? 'auto';
  const [readingFlow, setReadingFlow] = useState<ReaderRuntimeFlow>(() =>
    modeLock === 'paginated' ? 'paginated' : 'scroll',
  );
  const [pageToScrollSettling, setPageToScrollSettling] = useState(false);
  const settleFrameRef = useRef<number>();
  const scrollHandoffFrameRef = useRef<number>();
  const readingFlowRef = useRef(readingFlow);
  readingFlowRef.current = readingFlow;
  const previousModeLockRef = useRef(modeLock);
  const pendingFlowTransitionRef = useRef<{
    targetFlow: 'scroll' | 'paginated';
    anchor: ReaderAnchor;
    placement?: ReaderAnchorPlacement;
    sourceFlow?: ReaderRuntimeFlow;
    pageDelta?: number;
    scrollDelta?: number;
  }>();
  const lastFlowTransitionRef = useRef<typeof pendingFlowTransitionRef.current>();
  const pageIntentRequestRef = useRef<{
    readonly api?: ReaderViewportApi;
    readonly initialDirection: -1 | 1;
    additionalDelta: number;
  }>();

  const cancelScrollHandoff = useCallback(() => {
    window.cancelAnimationFrame(scrollHandoffFrameRef.current ?? 0);
    scrollHandoffFrameRef.current = undefined;
  }, []);

  const startScrollHandoff = useCallback(
    (api: ReaderViewportApi, requestedDelta: number) => {
      cancelScrollHandoff();
      const delta = clampScrollHandoffDelta(requestedDelta);
      if (Math.abs(delta) < 0.5) return;
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        api.scrollByPixels(delta);
        return;
      }
      const duration = scrollHandoffDuration(delta);
      let startedAt: number | undefined;
      let applied = 0;
      const animate = (now: number) => {
        startedAt ??= now;
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - (1 - progress) ** 3;
        const nextApplied = delta * eased;
        api.scrollByPixels(nextApplied - applied);
        applied = nextApplied;
        if (progress < 1) {
          scrollHandoffFrameRef.current = window.requestAnimationFrame(animate);
        } else {
          scrollHandoffFrameRef.current = undefined;
        }
      };
      scrollHandoffFrameRef.current = window.requestAnimationFrame(animate);
    },
    [cancelScrollHandoff],
  );

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
  const { enterImmersive, exitImmersive, immersive } = chrome;

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
  const flushReaderStateImmediately = useCallback(
    () => flushReaderBoundary(() => viewportApiRef.current?.flushPositionImmediately(), session.flush),
    [session.flush],
  );
  useReaderLifecycleFlush(flushReaderStateImmediately);

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

  useEffect(() => {
    locationRef.current = undefined;
    setLocation(undefined);
  }, [model.chapter.id]);

  const clearSelection = useCallback(() => {
    setSelection(undefined);
    window.getSelection()?.removeAllRanges();
  }, []);

  const toggleImmersive = useCallback(() => {
    if (immersive || !chrome.visible) {
      exitImmersive();
      return;
    }
    setMobileSearchOpen(false);
    setOverflowOpen(false);
    setFootnote(undefined);
    clearSelection();
    if (model.addonOpen) screenHandle.getActions().toggleAddon();
    enterImmersive();
  }, [chrome.visible, clearSelection, enterImmersive, exitImmersive, immersive, model.addonOpen, screenHandle]);

  const handleApiReady = useCallback((api?: ReaderViewportApi) => {
    viewportApiRef.current = api;
    setViewportApi(api);
  }, []);

  useEffect(() => {
    if (previousModeLockRef.current === modeLock) return;
    previousModeLockRef.current = modeLock;
    if (modeLock === 'auto') return;
    const targetFlow: ReaderRuntimeFlow = modeLock;
    if (targetFlow === readingFlow) return;
    const anchor = viewportApiRef.current?.getAnchor();
    if (anchor) {
      pendingFlowTransitionRef.current = {
        targetFlow,
        anchor,
        sourceFlow: viewportApiRef.current?.flow,
      };
      lastFlowTransitionRef.current = pendingFlowTransitionRef.current;
      if (targetFlow === 'scroll' && readingFlow === 'paginated') {
        window.cancelAnimationFrame(settleFrameRef.current ?? 0);
        setPageToScrollSettling(true);
      }
    }
    setReadingFlow(targetFlow);
  }, [modeLock, readingFlow]);

  const requestPageIntent = useCallback(
    (direction: -1 | 1) => {
      cancelScrollHandoff();
      if (readingFlow === 'paginated') {
        const pending = pendingFlowTransitionRef.current;
        if (pending?.targetFlow === 'paginated') {
          pending.pageDelta = (pending.pageDelta ?? 0) + direction;
        } else if (viewportApiRef.current?.flow === 'paginated') {
          viewportApiRef.current.pageJump(direction);
        }
        return;
      }
      if (modeLock === 'scroll') {
        viewportApiRef.current?.scrollPageJump(direction);
        return;
      }
      const existingRequest = pageIntentRequestRef.current;
      if (existingRequest) {
        existingRequest.additionalDelta += direction;
        return;
      }
      const api = viewportApiRef.current;
      const request = { api, initialDirection: direction, additionalDelta: 0 };
      pageIntentRequestRef.current = request;
      const fallbackAnchor = () => {
        const current = api?.getAnchor();
        const fallbackIndex = Math.max(0, (locationRef.current?.paragraphIndex ?? 1) - 1);
        return (
          current ??
          ({
            bookId: model.novel.id,
            contentRevisionId: model.novel.activeContentRevisionId ?? `${model.novel.id}:${model.chapter.id}`,
            sectionId: model.chapter.id,
            blockId: locationRef.current?.paragraph?.id ?? '',
            blockIndex: fallbackIndex,
            offset: locationRef.current?.offsetInParagraph ?? 0,
          } satisfies ReaderAnchor)
        );
      };
      void (api?.getPageTurnAnchor(request.initialDirection) ?? Promise.resolve(undefined))
        .catch(() => undefined)
        .then((resolvedAnchor) => {
          if (pageIntentRequestRef.current !== request) return;
          pageIntentRequestRef.current = undefined;
          if (readingFlowRef.current !== 'scroll' || viewportApiRef.current?.flow !== 'scroll') return;
          const anchor = resolvedAnchor ?? fallbackAnchor();
          const paragraph = anchor.blockId ? api?.getCachedParagraphById(anchor.blockId) : undefined;
          const atChapterEnd =
            request.initialDirection > 0 &&
            (anchor.blockIndex ?? 0) >= model.chapter.paragraphCount - 1 &&
            Boolean(paragraph && anchor.offset >= paragraph.text.length);
          const atChapterStart = request.initialDirection < 0 && (anchor.blockIndex ?? 0) <= 0 && anchor.offset <= 0;
          pendingFlowTransitionRef.current = {
            targetFlow: 'paginated',
            anchor,
            placement:
              atChapterEnd || atChapterStart
                ? 'contain'
                : request.initialDirection < 0
                  ? 'previous-page'
                  : 'page-start',
            sourceFlow: api?.flow,
            pageDelta: (atChapterEnd || atChapterStart ? request.initialDirection : 0) + request.additionalDelta,
          };
          lastFlowTransitionRef.current = pendingFlowTransitionRef.current;
          setReadingFlow('paginated');
        });
    },
    [
      modeLock,
      model.chapter.id,
      model.chapter.paragraphCount,
      model.novel.activeContentRevisionId,
      model.novel.id,
      readingFlow,
      cancelScrollHandoff,
    ],
  );

  const requestScrollIntent = useCallback(
    (deltaY: number) => {
      if (!Number.isFinite(deltaY) || deltaY === 0) return;
      const activeTransition = pendingFlowTransitionRef.current;
      if (activeTransition?.targetFlow === 'scroll') {
        activeTransition.scrollDelta = (activeTransition.scrollDelta ?? 0) + deltaY;
        return;
      }
      if (readingFlow === 'scroll') {
        cancelScrollHandoff();
        viewportApiRef.current?.scrollByPixels(deltaY);
        return;
      }
      if (modeLock === 'paginated') {
        viewportApiRef.current?.pageJump(deltaY > 0 ? 1 : -1);
        return;
      }
      const anchor = viewportApiRef.current?.getAnchor();
      if (!anchor) return;
      pendingFlowTransitionRef.current = {
        targetFlow: 'scroll',
        anchor,
        sourceFlow: viewportApiRef.current?.flow,
        // Preserve the initiating wheel/swipe so a strong continuous-scroll gesture does
        // not appear to stall. It is clamped and eased only after the exact anchor settles.
        scrollDelta: deltaY,
      };
      lastFlowTransitionRef.current = pendingFlowTransitionRef.current;
      window.cancelAnimationFrame(settleFrameRef.current ?? 0);
      cancelScrollHandoff();
      setPageToScrollSettling(true);
      setReadingFlow('scroll');
    },
    [cancelScrollHandoff, modeLock, readingFlow],
  );

  useEffect(() => {
    const pending = pendingFlowTransitionRef.current;
    if (!pending || !viewportApi || pending.targetFlow !== readingFlow || viewportApi.flow !== pending.targetFlow)
      return;
    let cancelled = false;
    void viewportApi.scrollToAnchor(pending.anchor, 0, pending.placement).then((restored) => {
      if (cancelled || pendingFlowTransitionRef.current !== pending) return;
      if (!restored) {
        pendingFlowTransitionRef.current = undefined;
        setPageToScrollSettling(false);
        return;
      }
      pendingFlowTransitionRef.current = undefined;
      const scrollDelta = pending.targetFlow === 'scroll' ? (pending.scrollDelta ?? 0) : 0;
      const pageDelta = pending.pageDelta ?? 0;
      const direction = Math.sign(pageDelta) as -1 | 0 | 1;
      for (let index = 0; index < Math.abs(pageDelta); index += 1) {
        if (direction) viewportApi.pageJump(direction);
      }
      if (pending.targetFlow === 'scroll') {
        window.cancelAnimationFrame(settleFrameRef.current ?? 0);
        settleFrameRef.current = window.requestAnimationFrame(() => {
          setPageToScrollSettling(false);
          if (scrollDelta) {
            scrollHandoffFrameRef.current = window.requestAnimationFrame(() =>
              startScrollHandoff(viewportApi, scrollDelta),
            );
          }
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [readingFlow, startScrollHandoff, viewportApi]);

  useEffect(() => {
    window.cancelAnimationFrame(settleFrameRef.current ?? 0);
    cancelScrollHandoff();
    setPageToScrollSettling(false);
  }, [cancelScrollHandoff, model.chapter.id]);

  useEffect(
    () => () => {
      window.cancelAnimationFrame(settleFrameRef.current ?? 0);
      cancelScrollHandoff();
    },
    [cancelScrollHandoff],
  );

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
    getAnchor: () => viewportApiRef.current?.getAnchor(),
    scrollToAnchor: (anchor) => viewportApiRef.current?.scrollToAnchor(anchor) ?? Promise.resolve(false),
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
      getAnchor: () => implementationRef.current?.getAnchor(),
      scrollToAnchor: (anchor) => implementationRef.current?.scrollToAnchor(anchor) ?? Promise.resolve(false),
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
      previousPage: () => requestPageIntent(-1),
      nextPage: () => requestPageIntent(1),
      toggleChrome: toggleImmersive,
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
    const focusedButtonAllowsPageNavigation =
      ['ArrowRight', 'ArrowDown', 'PageDown', 'ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key) &&
      event.target instanceof HTMLElement &&
      Boolean(event.target.closest('button'));
    if (isInteractiveShortcutTarget(event.target) && !focusedButtonAllowsPageNavigation) return;
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
    if (chrome.immersive && ['/', 'b', 'h', 's', 'o', 'i', 'n'].includes(event.key.toLowerCase())) {
      event.preventDefault();
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
      void actions.toggleBookmark(currentLocation);
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
        chrome.immersive && 'immersive',
        pageToScrollSettling && 'page-to-scroll-settling',
        !chrome.immersive && (chrome.visible || model.settings.keepScreenChrome) && 'chrome-visible',
      )}
      data-reading-mode-lock={modeLock}
      data-reading-flow={readingFlow}
      data-viewport-flow={viewportApi?.flow}
      data-flow-transition-anchor={lastFlowTransitionRef.current?.anchor.blockIndex}
      data-flow-transition-offset={lastFlowTransitionRef.current?.anchor.offset}
      data-flow-transition-placement={lastFlowTransitionRef.current?.placement}
      data-flow-transition-source={lastFlowTransitionRef.current?.sourceFlow}
      data-flow-transition-settling={pageToScrollSettling ? 'true' : 'false'}
      onMouseMove={chrome.reveal}
    >
      <ReaderChrome
        model={model}
        screenHandle={screenHandle}
        viewport={viewportApi}
        chrome={chrome}
        search={search}
        location={location}
        mode={mode}
        readingFlow={readingFlow}
        activeBookmark={activeBookmark}
        activeHighlight={activeHighlight}
        mobileSearchOpen={mobileSearchOpen}
        overflowOpen={overflowOpen}
        onSetMode={setMode}
        onMobileSearchOpenChanged={setMobileSearchOpen}
        onOverflowOpenChanged={setOverflowOpen}
        onGoToSavedPosition={() => void goToSavedPosition()}
        onToggleImmersive={toggleImmersive}
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
        readingFlow={readingFlow}
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
        onToggleImmersive={toggleImmersive}
        onPageIntent={requestPageIntent}
        onScrollIntent={requestScrollIntent}
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
