import { useVirtualizer } from '@tanstack/react-virtual';
import { sentenceRanges } from '@noveldesk/text-core/sentence-boundaries';
import { SkipBack, SkipForward } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Chapter, Novel, Paragraph, ReaderAnchor, ReaderSettings } from '../../domain/types';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { resolveRestoreReadingPositionTarget } from '../../reader/reading-position';
import { clamp } from '../../utils/format';
import { ReaderParagraphRow } from './ReaderParagraphRow';
import { ReaderChapterHeading } from './ReaderChapterHeading';
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
import { useScrollChapterBoundary } from './use-scroll-chapter-boundary';

export interface ReaderViewportApi {
  readonly flow: ReaderRuntimeFlow;
  readonly resetContent: () => void;
  readonly flushPosition: () => Promise<void>;
  readonly flushPositionImmediately: () => Promise<void>;
  readonly scrollToParagraph: (paragraphId: string) => Promise<boolean>;
  readonly scrollToParagraphIndex: (
    paragraphIndex: number,
    align?: 'start' | 'center' | 'end',
    behavior?: ScrollBehavior,
  ) => Promise<void>;
  readonly scrubTo: (progress: number) => Promise<void>;
  readonly pageJump: (direction: -1 | 1) => void;
  readonly goChapter: (direction: -1 | 1) => Promise<void>;
  readonly scrollPageJump: (direction: -1 | 1) => void;
  readonly scrollByPixels: (deltaY: number) => void;
  readonly getAnchor: () => ReaderAnchor | undefined;
  readonly getPageTurnAnchor: (direction: -1 | 1) => Promise<ReaderAnchor | undefined>;
  readonly scrollToAnchor: (
    anchor: ReaderAnchor,
    offsetFromTop?: number,
    placement?: ReaderAnchorPlacement,
  ) => Promise<boolean>;
  readonly getParagraphAtIndex: (paragraphIndex: number) => Promise<Paragraph | undefined>;
  readonly getCachedParagraphById: (paragraphId: string) => Paragraph | undefined;
  readonly getLocation: () => ReaderLocationSnapshot | undefined;
  readonly getSelection: () => ReaderSelection | undefined;
}

export type ReaderRuntimeFlow = 'scroll' | 'paginated';
export type ReaderAnchorPlacement = 'contain' | 'page-start' | 'previous-page';

export interface ReaderViewportProps {
  readonly repository: ReaderRepository;
  readonly novel: Pick<Novel, 'id' | 'title' | 'totalChapters' | 'activeContentRevisionId' | 'format'>;
  readonly chapter: Chapter;
  readonly chapters: readonly Chapter[];
  readonly settings: ReaderSettings;
  readonly readingFlow: ReaderRuntimeFlow;
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
  readonly onToggleImmersive: () => void;
  readonly onPageIntent: (direction: -1 | 1) => void;
  readonly onScrollIntent: (deltaY: number) => void;
  readonly onDocumentLink: (href: string, footnote: boolean) => void;
  readonly assetRepository?: BookAssetRepository;
}

export interface ReaderViewportLayerProps extends ReaderViewportProps {
  readonly isActive: boolean;
}

function createViewportApiProxy(
  targetRef: MutableRefObject<ReaderViewportApi | undefined>,
  fallbackFlow: ReaderRuntimeFlow,
): ReaderViewportApi {
  const current = () => targetRef.current;
  return {
    get flow() {
      return current()?.flow ?? fallbackFlow;
    },
    resetContent: () => current()?.resetContent(),
    flushPosition: () => current()?.flushPosition() ?? Promise.resolve(),
    flushPositionImmediately: () => current()?.flushPositionImmediately() ?? Promise.resolve(),
    scrollToParagraph: (paragraphId) => current()?.scrollToParagraph(paragraphId) ?? Promise.resolve(false),
    scrollToParagraphIndex: (paragraphIndex, align, behavior) =>
      current()?.scrollToParagraphIndex(paragraphIndex, align, behavior) ?? Promise.resolve(),
    scrubTo: (progress) => current()?.scrubTo(progress) ?? Promise.resolve(),
    pageJump: (direction) => current()?.pageJump(direction),
    goChapter: (direction) => current()?.goChapter(direction) ?? Promise.resolve(),
    scrollPageJump: (direction) => current()?.scrollPageJump(direction),
    scrollByPixels: (deltaY) => current()?.scrollByPixels(deltaY),
    getAnchor: () => current()?.getAnchor(),
    getPageTurnAnchor: (direction) => current()?.getPageTurnAnchor(direction) ?? Promise.resolve(undefined),
    scrollToAnchor: (anchor, offsetFromTop, placement) =>
      current()?.scrollToAnchor(anchor, offsetFromTop, placement) ?? Promise.resolve(false),
    getParagraphAtIndex: (paragraphIndex) =>
      current()?.getParagraphAtIndex(paragraphIndex) ?? Promise.resolve(undefined),
    getCachedParagraphById: (paragraphId) => current()?.getCachedParagraphById(paragraphId),
    getLocation: () => current()?.getLocation(),
    getSelection: () => current()?.getSelection(),
  };
}

function sourceTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    const parent = text.parentElement;
    if (text.data.length > 0 && !parent?.closest('.segment-meta, rt')) nodes.push(text);
    current = walker.nextNode();
  }
  return nodes;
}

function sourceRange(root: HTMLElement, startOffset: number, endOffset: number): Range | undefined {
  const nodes = sourceTextNodes(root);
  if (nodes.length === 0) return undefined;
  const total = nodes.reduce((sum, node) => sum + node.data.length, 0);
  const start = clamp(startOffset, 0, total);
  const end = clamp(Math.max(start + 1, endOffset), 0, total);
  let traversed = 0;
  let startPoint: { node: Text; offset: number } | undefined;
  let endPoint: { node: Text; offset: number } | undefined;
  for (const node of nodes) {
    const next = traversed + node.data.length;
    if (!startPoint && start <= next) startPoint = { node, offset: Math.min(node.data.length, start - traversed) };
    if (!endPoint && end <= next) {
      endPoint = { node, offset: Math.min(node.data.length, end - traversed) };
      break;
    }
    traversed = next;
  }
  startPoint ??= { node: nodes.at(-1)!, offset: nodes.at(-1)!.data.length };
  endPoint ??= { node: nodes.at(-1)!, offset: nodes.at(-1)!.data.length };
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

function readerContentTop(root: HTMLElement): number {
  const paddingTop = Number.parseFloat(window.getComputedStyle(root).paddingTop) || 0;
  return root.getBoundingClientRect().top + paddingTop;
}

function readerContentBottom(root: HTMLElement): number {
  const paddingBottom = Number.parseFloat(window.getComputedStyle(root).paddingBottom) || 0;
  return root.getBoundingClientRect().bottom - paddingBottom;
}

function visibleSentenceOffset(root: HTMLElement, paragraphElement: HTMLElement, paragraph: Paragraph): number {
  const viewportTop = readerContentTop(root) + 1;
  if (paragraphElement.getBoundingClientRect().top >= viewportTop) return 0;
  for (const sentence of sentenceRanges(paragraph.text)) {
    const range = sourceRange(paragraphElement, sentence.start, sentence.end);
    if (range && [...range.getClientRects()].some((rect) => rect.bottom > viewportTop)) return sentence.start;
  }
  return Math.max(0, paragraph.text.length - 1);
}

interface FullyVisibleSentence {
  readonly paragraph: Paragraph;
  readonly paragraphIndex: number;
  readonly endOffset: number;
}

function lastFullyVisibleSentence(
  root: HTMLElement,
  paragraphAt: (index: number) => Paragraph | undefined,
): FullyVisibleSentence | undefined {
  const viewportTop = readerContentTop(root) + 1;
  const viewportBottom = readerContentBottom(root) - 1;
  let candidate: FullyVisibleSentence | undefined;
  for (const element of root.querySelectorAll<HTMLElement>('[data-paragraph-id]')) {
    const row = element.closest<HTMLElement>('[data-index]');
    const paragraphIndex = Number(row?.dataset.index);
    const paragraph = Number.isInteger(paragraphIndex) ? paragraphAt(paragraphIndex) : undefined;
    if (!paragraph || paragraph.text.length === 0) continue;
    for (const sentence of sentenceRanges(paragraph.text)) {
      const range = sourceRange(element, sentence.start, sentence.end);
      const rects = range ? [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0) : [];
      if (
        rects.length > 0 &&
        rects.every((rect) => rect.top >= viewportTop - 0.5 && rect.bottom <= viewportBottom + 0.5)
      ) {
        candidate = { paragraph, paragraphIndex, endOffset: sentence.end };
      }
    }
  }
  return candidate;
}

function hasReadableContent(paragraph: Paragraph): boolean {
  if (paragraph.documentKind === 'image') return true;
  return paragraph.text.replace(/[\s\u200b-\u200d\u2060\ufeff]/gu, '').length > 0;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
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
  onToggleImmersive,
  onPageIntent,
  onDocumentLink,
  assetRepository,
  isActive,
}: ReaderViewportLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLElement>(null);
  const appliedOpenSequenceRef = useRef<number>();
  const visibleAnchorIndexRef = useRef<number>();
  const pages = useParagraphPages(repository, chapter.id, chapter.paragraphCount);
  const virtualizer = useVirtualizer({
    count: chapter.paragraphCount,
    getScrollElement: () => rootRef.current,
    estimateSize: () => Math.max(settings.fontSize * settings.lineHeight * 2.4, 72),
    measureElement: (element) => Math.ceil(element.getBoundingClientRect().height),
    overscan: 6,
  });
  const measureVirtualRow = useCallback(
    (element: Element | null) => {
      virtualizer.measureElement(element);
      if (!element) return;
      const index = Number((element as HTMLElement).dataset.index);
      if (!Number.isInteger(index)) return;
      virtualizer.resizeItem(index, Math.ceil(element.getBoundingClientRect().height));
    },
    [virtualizer],
  );
  const measureMountedRows = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const row of root.querySelectorAll<HTMLElement>('.reader-virtual-row[data-index]')) {
      measureVirtualRow(row);
    }
  }, [measureVirtualRow]);
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
    onVisualLocation: (location) => {
      if (isActive) onVisualLocation(location);
    },
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

  const scrollByPixels = useCallback((deltaY: number) => {
    const root = rootRef.current;
    if (!root || !Number.isFinite(deltaY) || deltaY === 0) return;
    root.scrollBy({ top: deltaY, behavior: 'auto' });
  }, []);

  const scrollPageJump = useCallback(
    (direction: -1 | 1) => {
      const root = rootRef.current;
      if (!root) return;
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const distance = Math.max(120, readerContentBottom(root) - readerContentTop(root) - 24);
      root.scrollBy({
        top: distance * direction,
        behavior: settings.readingProfile.pageTurnMotion === 'smooth' && !reducedMotion ? 'smooth' : 'auto',
      });
      onRevealChrome();
    },
    [onRevealChrome, settings.readingProfile.pageTurnMotion],
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
  const nextChapter = chapters.find((candidate) => candidate.index === chapter.index + 1);
  const scrollChapterBoundary = useScrollChapterBoundary({
    rootRef,
    contentRef: documentRef,
    chapterId: chapter.id,
    enabled: Boolean(nextChapter),
    onNextChapter: () => goChapter(1),
  });

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

  const getVisibleAnchor = useCallback((): ReaderAnchor | undefined => {
    const root = rootRef.current;
    if (root) {
      const viewportTop = readerContentTop(root);
      const viewportBottom = readerContentBottom(root);
      for (const element of root.querySelectorAll<HTMLElement>('[data-paragraph-id]')) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= viewportTop + 1 || rect.top >= viewportBottom) continue;
        const row = element.closest<HTMLElement>('[data-index]');
        const blockIndex = Number(row?.dataset.index);
        const paragraph = Number.isInteger(blockIndex) ? pages.paragraphAt(blockIndex) : undefined;
        if (!paragraph) continue;
        return {
          bookId: novel.id,
          contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
          sectionId: chapter.id,
          blockId: paragraph.id,
          blockIndex,
          offset: visibleSentenceOffset(root, element, paragraph),
          sourceLocator: paragraph.sourceLocator,
        };
      }
    }
    const current = progress.readLocation();
    const blockIndex = current?.paragraph ? current.paragraph.index - 1 : Math.max(0, current?.paragraphIndex ?? 1) - 1;
    const paragraph = current?.paragraph ?? pages.paragraphAt(blockIndex);
    if (!paragraph) return undefined;
    return {
      bookId: novel.id,
      contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
      sectionId: chapter.id,
      blockId: paragraph.id,
      blockIndex,
      offset: current?.offsetInParagraph ?? 0,
      sourceLocator: paragraph.sourceLocator,
    };
  }, [chapter.id, novel.activeContentRevisionId, novel.id, pages, progress]);

  const getPageTurnAnchor = useCallback(
    async (direction: -1 | 1): Promise<ReaderAnchor | undefined> => {
      const root = rootRef.current;
      if (root) {
        const indexes = [...root.querySelectorAll<HTMLElement>('[data-index]')]
          .map((element) => Number(element.dataset.index))
          .filter(Number.isInteger);
        const lastIndex = indexes.at(-1);
        if (lastIndex !== undefined) {
          for (let index = lastIndex + 1; index <= Math.min(lastIndex + 6, chapter.paragraphCount - 1); index += 1) {
            indexes.push(index);
          }
        }
        await pages.loadIndexes(indexes);
      }
      if (direction < 0) return getVisibleAnchor();
      const activeRoot = rootRef.current;
      const candidate = activeRoot ? lastFullyVisibleSentence(activeRoot, pages.paragraphAt) : undefined;
      if (!candidate) return getVisibleAnchor();
      if (candidate.endOffset < candidate.paragraph.text.length) {
        return {
          bookId: novel.id,
          contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
          sectionId: chapter.id,
          blockId: candidate.paragraph.id,
          blockIndex: candidate.paragraphIndex,
          offset: candidate.endOffset,
          sourceLocator: candidate.paragraph.sourceLocator,
        };
      }
      for (let index = candidate.paragraphIndex + 1; index < chapter.paragraphCount; index += 1) {
        const paragraph = pages.paragraphAt(index) ?? (await pages.getParagraphAt(index));
        if (!paragraph) continue;
        if (!hasReadableContent(paragraph)) continue;
        return {
          bookId: novel.id,
          contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
          sectionId: chapter.id,
          blockId: paragraph.id,
          blockIndex: index,
          offset: 0,
          sourceLocator: paragraph.sourceLocator,
        };
      }
      return {
        bookId: novel.id,
        contentRevisionId: novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}`,
        sectionId: chapter.id,
        blockId: candidate.paragraph.id,
        blockIndex: candidate.paragraphIndex,
        offset: candidate.endOffset,
        sourceLocator: candidate.paragraph.sourceLocator,
      };
    },
    [chapter.id, chapter.paragraphCount, getVisibleAnchor, novel.activeContentRevisionId, novel.id, pages],
  );

  apiRef.current = {
    flow: 'scroll',
    resetContent: pages.reset,
    flushPosition: progress.flush,
    flushPositionImmediately: progress.flushImmediately,
    scrollToParagraph,
    scrollToParagraphIndex,
    scrubTo,
    pageJump: onPageIntent,
    goChapter: (direction) => goChapter(direction, direction < 0),
    scrollPageJump,
    scrollByPixels,
    getAnchor: getVisibleAnchor,
    getPageTurnAnchor,
    scrollToAnchor: async (anchor, offsetFromTop = 0) => {
      if (anchor.sectionId !== chapter.id) return false;
      const targetIndex = clamp(anchor.blockIndex ?? 0, 0, Math.max(0, chapter.paragraphCount - 1));
      await pages.loadIndexes([targetIndex]);
      virtualizer.measure();
      await nextPaint();
      measureMountedRows();
      virtualizer.scrollToIndex(targetIndex, { align: 'start', behavior: 'auto' });
      let stableFrames = 0;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await nextPaint();
        measureMountedRows();
        const root = rootRef.current;
        if (!root) return false;
        const paragraphElement =
          [...root.querySelectorAll<HTMLElement>('[data-paragraph-id]')].find(
            (element) => element.dataset.paragraphId === anchor.blockId,
          ) ?? root.querySelector<HTMLElement>(`[data-index="${targetIndex}"] [data-paragraph-id]`);
        if (!paragraphElement) {
          virtualizer.scrollToIndex(targetIndex, { align: 'start', behavior: 'auto' });
          continue;
        }
        const range = sourceRange(paragraphElement, anchor.offset, anchor.offset + 1);
        const rect = range?.getBoundingClientRect() ?? paragraphElement.getBoundingClientRect();
        const correction = rect.top - (readerContentTop(root) + offsetFromTop);
        if (Math.abs(correction) <= 1) {
          stableFrames += 1;
          if (stableFrames >= 2) return true;
          continue;
        }
        stableFrames = 0;
        root.scrollTop += correction;
      }
      const root = rootRef.current;
      if (!root) return false;
      virtualizer.scrollToIndex(targetIndex, { align: 'start', behavior: 'auto' });
      await nextPaint();
      root.scrollTop = Math.max(0, root.scrollTop - offsetFromTop);
      return true;
    },
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
    if (!isActive) return;
    virtualizer.measure();
    let settleFrame = 0;
    const measureFrame = window.requestAnimationFrame(() => {
      measureMountedRows();
      settleFrame = window.requestAnimationFrame(measureMountedRows);
    });
    return () => {
      window.cancelAnimationFrame(measureFrame);
      window.cancelAnimationFrame(settleFrame);
    };
  }, [
    chapter.id,
    isActive,
    measureMountedRows,
    settings.fontSize,
    settings.lineHeight,
    settings.paragraphSpacing,
    virtualizer,
  ]);

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
        restoreFrame = window.requestAnimationFrame(() => {
          measureMountedRows();
          virtualizer.scrollToIndex(anchorIndex, { align: 'start', behavior: 'auto' });
        });
      });
    });
    observer.observe(documentElement);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(restoreFrame ?? 0);
    };
  }, [chapter.id, firstVisible, measureMountedRows, virtualizer]);

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

  const actionHandlers = {
    previousPage: () => onPageIntent(-1),
    nextPage: () => onPageIntent(1),
    toggleChrome: onToggleImmersive,
    openToc: () => screenHandle.getActions().openAddon('outline'),
    openSettings: () => screenHandle.getActions().openSettings(),
    toggleTTS: () => screenHandle.getActions().toggleTTS(progress.readLocation()?.ttsIndex ?? 0),
  };
  const gestureHandlers = useReaderGestureHandlers({
    bindings: { ...settings.gestureBindings, tapCenter: 'toggle_chrome' },
    viewportWidth: () => rootRef.current?.clientWidth ?? window.innerWidth,
    actions: actionHandlers,
    onVerticalScrollIntent: scrollChapterBoundary.onVerticalGesture,
  });

  return (
    <section
      ref={rootRef}
      className={`reader-scroll reader-viewport-layer ${isActive ? 'is-active' : 'is-inactive'} ${scrollChapterBoundary.armed ? 'is-next-chapter-armed' : ''} font-${settings.font} mode-${mode}`}
      tabIndex={isActive ? 0 : -1}
      aria-hidden={!isActive}
      data-reader-layer="scroll"
      onScroll={() => {
        onRevealChrome();
        visibleAnchorIndexRef.current = firstVisible().index;
        progress.handleScroll();
        scrollChapterBoundary.onScroll();
      }}
      onWheel={scrollChapterBoundary.onWheel}
      onKeyUp={updateSelection}
      onMouseUp={updateSelection}
      onPointerDown={(event) => {
        const shouldCaptureBoundaryGesture = scrollChapterBoundary.onPointerDown(event.clientY);
        gestureHandlers.onPointerDown(event);
        if (shouldCaptureBoundaryGesture) {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // Synthetic pointer events do not own an active pointer, but the gesture can still be handled.
          }
        }
      }}
      onPointerMove={(event) => {
        if (scrollChapterBoundary.onPointerMove(event.clientY)) event.preventDefault();
      }}
      onPointerUp={(event) => {
        gestureHandlers.onPointerUp(event);
        scrollChapterBoundary.onPointerEnd();
      }}
      onPointerCancel={scrollChapterBoundary.onPointerEnd}
      onClick={(event) => event.stopPropagation()}
    >
      <article ref={documentRef} className="reader-document">
        <ReaderChapterHeading chapter={chapter} />
        <div className="reader-virtual-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualItems.map((item) => {
            const paragraph = pages.paragraphAt(item.index);
            if (!paragraph) {
              const pageIndex = Math.floor(item.index / PARAGRAPHS_PER_PAGE);
              const failed = failedRows.has(item.index);
              return (
                <div
                  key={`${failed ? 'failed' : 'loading'}-${item.index}`}
                  ref={measureVirtualRow}
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
                measureElement={measureVirtualRow}
                onSelectCorrectionSegment={(segmentId) => screenHandle.getActions().selectCorrectionSegment(segmentId)}
                assetRepository={assetRepository}
                contentRevisionId={novel.activeContentRevisionId}
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
        {nextChapter && (
          <div
            className={`reader-next-chapter-boundary${scrollChapterBoundary.armed ? ' is-armed' : ''}`}
            data-scroll-chapter-boundary="true"
            data-scroll-chapter-boundary-armed={scrollChapterBoundary.armed ? 'true' : 'false'}
            aria-live="polite"
          >
            <span>다음 화</span>
            <strong>
              {nextChapter.index}화 · {nextChapter.title}
            </strong>
            <small>{scrollChapterBoundary.armed ? '한 번 더 아래로 스크롤' : '마지막까지 읽었습니다'}</small>
          </div>
        )}
      </article>
    </section>
  );
}

function ReaderViewportComponent(props: ReaderViewportProps) {
  const { apiRef: outerApiRef, onApiReady: notifyApiReady } = props;
  const [paginationFailed, setPaginationFailed] = useState(false);
  const [paginationMounted, setPaginationMounted] = useState(props.readingFlow === 'paginated');
  const [scrollApiReady, setScrollApiReady] = useState(false);
  const [pageApiReady, setPageApiReady] = useState(false);
  const scrollApiRef = useRef<ReaderViewportApi>();
  const pageApiRef = useRef<ReaderViewportApi>();
  const scrollApi = useMemo(() => createViewportApiProxy(scrollApiRef, 'scroll'), []);
  const pageApi = useMemo(() => createViewportApiProxy(pageApiRef, 'paginated'), []);
  const handlePaginationFailure = useCallback(() => setPaginationFailed(true), []);
  const handleScrollApiReady = useCallback((api?: ReaderViewportApi) => setScrollApiReady(Boolean(api)), []);
  const handlePageApiReady = useCallback((api?: ReaderViewportApi) => setPageApiReady(Boolean(api)), []);
  const paginationProfileKey = JSON.stringify(props.settings.readingProfile);
  useEffect(() => setPaginationFailed(false), [props.chapter.id, paginationProfileKey]);
  useEffect(() => {
    if (props.readingFlow === 'paginated') setPaginationMounted(true);
  }, [props.readingFlow]);
  const pageActive = props.readingFlow === 'paginated' && !paginationFailed;
  useLayoutEffect(() => {
    const selected = pageActive ? (pageApiReady ? pageApi : undefined) : scrollApiReady ? scrollApi : undefined;
    outerApiRef.current = selected;
    notifyApiReady(selected);
    return () => {
      if (outerApiRef.current === selected) outerApiRef.current = undefined;
    };
  }, [notifyApiReady, outerApiRef, pageActive, pageApi, pageApiReady, scrollApi, scrollApiReady]);
  useEffect(
    () => () => {
      outerApiRef.current = undefined;
      notifyApiReady(undefined);
    },
    [notifyApiReady, outerApiRef],
  );
  return (
    <div className="reader-viewport-stack">
      <VirtualizedReaderViewportComponent
        {...props}
        apiRef={scrollApiRef}
        onApiReady={handleScrollApiReady}
        isActive={!pageActive}
      />
      {(paginationMounted || props.readingFlow === 'paginated') && !paginationFailed && (
        <PaginatedReaderViewport
          {...props}
          apiRef={pageApiRef}
          onApiReady={handlePageApiReady}
          isActive={pageActive}
          onPaginationFailure={handlePaginationFailure}
        />
      )}
    </div>
  );
}

export const ReaderViewport = memo(ReaderViewportComponent);
