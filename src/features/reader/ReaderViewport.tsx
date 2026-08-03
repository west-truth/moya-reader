import { useVirtualizer } from '@tanstack/react-virtual';
import { SkipBack, SkipForward } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type WheelEvent,
} from 'react';
import type { Chapter, Novel, Paragraph, ReaderSettings } from '../../domain/types';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { resolveRestoreReadingPositionTarget } from '../../reader/reading-position';
import { clamp } from '../../utils/format';
import { ReaderParagraphRow } from './ReaderParagraphRow';
import type {
  ReaderLocationSnapshot,
  ReaderMode,
  ReaderOpenRequest,
  ReaderScreenHandle,
  ReaderSelection,
} from './reader-screen-contract';
import type { ReaderSearchController } from './use-reader-search';
import { useParagraphPages } from './use-paragraph-pages';
import { useReaderProgress } from './use-reader-progress';
import { PaginatedReaderViewport } from './PaginatedReaderViewport';
import { useReaderGestureHandlers } from './use-reader-gestures';

export interface ReaderViewportApi {
  readonly resetContent: () => void;
  readonly flushPosition: () => Promise<void>;
  readonly scrollToParagraph: (paragraphId: string) => Promise<boolean>;
  readonly scrollToParagraphIndex: (
    paragraphIndex: number,
    align?: 'start' | 'center' | 'end',
    behavior?: ScrollBehavior,
  ) => Promise<void>;
  readonly scrubTo: (progress: number) => Promise<void>;
  readonly pageJump: (direction: -1 | 1) => void;
  readonly getParagraphAtIndex: (paragraphIndex: number) => Promise<Paragraph | undefined>;
  readonly getCachedParagraphById: (paragraphId: string) => Paragraph | undefined;
  readonly getLocation: () => ReaderLocationSnapshot | undefined;
  readonly getSelection: () => ReaderSelection | undefined;
}

export interface ReaderViewportProps {
  readonly repository: ReaderRepository;
  readonly novel: Pick<Novel, 'id' | 'title' | 'totalChapters' | 'activeContentRevisionId' | 'format'>;
  readonly chapter: Chapter;
  readonly chapters: readonly Chapter[];
  readonly settings: ReaderSettings;
  readonly mode: ReaderMode;
  readonly ttsIndex?: number;
  readonly search: ReaderSearchController;
  readonly screenHandle: ReaderScreenHandle;
  readonly openRequest?: ReaderOpenRequest;
  readonly apiRef: MutableRefObject<ReaderViewportApi | undefined>;
  readonly onApiReady: (api?: ReaderViewportApi) => void;
  readonly onVisualLocation: (location: ReaderLocationSnapshot) => void;
  readonly onSelectionChanged: (selection?: ReaderSelection) => void;
  readonly onRevealChrome: () => void;
  readonly onToggleChrome: () => void;
  readonly onDocumentLink: (href: string, footnote: boolean) => void;
  readonly assetRepository?: BookAssetRepository;
}

function VirtualizedReaderViewportComponent({
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
  onToggleChrome,
  onDocumentLink,
  assetRepository,
}: ReaderViewportProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLElement>(null);
  const pageWheelTimerRef = useRef<number>();
  const appliedOpenSequenceRef = useRef<number>();
  const visibleAnchorIndexRef = useRef<number>();
  const pages = useParagraphPages(repository, chapter.id, chapter.paragraphCount);
  const virtualizer = useVirtualizer({
    count: chapter.paragraphCount,
    getScrollElement: () => rootRef.current,
    estimateSize: () => Math.max(settings.fontSize * settings.lineHeight * 2.4, 72),
    overscan: settings.flow === 'page' ? 4 : 6,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const virtualRangeKey = virtualItems.map((item) => item.index).join(':');
  const loadParagraphIndexes = pages.loadIndexes;

  const firstVisible = useCallback((): { index?: number; paragraph?: Paragraph } => {
    const root = rootRef.current;
    const viewportTop = root?.scrollTop ?? 0;
    const viewportBottom = root ? viewportTop + root.clientHeight : Number.POSITIVE_INFINITY;
    let firstAfterViewport: number | undefined;
    for (const item of virtualizer.getVirtualItems()) {
      const itemEnd = item.start + item.size;
      if (root && itemEnd <= viewportTop) continue;
      if (root && item.start >= viewportBottom) {
        firstAfterViewport ??= item.index;
        continue;
      }
      return { index: item.index, paragraph: pages.paragraphAt(item.index) };
    }
    return {
      index: firstAfterViewport,
      paragraph: firstAfterViewport === undefined ? undefined : pages.paragraphAt(firstAfterViewport),
    };
  }, [pages, virtualizer]);

  const progress = useReaderProgress({
    rootRef,
    repository,
    novel,
    chapter,
    getVisibleParagraph: firstVisible,
    onVisualLocation,
    onLocationCommitted: (nextLocation, nextBookProgress, updatedAt) =>
      screenHandle.getActions().locationCommitted(nextLocation, nextBookProgress, updatedAt),
    onPersistenceFailed: (error) => screenHandle.getActions().locationPersistenceFailed(error),
  });

  const scrollToParagraphIndex = useCallback(
    async (index: number, align: 'start' | 'center' | 'end' = 'center', behavior: ScrollBehavior = 'smooth') => {
      if (chapter.paragraphCount <= 0) return;
      const targetIndex = clamp(index, 0, chapter.paragraphCount - 1);
      await pages.loadIndexes([targetIndex]);
      virtualizer.scrollToIndex(targetIndex, { align, behavior });
      onRevealChrome();
    },
    [chapter.paragraphCount, onRevealChrome, pages, virtualizer],
  );

  const scrollToParagraph = useCallback(
    async (paragraphId: string): Promise<boolean> => {
      const paragraph = pages.paragraphById(paragraphId) ?? (await repository.getParagraph(paragraphId));
      if (!paragraph || paragraph.chapterId !== chapter.id) return false;
      await scrollToParagraphIndex(paragraph.index - 1);
      return true;
    },
    [chapter.id, pages, repository, scrollToParagraphIndex],
  );

  const scrubTo = useCallback(
    async (value: number) => {
      const nextProgress = clamp(value, 0, 1);
      if (chapter.paragraphCount > 0) {
        const targetIndex = clamp(
          Math.round(nextProgress * (chapter.paragraphCount - 1)),
          0,
          chapter.paragraphCount - 1,
        );
        const align = nextProgress <= 0.01 ? 'start' : nextProgress >= 0.99 ? 'end' : 'center';
        await scrollToParagraphIndex(targetIndex, align, 'auto');
        return;
      }
      const root = rootRef.current;
      if (!root) return;
      root.scrollTop = Math.max(root.scrollHeight - root.clientHeight, 1) * nextProgress;
    },
    [chapter.paragraphCount, scrollToParagraphIndex],
  );

  const goChapter = useCallback(
    async (direction: -1 | 1, openAtEnd = false) => {
      const next = chapters.find((candidate) => candidate.index === chapter.index + direction);
      if (!next) return;
      if (!openAtEnd) {
        await screenHandle.getActions().openChapter(next);
        return;
      }
      await screenHandle.getActions().openChapter(next, {
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
      });
    },
    [chapter.index, chapters, novel.id, screenHandle],
  );

  const pageJump = useCallback(
    (direction: -1 | 1) => {
      const root = rootRef.current;
      if (!root) return;
      const pageSize = Math.max(settings.flow === 'page' ? root.clientHeight : root.clientHeight - 120, 80);
      const edgeMargin = 24;
      const atStart = root.scrollTop <= edgeMargin;
      const atEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - edgeMargin;
      if (direction > 0 && atEnd) {
        void goChapter(1);
        return;
      }
      if (direction < 0 && atStart) {
        void goChapter(-1, true);
        return;
      }
      if (settings.flow !== 'page') {
        root.scrollBy({ top: direction * pageSize, behavior: 'smooth' });
        return;
      }

      const viewportTop = root.scrollTop;
      const viewportBottom = viewportTop + root.clientHeight;
      const items = virtualizer.getVirtualItems();
      const candidates = direction > 0 ? items : [...items].reverse();
      const target = candidates.find((item) =>
        direction > 0
          ? item.start > viewportTop + edgeMargin && item.start >= viewportBottom - edgeMargin
          : item.start + item.size <= viewportTop + edgeMargin,
      );
      if (target) virtualizer.scrollToIndex(target.index, { align: 'start', behavior: 'smooth' });
      else root.scrollBy({ top: direction * pageSize, behavior: 'smooth' });
    },
    [goChapter, settings.flow, virtualizer],
  );

  const getSelection = useCallback((): ReaderSelection | undefined => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    const root = rootRef.current;
    if (!text || !root) return undefined;
    const anchor =
      selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
    const focus = selection?.focusNode instanceof Element ? selection.focusNode : selection?.focusNode?.parentElement;
    const paragraph =
      anchor?.closest<HTMLElement>('[data-paragraph-id]') ?? focus?.closest<HTMLElement>('[data-paragraph-id]');
    const paragraphId = paragraph?.dataset.paragraphId;
    return paragraph && paragraphId && root.contains(paragraph) ? { text, paragraphId } : undefined;
  }, []);

  const updateSelection = useCallback(() => {
    window.setTimeout(() => onSelectionChanged(getSelection()), 0);
  }, [getSelection, onSelectionChanged]);

  apiRef.current = {
    resetContent: pages.reset,
    flushPosition: progress.flush,
    scrollToParagraph,
    scrollToParagraphIndex,
    scrubTo,
    pageJump,
    getParagraphAtIndex: pages.getParagraphAt,
    getCachedParagraphById: pages.paragraphById,
    getLocation: progress.readLocation,
    getSelection,
  };

  useLayoutEffect(() => {
    onApiReady(apiRef.current);
    return () => onApiReady(undefined);
  }, [apiRef, chapter.id, onApiReady]);

  useLayoutEffect(() => {
    const documentElement = documentRef.current;
    if (!documentElement || typeof ResizeObserver === 'undefined') return;
    let lastWidth = documentElement.getBoundingClientRect().width;
    let restoreFrame: number | undefined;
    const observer = new ResizeObserver(() => {
      const nextWidth = documentElement.getBoundingClientRect().width;
      if (Math.abs(nextWidth - lastWidth) < 1) return;
      lastWidth = nextWidth;
      const anchorIndex = visibleAnchorIndexRef.current ?? firstVisible().index;
      if (anchorIndex === undefined) return;
      window.cancelAnimationFrame(restoreFrame ?? 0);
      restoreFrame = window.requestAnimationFrame(() => {
        virtualizer.measure();
        virtualizer.scrollToIndex(anchorIndex, { align: 'start', behavior: 'auto' });
      });
    });
    observer.observe(documentElement);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(restoreFrame ?? 0);
    };
  }, [chapter.id, firstVisible, virtualizer]);

  useEffect(() => {
    const activeItems = virtualizer.getVirtualItems();
    if (activeItems.length === 0) return;
    const indexes = activeItems.map((item) => item.index);
    const generation = pages.generation;
    void pages.loadIndexes(indexes).then(() => {
      if (pages.generation === generation) pages.prune(indexes);
    });
  }, [pages, virtualRangeKey, virtualizer]);

  useEffect(() => {
    if (!openRequest || openRequest.chapterId !== chapter.id) {
      void loadParagraphIndexes([0]);
      return;
    }
    if (appliedOpenSequenceRef.current === openRequest.sequence) return;
    let cancelled = false;
    const acknowledgeOpen = () => {
      appliedOpenSequenceRef.current = openRequest.sequence;
      screenHandle.acknowledgeOpen(openRequest.sequence);
    };
    const restore = async () => {
      const explicitParagraph = openRequest.targetParagraphId
        ? await repository.getParagraph(openRequest.targetParagraphId)
        : undefined;
      if (explicitParagraph?.chapterId === chapter.id) {
        const targetIndex = clamp(explicitParagraph.index - 1, 0, Math.max(chapter.paragraphCount - 1, 0));
        await loadParagraphIndexes([targetIndex]);
        if (!cancelled) {
          virtualizer.scrollToIndex(targetIndex, { align: 'center', behavior: 'auto' });
          acknowledgeOpen();
        }
        return;
      }
      const resolvedParagraph =
        openRequest.restore && openRequest.position?.paragraphIndex === 0 && openRequest.position.paragraphId
          ? await repository.getParagraph(openRequest.position.paragraphId)
          : undefined;
      const target = openRequest.restore
        ? resolveRestoreReadingPositionTarget(chapter, openRequest.position, resolvedParagraph)
        : { canRestore: false, scrollTop: 0 };
      if (target.paragraphIndex !== undefined) {
        await loadParagraphIndexes([target.paragraphIndex]);
        if (!cancelled) virtualizer.scrollToIndex(target.paragraphIndex, { align: 'start', behavior: 'auto' });
      } else {
        await loadParagraphIndexes([0]);
        if (!cancelled && rootRef.current) {
          rootRef.current.scrollTop = target.canRestore ? target.scrollTop : openRequest.fallbackScrollTop;
        }
      }
      if (!cancelled) acknowledgeOpen();
    };
    const timer = window.setTimeout(() => void restore(), 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chapter, loadParagraphIndexes, openRequest, repository, screenHandle, virtualizer]);

  const failedRows = new Set<number>();
  const failedPages = new Set<number>();
  for (const item of virtualItems) {
    const pageIndex = Math.floor(item.index / PARAGRAPHS_PER_PAGE);
    if (pages.isPageFailed(pageIndex) && !failedPages.has(pageIndex)) {
      failedPages.add(pageIndex);
      failedRows.add(item.index);
    }
  }

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (settings.flow !== 'page' || Math.abs(event.deltaY) < 16) return;
    event.preventDefault();
    if (pageWheelTimerRef.current) return;
    pageJump(event.deltaY > 0 ? 1 : -1);
    pageWheelTimerRef.current = window.setTimeout(() => {
      pageWheelTimerRef.current = undefined;
    }, 380);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (settings.flow !== 'page') return;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) {
      event.preventDefault();
      pageJump(1);
    } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      pageJump(-1);
    }
  };

  const actionHandlers = {
    previousPage: () => pageJump(-1),
    nextPage: () => pageJump(1),
    toggleChrome: onToggleChrome,
    openToc: () => screenHandle.getActions().openAddon('outline'),
    openSettings: () => screenHandle.getActions().openSettings(),
    toggleTTS: () => screenHandle.getActions().toggleTTS(progress.readLocation()?.ttsIndex ?? 0),
  };
  const gestureHandlers = useReaderGestureHandlers({
    bindings: settings.gestureBindings,
    viewportWidth: () => rootRef.current?.clientWidth ?? window.innerWidth,
    actions: actionHandlers,
  });

  return (
    <section
      ref={rootRef}
      className={`reader-scroll font-${settings.font} mode-${mode}${settings.flow === 'page' ? ' page-flow' : ''}`}
      tabIndex={0}
      onScroll={() => {
        onRevealChrome();
        visibleAnchorIndexRef.current = firstVisible().index;
        progress.handleScroll();
      }}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onKeyUp={updateSelection}
      onMouseUp={updateSelection}
      onPointerDown={gestureHandlers.onPointerDown}
      onPointerUp={gestureHandlers.onPointerUp}
      onClick={(event) => event.stopPropagation()}
    >
      <article ref={documentRef} className="reader-document">
        <p className="chapter-kicker">{novel.title}</p>
        <h1>{chapter.title}</h1>
        <div className="reader-virtual-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualItems.map((item) => {
            const paragraph = pages.paragraphAt(item.index);
            if (!paragraph) {
              const pageIndex = Math.floor(item.index / PARAGRAPHS_PER_PAGE);
              const failed = failedRows.has(item.index);
              return (
                <div
                  key={`${failed ? 'failed' : 'loading'}-${item.index}`}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="reader-virtual-row"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {failed ? (
                    <div className="reader-paragraph is-error" role="alert">
                      <p>본문을 불러오지 못했습니다.</p>
                      <button type="button" className="ghost-btn" onClick={() => void pages.retryPage(pageIndex)}>
                        다시 시도
                      </button>
                    </div>
                  ) : (
                    <div className="reader-paragraph is-loading" aria-hidden="true">
                      <p />
                    </div>
                  )}
                </div>
              );
            }
            return (
              <ReaderParagraphRow
                key={paragraph.id}
                paragraph={paragraph}
                virtualIndex={item.index}
                start={item.start}
                isSpeaking={ttsIndex === item.index}
                mode={mode}
                searchQuery={search.highlightQuery}
                decorationStore={screenHandle.decorations}
                measureElement={virtualizer.measureElement}
                onSelectCorrectionSegment={(segmentId) => screenHandle.getActions().selectCorrectionSegment(segmentId)}
                assetRepository={assetRepository}
                onDocumentLink={onDocumentLink}
              />
            );
          })}
        </div>
        <nav className="chapter-nav">
          <button className="ghost-btn" disabled={chapter.index <= 1} onClick={() => void goChapter(-1)}>
            <SkipBack size={18} /> 이전 화
          </button>
          <button className="ghost-btn" disabled={chapter.index >= chapters.length} onClick={() => void goChapter(1)}>
            다음 화 <SkipForward size={18} />
          </button>
        </nav>
      </article>
    </section>
  );
}

function ReaderViewportComponent(props: ReaderViewportProps) {
  const [paginationFailed, setPaginationFailed] = useState(false);
  const paginationProfileKey = JSON.stringify(props.settings.readingProfile);
  useEffect(() => setPaginationFailed(false), [props.chapter.id, paginationProfileKey]);
  return props.settings.readingProfile.flow === 'paginated' && !paginationFailed ? (
    <PaginatedReaderViewport {...props} onPaginationFailure={() => setPaginationFailed(true)} />
  ) : (
    <VirtualizedReaderViewportComponent {...props} />
  );
}

export const ReaderViewport = memo(ReaderViewportComponent);
