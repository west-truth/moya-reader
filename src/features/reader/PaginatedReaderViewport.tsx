import { AutoReadingPresentation } from './auto-reading-modes';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Paragraph, ReaderAnchor, ReaderPageBoundary } from '../../domain/types';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import type { ReaderRepository } from '../../repositories/reader-repository';
import {
  loadReaderPageMap,
  pruneReaderPageMaps,
  saveReaderPageMap,
  type ReaderPageMapIdentity,
} from '../../storage/reader-page-map-store';
import { resolveRestoreReadingPositionTarget } from '../../reader/reading-position';
import { clamp } from '../../utils/format';
import { ReaderParagraphRow } from './ReaderParagraphRow';
import { ReaderChapterHeading, showChapterSequence } from './ReaderChapterHeading';
import type { ReaderViewportApi, ReaderViewportLayerProps, ReaderAnchorPlacement } from './ReaderViewport';
import { scheduleIdleWork } from './idle-work';
import { useReaderGestureHandlers } from './use-reader-gestures';
import { useReaderPositionPersistence } from './use-reader-progress';
import {
  adjacentChapterPrefetchPages,
  LruMap,
  sliceParagraphForPage,
  type ReaderPageFragment,
} from './reader-pagination-model';
import { ReaderPageWindow } from './reader-page-window';
import { measureAdjacentPage } from './pagination-measurement';

const PAGINATION_RENDERER_VERSION = 'reader-pagination-v9-spread';
const PAGE_MAP_CACHE_LIMIT = 24;
const PAGE_TURN_DURATION_MS = 240;
const SHARED_PARAGRAPH_PAGE_CACHE_LIMIT = 64;

interface CachedPageMap {
  readonly key: string;
  readonly boundaries: readonly ReaderPageBoundary[];
}

const pageMapCache = new Map<string, CachedPageMap>();
const sharedParagraphPages = new LruMap<string, readonly Paragraph[]>(SHARED_PARAGRAPH_PAGE_CACHE_LIMIT);
const sharedParagraphPageLoads = new Map<string, Promise<readonly Paragraph[]>>();

async function loadSharedParagraphPage(
  repository: ReaderRepository,
  contentRevisionId: string,
  chapterId: string,
  pageIndex: number,
): Promise<readonly Paragraph[]> {
  const key = `${contentRevisionId}:${chapterId}:${pageIndex}`;
  const cached = sharedParagraphPages.get(key);
  if (cached) return cached;
  const existing = sharedParagraphPageLoads.get(key);
  if (existing) return existing;
  const pending = repository
    .getParagraphPage(chapterId, pageIndex)
    .then((page) => {
      const paragraphs = page?.paragraphs ?? [];
      sharedParagraphPages.set(key, paragraphs);
      return paragraphs;
    })
    .finally(() => sharedParagraphPageLoads.delete(key));
  sharedParagraphPageLoads.set(key, pending);
  return pending;
}

function cachePageMap(value: CachedPageMap): void {
  pageMapCache.delete(value.key);
  pageMapCache.set(value.key, value);
  while (pageMapCache.size > PAGE_MAP_CACHE_LIMIT) {
    const oldest = pageMapCache.keys().next().value as string | undefined;
    if (!oldest) break;
    pageMapCache.delete(oldest);
  }
}

function getCachedPageMap(key: string): CachedPageMap | undefined {
  const value = pageMapCache.get(key);
  if (!value) return undefined;
  pageMapCache.delete(key);
  pageMapCache.set(key, value);
  return value;
}

export function PaginatedReaderViewport(
  props: ReaderViewportLayerProps & {
    readonly onPaginationFailure: () => void;
    readonly initialAnchor?: ReaderAnchor;
  },
) {
  const {
    repository,
    novel,
    chapter,
    chapters,
    settings,
    mode,
    ttsIndex,
    search,
    screenHandle,
    openRequest,
    apiRef,
    onApiReady,
    onVisualLocation,
    onSelectionChanged,
    onRevealChrome,
    onToggleImmersive,
    onScrollIntent,
    onDocumentLink,
    assetRepository,
    onPaginationFailure,
    isActive,
    positionPersistence,
  } = props;
  const chapterHeading = useMemo(
    () => ({
      index: chapter.index,
      title: chapter.title,
      documentSectionId: chapter.documentSectionId,
      documentSectionTitle: chapter.documentSectionTitle,
    }),
    [chapter.index, chapter.title, chapter.documentSectionId, chapter.documentSectionTitle],
  );
  const rootRef = useRef<HTMLElement>(null);
  const autoOverlayRef = useRef<HTMLDivElement>(null);
  const autoPresentation = useRef(new AutoReadingPresentation());
  const autoGeneration = useRef(0);
  const autoNeighbor = useRef<{ key: string; loading: boolean; boundary?: ReaderPageBoundary; failed?: boolean }>();
  const autoTurning = useRef(false);
  const resetAutoReading = useCallback(() => {
    if (autoTurning.current) navigationRef.current++;
    autoGeneration.current++;
    autoNeighbor.current = undefined;
    autoTurning.current = false;
    autoPresentation.current.reset(autoOverlayRef.current);
  }, []);
  const stageRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const activeChapterIdRef = useRef(chapter.id);
  const paragraphCacheRef = useRef(new Map<number, Paragraph>());
  const paragraphPageLoadsRef = useRef(new Map<number, Promise<void>>());
  const transitionTimerRef = useRef<number>();
  const wheelDeltaRef = useRef(0);
  const pageTurnQueueRef = useRef(Promise.resolve());
  const navigationRef = useRef(0);
  const visibleAnchorRef = useRef<ReaderAnchor>();
  const appliedOpenSequenceRef = useRef<number>();
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const spreadActive =
    dimensions.width >= 760 &&
    (settings.readingProfile.pageSpread === 'double' ||
      (settings.readingProfile.pageSpread === 'auto' && dimensions.width >= 1100));
  const pageGap = spreadActive ? 24 : 0;
  const availablePageWidth = spreadActive ? Math.floor((dimensions.width - pageGap) / 2) : dimensions.width;
  const pageWidth = Math.min(settings.readingProfile.contentWidth, availablePageWidth);
  const [view, setView] = useState<{
    key: string;
    boundary: ReaderPageBoundary;
    fragments: readonly ReaderPageFragment[];
    secondaryBoundary?: ReaderPageBoundary;
    secondaryFragments?: readonly ReaderPageFragment[];
  }>();
  const viewRef = useRef(view);
  const [preparing, setPreparing] = useState(true);
  const [outgoingFragments, setOutgoingFragments] = useState<readonly ReaderPageFragment[]>([]);
  const [outgoingSecondaryFragments, setOutgoingSecondaryFragments] = useState<readonly ReaderPageFragment[]>([]);
  const [transitionDirection, setTransitionDirection] = useState<-1 | 1>();
  const [transitionSequence, setTransitionSequence] = useState(0);
  const bodyKey = `${novel.id}:${chapter.id}:${chapter.textHash}:${chapter.paragraphCount}`;
  const renderedRevisionRef = useRef({ bodyKey, contentRevisionId: novel.activeContentRevisionId ?? bodyKey });
  if (renderedRevisionRef.current.bodyKey !== bodyKey) {
    renderedRevisionRef.current = { bodyKey, contentRevisionId: novel.activeContentRevisionId ?? bodyKey };
  }
  const contentRevisionId = renderedRevisionRef.current.contentRevisionId;
  activeChapterIdRef.current = `${chapter.id}:${contentRevisionId}`;
  useEffect(() => {
    paragraphCacheRef.current.clear();
    paragraphPageLoadsRef.current.clear();
    visibleAnchorRef.current = undefined;
  }, [bodyKey]);
  const { schedule: schedulePosition, flush: flushPosition } = useReaderPositionPersistence({
    isActive: isActive && !preparing && !props.pageTransitionPending,
    positionPersistence,
    repository,
    novel,
    chapter,
    debounceMs: 250,
    onLocationCommitted: (nextLocation, nextBookProgress, updatedAt) =>
      screenHandle.getActions().locationCommitted(nextLocation, nextBookProgress, updatedAt),
    onPersistenceFailed: (error) => screenHandle.getActions().locationPersistenceFailed(error),
  });
  const getParagraphAtIndex = useCallback(
    async (index: number): Promise<Paragraph | undefined> => {
      if (index < 0 || index >= chapter.paragraphCount) return undefined;
      const cached = paragraphCacheRef.current.get(index);
      if (cached) {
        paragraphCacheRef.current.delete(index);
        paragraphCacheRef.current.set(index, cached);
        return cached;
      }
      const pageIndex = Math.floor(index / PARAGRAPHS_PER_PAGE);
      let pending = paragraphPageLoadsRef.current.get(pageIndex);
      if (!pending) {
        const requestedChapterId = `${chapter.id}:${contentRevisionId}`;
        pending = loadSharedParagraphPage(repository, contentRevisionId, chapter.id, pageIndex).then((paragraphs) => {
          if (activeChapterIdRef.current !== requestedChapterId) return;
          for (const paragraph of paragraphs) {
            const logicalIndex = paragraph.index - 1;
            paragraphCacheRef.current.delete(logicalIndex);
            paragraphCacheRef.current.set(logicalIndex, paragraph);
          }
        });
        paragraphPageLoadsRef.current.set(pageIndex, pending);
        void pending.then(
          () => paragraphPageLoadsRef.current.delete(pageIndex),
          () => paragraphPageLoadsRef.current.delete(pageIndex),
        );
      }
      await pending;
      while (paragraphCacheRef.current.size > 256) {
        const oldest = paragraphCacheRef.current.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        paragraphCacheRef.current.delete(oldest);
      }
      return paragraphCacheRef.current.get(index);
    },
    [chapter.id, chapter.paragraphCount, contentRevisionId, repository],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let resizeFrame: number | undefined;
    const publish = () => {
      const next = { width: Math.floor(stage.clientWidth), height: Math.floor(stage.clientHeight) };
      setDimensions((current) => (current.width === next.width && current.height === next.height ? current : next));
    };
    publish();
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(resizeFrame ?? 0);
      resizeFrame = window.requestAnimationFrame(publish);
    });
    observer.observe(stage);
    return () => {
      window.cancelAnimationFrame(resizeFrame ?? 0);
      observer.disconnect();
    };
  }, []);

  const layoutKey = useMemo(
    () =>
      JSON.stringify({
        contentRevisionId,
        rendererVersion: PAGINATION_RENDERER_VERSION,
        ...(showChapterSequence(chapterHeading) ? {} : { chapterHeading: 'source-title' }),
        viewportWidth: pageWidth,
        viewportHeight: dimensions.height,
        devicePixelRatioBucket: Math.round((globalThis.devicePixelRatio || 1) * 2) / 2,
        fontId: settings.readingProfile.fontId,
        fontSize: settings.readingProfile.fontSize,
        fontWeight: settings.readingProfile.fontWeight,
        lineHeight: settings.readingProfile.lineHeight,
        letterSpacing: settings.readingProfile.letterSpacing,
        wordSpacing: settings.readingProfile.wordSpacing,
        paragraphSpacing: settings.readingProfile.paragraphSpacing,
        firstLineIndent: settings.readingProfile.firstLineIndent,
        textAlign: settings.readingProfile.textAlign,
        lineBreak: settings.readingProfile.lineBreak,
        fontStyle: settings.readingProfile.fontStyle,
        textDecoration: settings.readingProfile.textDecoration,
        marginX: settings.readingProfile.marginX,
        marginY: settings.readingProfile.marginY,
      }),
    [chapterHeading, contentRevisionId, dimensions.height, pageWidth, settings.readingProfile],
  );

  const pageMapIdentity = useMemo<ReaderPageMapIdentity>(
    () => ({
      chapterId: chapter.id,
      contentRevisionId,
      layoutKey,
      rendererVersion: PAGINATION_RENDERER_VERSION,
    }),
    [chapter.id, contentRevisionId, layoutKey],
  );
  const pageMapKey = `${chapter.id}:${layoutKey}`;

  const session = useMemo(() => {
    const create = () => {
      const controller = new AbortController();
      const window = new ReaderPageWindow(
        async (edge, direction) => {
          if (!measureRef.current || !rootRef.current) throw new Error('Page measurement unavailable');
          return measureAdjacentPage(
            {
              template: measureRef.current,
              host: rootRef.current,
              chapter: chapterHeading,
              paragraphCount: chapter.paragraphCount,
              getParagraph: getParagraphAtIndex,
            },
            edge,
            direction,
            controller.signal,
          );
        },
        getParagraphAtIndex,
        controller.signal,
      );
      let loaded: Promise<void> | undefined;
      return {
        controller,
        window,
        load: () =>
          (loaded ??= (async () => {
            const cached = getCachedPageMap(pageMapKey);
            const stored = cached ?? (await loadReaderPageMap(pageMapIdentity).catch(() => undefined));
            controller.signal.throwIfAborted();
            if (stored) window.seed(stored.boundaries);
          })()),
      };
    };
    let current = create();
    return {
      active: isActive,
      get controller() {
        return current.controller;
      },
      get window() {
        return current.window;
      },
      load: () => current.load(),
      restart: () => {
        if (current.controller.signal.aborted) current = create();
      },
    };
  }, [chapter.paragraphCount, chapterHeading, getParagraphAtIndex, isActive, pageMapIdentity, pageMapKey]);
  useEffect(() => {
    session.restart();
    return () => {
      navigationRef.current += 1;
      session.controller.abort();
      window.clearTimeout(transitionTimerRef.current);
      const boundaries = session.window.snapshot();
      if (boundaries.length) cachePageMap({ key: pageMapKey, boundaries });
    };
  }, [pageMapKey, session]);

  const commitPage = useCallback(
    async (boundary: ReaderPageBoundary, navigation: number, direction?: -1 | 1) => {
      const primaryBoundary = boundary;
      const fragments = await session.window.materialize(primaryBoundary);
      if (navigation !== navigationRef.current || session.controller.signal.aborted) return false;
      const secondaryBoundary = spreadActive ? await session.window.adjacent(primaryBoundary.end, 1) : undefined;
      const secondaryFragments = secondaryBoundary ? await session.window.materialize(secondaryBoundary) : [];
      if (navigation !== navigationRef.current || session.controller.signal.aborted) return false;
      const previous = viewRef.current;
      window.clearTimeout(transitionTimerRef.current);
      const animate =
        direction &&
        previous?.key === pageMapKey &&
        settings.readingProfile.pageTurnMotion !== 'instant' &&
        !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
      setOutgoingFragments(animate ? previous.fragments : []);
      setOutgoingSecondaryFragments(animate ? (previous.secondaryFragments ?? []) : []);
      setTransitionDirection(animate ? direction : undefined);
      if (animate) {
        setTransitionSequence((value) => value + 1);
        transitionTimerRef.current = window.setTimeout(() => {
          setOutgoingFragments([]);
          setOutgoingSecondaryFragments([]);
          setTransitionDirection(undefined);
        }, PAGE_TURN_DURATION_MS);
      }
      const next = { key: pageMapKey, boundary: primaryBoundary, fragments, secondaryBoundary, secondaryFragments };
      viewRef.current = next;
      visibleAnchorRef.current = primaryBoundary.start;
      setView(next);
      setPreparing(false);
      return true;
    },
    [pageMapKey, session, settings.readingProfile.pageTurnMotion, spreadActive],
  );

  const seek = useCallback(
    async (anchor: ReaderAnchor, placement: ReaderAnchorPlacement = 'contain') => {
      if (anchor.sectionId !== chapter.id || anchor.bookId !== novel.id || !isActive) return false;
      const navigation = ++navigationRef.current;
      const openSequence = initialRef.current.openRequest?.sequence;
      pageTurnQueueRef.current = Promise.resolve();
      setPreparing(true);
      try {
        await session.load();
        if (navigation !== navigationRef.current) return false;
        const boundary = await session.window.at(anchor, placement);
        if (!boundary) {
          if (chapter.paragraphCount === 0) setPreparing(false);
          return false;
        }
        const committed = await commitPage(boundary, navigation);
        if (committed) appliedOpenSequenceRef.current = openSequence;
        return committed;
      } catch {
        if (navigation === navigationRef.current && !session.controller.signal.aborted) onPaginationFailure();
        return false;
      }
    },
    [chapter.id, chapter.paragraphCount, commitPage, isActive, novel.id, onPaginationFailure, session],
  );
  const seekRef = useRef(seek);
  seekRef.current = seek;
  const initialRef = useRef({ openRequest, initialAnchor: props.initialAnchor });
  initialRef.current = { openRequest, initialAnchor: props.initialAnchor };

  useEffect(() => {
    if (!isActive || dimensions.width < 100 || dimensions.height < 180 || props.pageTransitionPending) return;
    let cancelled = false;
    const navigation = navigationRef.current;
    const prepare = async () => {
      await session.load();
      if (cancelled || navigation !== navigationRef.current) return;
      const { openRequest: request, initialAnchor } = initialRef.current;
      if (viewRef.current?.key === pageMapKey && (!request || appliedOpenSequenceRef.current === request.sequence))
        return;
      const saved = request?.position;
      const explicitId = request?.targetParagraphId;
      const resolved =
        explicitId || (saved?.paragraphIndex === 0 && saved.paragraphId)
          ? await repository.getParagraph(explicitId ?? saved!.paragraphId!)
          : undefined;
      if (cancelled || navigation !== navigationRef.current) return;
      const target = request?.restore ? resolveRestoreReadingPositionTarget(chapter, saved, resolved) : undefined;
      const newRequest = request && appliedOpenSequenceRef.current !== request.sequence;
      const retained =
        !newRequest && visibleAnchorRef.current?.sectionId === chapter.id ? visibleAnchorRef.current : undefined;
      const anchor = retained ??
        (!newRequest ? initialAnchor : undefined) ?? {
          bookId: novel.id,
          contentRevisionId,
          sectionId: chapter.id,
          blockId: explicitId ?? target?.paragraphId ?? '',
          blockIndex: resolved?.chapterId === chapter.id ? resolved.index - 1 : (target?.paragraphIndex ?? 0),
          offset: explicitId ? 0 : (saved?.offsetInParagraph ?? 0),
        };
      const paragraph = await getParagraphAtIndex(
        clamp(anchor.blockIndex ?? 0, 0, Math.max(0, chapter.paragraphCount - 1)),
      );
      if (cancelled || navigation !== navigationRef.current) return;
      if (!paragraph) {
        if (chapter.paragraphCount === 0) setPreparing(false);
        else onPaginationFailure();
        return;
      }
      const edge = {
        ...anchor,
        blockId: paragraph.id,
        blockIndex: paragraph.index - 1,
        offset: saved?.chapterProgress === 1 && !retained && !initialAnchor ? paragraph.text.length : anchor.offset,
      };
      await seekRef.current(edge);
    };
    void prepare().catch(() => {
      if (!cancelled) onPaginationFailure();
    });
    return () => {
      cancelled = true;
    };
  }, [
    chapter,
    contentRevisionId,
    dimensions.height,
    dimensions.width,
    getParagraphAtIndex,
    isActive,
    novel.id,
    onPaginationFailure,
    openRequest?.sequence,
    pageMapKey,
    props.pageTransitionPending,
    repository,
    session,
  ]);

  const currentBoundary = view?.key === pageMapKey ? view.boundary : undefined;
  const pageFragments = currentBoundary ? view!.fragments : [];
  const secondaryBoundary = currentBoundary ? view?.secondaryBoundary : undefined;
  const secondaryFragments = secondaryBoundary ? (view?.secondaryFragments ?? []) : [];
  const currentParagraph = pageFragments[0]?.paragraph;
  const location = useMemo(
    () =>
      currentBoundary
        ? {
            progress:
              ((secondaryBoundary ?? currentBoundary).end.blockIndex ?? 0) >= chapter.paragraphCount ||
              ((secondaryBoundary ?? currentBoundary).end.blockIndex === chapter.paragraphCount - 1 &&
                (secondaryBoundary ?? currentBoundary).end.offset >=
                  (paragraphCacheRef.current.get(chapter.paragraphCount - 1)?.text.length ?? Infinity))
                ? 1
                : chapter.paragraphCount > 1
                  ? (currentBoundary.start.blockIndex ?? 0) / (chapter.paragraphCount - 1)
                  : 0,
            scrollTop: currentBoundary.index,
            paragraphIndex: currentParagraph?.index ?? (currentBoundary.start.blockIndex ?? 0) + 1,
            paragraph: currentParagraph,
            offsetInParagraph: currentBoundary.start.offset,
            ttsIndex: currentBoundary.start.blockIndex ?? 0,
          }
        : undefined,
    [chapter.paragraphCount, currentBoundary, currentParagraph, secondaryBoundary],
  );
  useEffect(() => {
    if (!isActive || preparing || props.pageTransitionPending || !location) return;
    if (openRequest && appliedOpenSequenceRef.current === openRequest.sequence) {
      screenHandle.acknowledgeOpen(openRequest.sequence);
    }
    onVisualLocation(location);
    schedulePosition(location, location.offsetInParagraph);
  }, [
    isActive,
    location,
    onVisualLocation,
    openRequest,
    preparing,
    props.pageTransitionPending,
    schedulePosition,
    screenHandle,
  ]);

  useEffect(() => {
    if (!isActive || preparing || !currentBoundary) return;
    let cancelled = false;
    const warm = async () => {
      for (const direction of [-1, 1] as const) {
        let edge = direction > 0 ? (secondaryBoundary ?? currentBoundary).end : currentBoundary.start;
        for (let distance = 0; distance < 2 && !cancelled; distance += 1) {
          const page = await session.window.adjacent(edge, direction);
          if (!page || cancelled) break;
          await session.window.materialize(page);
          edge = direction > 0 ? page.end : page.start;
        }
      }
      for (const { chapterId, pageIndex } of adjacentChapterPrefetchPages(
        chapters,
        chapter.index,
        PARAGRAPHS_PER_PAGE,
      )) {
        if (cancelled) return;
        await loadSharedParagraphPage(repository, contentRevisionId, chapterId, pageIndex);
      }
      if (cancelled) return;
      const boundaries = session.window.snapshot();
      cachePageMap({ key: pageMapKey, boundaries });
      await saveReaderPageMap(pageMapIdentity, boundaries).then(() => pruneReaderPageMaps(PAGE_MAP_CACHE_LIMIT));
    };
    const cancel = scheduleIdleWork(() => void warm().catch(() => undefined), 1500);
    return () => {
      cancelled = true;
      cancel();
    };
  }, [
    chapter.index,
    chapters,
    contentRevisionId,
    currentBoundary,
    secondaryBoundary,
    isActive,
    pageMapIdentity,
    pageMapKey,
    preparing,
    repository,
    session,
  ]);

  const goChapter = useCallback(
    async (direction: -1 | 1) => {
      const next = chapters.find((candidate) => candidate.index === chapter.index + direction);
      if (!next) return;
      await screenHandle.getActions().openChapter(
        next,
        direction < 0
          ? {
              restore: true,
              position: {
                id: `chapter_edge_${next.id}`,
                novelId: novel.id,
                chapterId: next.id,
                paragraphIndex: Math.max(next.paragraphCount, 1),
                offsetInParagraph: 0,
                chapterProgress: 1,
                scrollTop: Number.MAX_SAFE_INTEGER,
                deviceId: 'reader',
                updatedAt: new Date().toISOString(),
              },
            }
          : undefined,
      );
    },
    [chapter.index, chapters, novel.id, screenHandle],
  );
  const pageJump = useCallback(
    (direction: -1 | 1) => {
      const navigation = navigationRef.current;
      pageTurnQueueRef.current = pageTurnQueueRef.current
        .then(async () => {
          const current = viewRef.current;
          if (
            !current ||
            current.key !== pageMapKey ||
            navigation !== navigationRef.current ||
            session.controller.signal.aborted
          )
            return;
          const edge = direction > 0 ? (current.secondaryBoundary ?? current.boundary).end : current.boundary.start;
          let boundary = await session.window.adjacent(edge, direction);
          if (direction < 0 && spreadActive && boundary) {
            boundary = (await session.window.adjacent(boundary.start, -1)) ?? boundary;
          }
          if (navigation !== navigationRef.current || session.controller.signal.aborted) return;
          if (boundary) await commitPage(boundary, navigation, direction);
          else await goChapter(direction);
        })
        .catch(() => {
          if (navigation === navigationRef.current && !session.controller.signal.aborted) onPaginationFailure();
        });
      onRevealChrome();
    },
    [commitPage, goChapter, onPaginationFailure, onRevealChrome, pageMapKey, session, spreadActive],
  );
  const requestScrollAfterPageTurn = useCallback(
    (deltaY: number) => {
      const navigation = navigationRef.current;
      void pageTurnQueueRef.current.then(() => {
        if (navigation === navigationRef.current && !session.controller.signal.aborted)
          window.requestAnimationFrame(() => onScrollIntent(deltaY));
      });
    },
    [onScrollIntent, session],
  );
  const gestureHandlers = useReaderGestureHandlers({
    bindings: { ...settings.gestureBindings, tapCenter: 'toggle_chrome' },
    viewportWidth: () => rootRef.current?.clientWidth ?? window.innerWidth,
    actions: {
      previousPage: () => pageJump(-1),
      nextPage: () => pageJump(1),
      toggleChrome: onToggleImmersive,
      openToc: () => screenHandle.getActions().openAddon('outline'),
      openSettings: () => screenHandle.getActions().openSettings(),
      toggleTTS: () => screenHandle.getActions().toggleTTS(location?.ttsIndex ?? 0),
    },
    onVerticalScrollIntent: requestScrollAfterPageTurn,
  });
  const seekParagraph = useCallback(
    async (index: number) => {
      const navigation = ++navigationRef.current;
      const paragraph = await getParagraphAtIndex(index);
      if (navigation !== navigationRef.current || session.controller.signal.aborted) return false;
      return paragraph
        ? seek({
            bookId: novel.id,
            contentRevisionId,
            sectionId: chapter.id,
            blockId: paragraph.id,
            blockIndex: index,
            offset: 0,
          })
        : false;
    },
    [chapter.id, contentRevisionId, getParagraphAtIndex, novel.id, seek, session],
  );
  useEffect(() => {
    resetAutoReading();
    return resetAutoReading;
  }, [isActive, pageMapKey, resetAutoReading]);
  const api = useMemo<ReaderViewportApi>(
    () => ({
      flow: 'paginated',
      resetAutoReading,
      advanceAutoReading: (autoMode, amount) => {
        const root = rootRef.current;
        const overlay = autoOverlayRef.current;
        const current = viewRef.current;
        if (
          (!autoMode.startsWith('blind-') && autoMode !== 'page-turn') ||
          !isActive ||
          preparing ||
          !root ||
          !overlay ||
          !current ||
          current.key !== pageMapKey ||
          autoTurning.current
        )
          return 'waiting';
        if (root.querySelector('.is-current .reader-image-placeholder:not(.is-loading)')) return 'failed';
        if (root.querySelector('.is-current .reader-image-placeholder.is-loading')) return 'waiting';
        const images = [...root.querySelectorAll<HTMLImageElement>('.is-current img')];
        if (images.some((image) => image.complete && image.naturalWidth === 0)) return 'failed';
        if (images.some((image) => !image.complete)) return 'waiting';
        const edge = (current.secondaryBoundary ?? current.boundary).end;
        const key = JSON.stringify(edge);
        if (autoNeighbor.current?.key !== key) {
          const next = { key, loading: true } as NonNullable<typeof autoNeighbor.current>;
          autoNeighbor.current = next;
          void session.window
            .adjacent(edge, 1)
            .then((boundary) => {
              next.boundary = boundary;
            })
            .catch(() => {
              next.failed = true;
            })
            .finally(() => {
              next.loading = false;
            });
        }
        const next = autoNeighbor.current;
        if (next.loading) return 'waiting';
        if (next.failed) {
          onPaginationFailure();
          return 'failed';
        }
        if (autoMode === 'page-turn') {
          if (!next.boundary) return 'end';
          if (amount > 0) {
            const generation = autoGeneration.current;
            const navigation = navigationRef.current;
            autoTurning.current = true;
            void commitPage(next.boundary, navigation, 1)
              .catch(() => {
                if (generation === autoGeneration.current) {
                  next.failed = true;
                  onPaginationFailure();
                }
              })
              .finally(() => {
                if (generation === autoGeneration.current) autoTurning.current = false;
              });
          }
          return 'moving';
        }
        const bounds = root.getBoundingClientRect();
        const style = getComputedStyle(root);
        return autoPresentation.current.advance(autoMode, amount, {
          root,
          overlay,
          top: bounds.top + (parseFloat(style.paddingTop) || 0),
          bottom: bounds.bottom - (parseFloat(style.paddingBottom) || 0),
          count: chapter.paragraphCount,
          anchor: () => current.boundary.start,
          paragraph: (index) => paragraphCacheRef.current.get(index),
          load: async () => undefined,
          range: () => undefined,
          advance: (pixels) => {
            if (!next.boundary) return 'end';
            if (pixels > 0) {
              const generation = autoGeneration.current;
              const navigation = navigationRef.current;
              autoTurning.current = true;
              void commitPage(next.boundary, navigation, 1)
                .catch(() => {
                  if (generation === autoGeneration.current) onPaginationFailure();
                })
                .finally(() => {
                  if (generation === autoGeneration.current) autoTurning.current = false;
                });
            }
            return 'moving';
          },
        });
      },
      resetContent: () => {
        void seekParagraph(0);
      },
      flushPosition,
      scrollToParagraph: async (id) => {
        const navigation = ++navigationRef.current;
        const p = await repository.getParagraph(id);
        if (navigation !== navigationRef.current || session.controller.signal.aborted) return false;
        return p?.chapterId === chapter.id ? seekParagraph(p.index - 1) : false;
      },
      scrollToParagraphIndex: async (index) => {
        await seekParagraph(index);
      },
      scrubTo: async (progress) => {
        const navigation = ++navigationRef.current;
        const position = clamp(progress, 0, 1) * chapter.paragraphCount;
        const index = Math.min(Math.floor(position), Math.max(0, chapter.paragraphCount - 1));
        const paragraph = await getParagraphAtIndex(index);
        if (!paragraph || navigation !== navigationRef.current || session.controller.signal.aborted) return;
        const atEnd = progress >= 1;
        await seek(
          {
            bookId: novel.id,
            contentRevisionId,
            sectionId: chapter.id,
            blockId: paragraph.id,
            blockIndex: atEnd ? chapter.paragraphCount : index,
            offset: atEnd ? 0 : Math.floor((position - index) * paragraph.text.length),
          },
          atEnd ? 'previous-page' : 'contain',
        );
      },
      pageJump,
      goChapter,
      scrollPageJump: pageJump,
      scrollByPixels: onScrollIntent,
      getAnchor: () => (viewRef.current?.key === pageMapKey ? viewRef.current.boundary.start : undefined),
      getPageTurnAnchor: async () => (viewRef.current?.key === pageMapKey ? viewRef.current.boundary.start : undefined),
      scrollToAnchor: (anchor, _offset, placement) => seek(anchor, placement),
      getParagraphAtIndex,
      getCachedParagraphById: (id) => [...paragraphCacheRef.current.values()].find((p) => p.id === id),
      getLocation: () => location,
      getSelection: () => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
        const id =
          selection.anchorNode?.parentElement?.closest<HTMLElement>('[data-paragraph-id]')?.dataset.paragraphId;
        return id ? { text: selection.toString(), paragraphId: id } : undefined;
      },
    }),
    [
      chapter.id,
      chapter.paragraphCount,
      contentRevisionId,
      isActive,
      preparing,
      commitPage,
      onPaginationFailure,
      resetAutoReading,
      flushPosition,
      getParagraphAtIndex,
      goChapter,
      location,
      novel.id,
      onScrollIntent,
      pageJump,
      pageMapKey,
      repository,
      seek,
      seekParagraph,
      session,
    ],
  );
  useEffect(() => {
    if (dimensions.width < 100 || dimensions.height < 180) return;
    apiRef.current = api;
    onApiReady(api);
    return () => {
      if (apiRef.current === api) apiRef.current = undefined;
      onApiReady(undefined);
    };
  }, [api, apiRef, dimensions.height, dimensions.width, onApiReady]);
  const paginationStyle = useMemo(
    () =>
      dimensions.height > 0
        ? ({
            '--reader-pagination-page-height': `${dimensions.height}px`,
            '--reader-pagination-leaf-width': `${Math.max(120, pageWidth)}px`,
            '--reader-pagination-page-gap': `${pageGap}px`,
          } as CSSProperties)
        : undefined,
    [dimensions.height, pageGap, pageWidth],
  );
  const outgoingShowsChapterHeading =
    outgoingFragments[0]?.paragraphIndex === 0 && outgoingFragments[0]?.startOffset === 0;
  const currentShowsChapterHeading =
    (currentBoundary?.start.blockIndex ?? -1) === 0 && currentBoundary?.start.offset === 0;
  const secondaryShowsChapterHeading =
    (secondaryBoundary?.start.blockIndex ?? -1) === 0 && secondaryBoundary?.start.offset === 0;

  return (
    <section
      className={`reader-scroll reader-viewport-layer ${isActive ? 'is-active' : 'is-inactive'} font-${settings.font} mode-${mode} reader-paginated-root${spreadActive ? ' is-spread' : ''}`}
      ref={rootRef}
      style={paginationStyle}
      tabIndex={isActive ? 0 : -1}
      aria-hidden={!isActive}
      aria-busy={preparing}
      data-pagination-ready={view?.key === pageMapKey && !preparing ? 'true' : 'false'}
      data-reader-layer="paginated"
      onPointerDown={gestureHandlers.onPointerDown}
      onPointerUp={gestureHandlers.onPointerUp}
      onWheel={(event) => {
        if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
        if (settings.readingProfile.modeLock !== 'paginated') {
          requestScrollAfterPageTurn(event.deltaY);
          return;
        }
        wheelDeltaRef.current += event.deltaY;
        if (Math.abs(wheelDeltaRef.current) < 40) return;
        pageJump(wheelDeltaRef.current > 0 ? 1 : -1);
        wheelDeltaRef.current = 0;
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div ref={autoOverlayRef} className="reader-auto-reading-overlay" hidden aria-hidden="true" />
      <div
        ref={measureRef}
        className="reader-document reader-pagination-measure"
        style={{ width: Math.max(120, pageWidth), height: Math.max(160, dimensions.height) }}
        aria-hidden="true"
      />
      <div
        ref={stageRef}
        className={`reader-pagination-stage motion-${settings.readingProfile.pageTurnMotion}${transitionDirection ? ` turn-${transitionDirection > 0 ? 'next' : 'previous'}` : ''}`}
      >
        {outgoingFragments.length > 0 && (
          <article
            key={`outgoing-${transitionSequence}`}
            className={`reader-document reader-paginated-page is-outgoing${outgoingShowsChapterHeading ? ' has-chapter-heading' : ''}`}
          >
            {outgoingShowsChapterHeading && <ReaderChapterHeading chapter={chapterHeading} />}
            {outgoingFragments.map((fragment, index) => (
              <ReaderParagraphRow
                key={`${fragment.paragraph.id}:${fragment.startOffset}:${index}`}
                paragraph={sliceParagraphForPage(fragment.paragraph, fragment.startOffset, fragment.endOffset)}
                sourceOffset={fragment.startOffset}
                virtualIndex={fragment.paragraphIndex}
                start={0}
                staticLayout
                isSpeaking={ttsIndex === fragment.paragraphIndex}
                mode={mode}
                searchQuery={search.highlightQuery}
                decorationStore={screenHandle.decorations}
                measureElement={() => undefined}
                onSelectCorrectionSegment={(segmentId) => screenHandle.getActions().selectCorrectionSegment(segmentId)}
                assetRepository={assetRepository}
                onDocumentLink={onDocumentLink}
              />
            ))}
          </article>
        )}
        {outgoingSecondaryFragments.length > 0 && (
          <article
            key={`outgoing-secondary-${transitionSequence}`}
            className="reader-document reader-paginated-page is-outgoing is-secondary"
          >
            {outgoingSecondaryFragments.map((fragment, index) => (
              <ReaderParagraphRow
                key={`${fragment.paragraph.id}:${fragment.startOffset}:${index}`}
                paragraph={sliceParagraphForPage(fragment.paragraph, fragment.startOffset, fragment.endOffset)}
                sourceOffset={fragment.startOffset}
                virtualIndex={fragment.paragraphIndex}
                start={0}
                staticLayout
                isSpeaking={ttsIndex === fragment.paragraphIndex}
                mode={mode}
                searchQuery={search.highlightQuery}
                decorationStore={screenHandle.decorations}
                measureElement={() => undefined}
                onSelectCorrectionSegment={(segmentId) => screenHandle.getActions().selectCorrectionSegment(segmentId)}
                assetRepository={assetRepository}
                onDocumentLink={onDocumentLink}
              />
            ))}
          </article>
        )}
        <article
          key={`current-${transitionSequence}`}
          ref={pageRef}
          className={`reader-document reader-paginated-page is-current${currentShowsChapterHeading ? ' has-chapter-heading' : ''}`}
          data-page-start-index={currentBoundary?.start.blockIndex}
          data-page-start-offset={currentBoundary?.start.offset}
          data-page-start-id={currentBoundary?.start.blockId}
          data-page-end-index={currentBoundary?.end.blockIndex}
          data-page-end-offset={currentBoundary?.end.offset}
          onMouseUp={() => onSelectionChanged(api.getSelection())}
        >
          {currentShowsChapterHeading && <ReaderChapterHeading chapter={chapterHeading} />}
          {pageFragments.map((fragment, index) => (
            <ReaderParagraphRow
              key={`${fragment.paragraph.id}:${fragment.startOffset}:${index}`}
              paragraph={sliceParagraphForPage(fragment.paragraph, fragment.startOffset, fragment.endOffset)}
              sourceOffset={fragment.startOffset}
              virtualIndex={fragment.paragraphIndex}
              start={0}
              staticLayout
              isSpeaking={ttsIndex === fragment.paragraphIndex}
              mode={mode}
              searchQuery={search.highlightQuery}
              decorationStore={screenHandle.decorations}
              measureElement={() => undefined}
              onSelectCorrectionSegment={(segmentId) => screenHandle.getActions().selectCorrectionSegment(segmentId)}
              assetRepository={assetRepository}
              onDocumentLink={onDocumentLink}
            />
          ))}
          {!view && <div className="reader-pagination-status">첫 페이지 계산 중</div>}
        </article>
        {secondaryBoundary && (
          <article
            key={`secondary-${transitionSequence}`}
            className={`reader-document reader-paginated-page is-current is-secondary${secondaryShowsChapterHeading ? ' has-chapter-heading' : ''}`}
            data-page-start-index={secondaryBoundary.start.blockIndex}
            data-page-start-offset={secondaryBoundary.start.offset}
            data-page-end-index={secondaryBoundary.end.blockIndex}
            data-page-end-offset={secondaryBoundary.end.offset}
            onMouseUp={() => onSelectionChanged(api.getSelection())}
          >
            {secondaryShowsChapterHeading && <ReaderChapterHeading chapter={chapterHeading} />}
            {secondaryFragments.map((fragment, index) => (
              <ReaderParagraphRow
                key={`${fragment.paragraph.id}:${fragment.startOffset}:${index}`}
                paragraph={sliceParagraphForPage(fragment.paragraph, fragment.startOffset, fragment.endOffset)}
                sourceOffset={fragment.startOffset}
                virtualIndex={fragment.paragraphIndex}
                start={0}
                staticLayout
                isSpeaking={ttsIndex === fragment.paragraphIndex}
                mode={mode}
                searchQuery={search.highlightQuery}
                decorationStore={screenHandle.decorations}
                measureElement={() => undefined}
                onSelectCorrectionSegment={(segmentId) => screenHandle.getActions().selectCorrectionSegment(segmentId)}
                assetRepository={assetRepository}
                onDocumentLink={onDocumentLink}
              />
            ))}
          </article>
        )}
      </div>
    </section>
  );
}
