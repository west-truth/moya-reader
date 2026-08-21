import { SkipBack, SkipForward } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Paragraph, ReaderAnchor, ReaderPageBoundary } from '../../domain/types';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import type { ReaderRepository } from '../../repositories/reader-repository';
import {
  loadReaderPageMap,
  pruneReaderPageMaps,
  saveReaderPageMap,
  type ReaderPageMapIdentity,
} from '../../storage/reader-page-map-store';
import { clamp } from '../../utils/format';
import { ReaderParagraphRow } from './ReaderParagraphRow';
import type { ReaderViewportApi, ReaderViewportProps } from './ReaderViewport';
import { useReaderGestureHandlers } from './use-reader-gestures';
import { useReaderPositionPersistence } from './use-reader-progress';
import {
  LruMap,
  pageIndexForAnchor,
  safeOversizedSentenceEnd,
  sentenceEnds,
  sliceParagraphForPage,
  type ReaderPageFragment,
} from './reader-pagination-model';

const PAGINATION_RENDERER_VERSION = 'reader-pagination-v3-sentence-safe-area';
const PAGE_MAP_CACHE_LIMIT = 24;
const PAGE_FRAGMENT_CACHE_LIMIT = 12;
const PAGE_PREFETCH_RADIUS = 2;
const PAGE_SAFETY_PX = 2;
const PAGE_TURN_DURATION_MS = 180;
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

function appendMeasurementInline(content: HTMLElement, paragraph: Paragraph, start: number, end: number): void {
  const marks = paragraph.inlineMarks ?? [];
  const semantics = paragraph.inlineSemantics ?? [];
  if (marks.length === 0 && semantics.length === 0) {
    content.textContent = paragraph.text.slice(start, end);
    return;
  }
  const boundaries = new Set([start, end]);
  for (const item of [...marks, ...semantics]) {
    if (item.end <= start || item.start >= end) continue;
    boundaries.add(Math.max(start, item.start));
    boundaries.add(Math.min(end, item.end));
  }
  const points = [...boundaries].sort((left, right) => left - right);
  for (let index = 0; index < points.length - 1; index += 1) {
    const segmentStart = points[index];
    const segmentEnd = points[index + 1];
    const activeMarks = marks.filter((mark) => mark.start <= segmentStart && mark.end >= segmentEnd);
    const activeSemantics = semantics.filter(
      (semantic) => semantic.start <= segmentStart && semantic.end >= segmentEnd,
    );
    let node: Node = document.createTextNode(paragraph.text.slice(segmentStart, segmentEnd));
    const ruby = activeSemantics.find((semantic) => semantic.kind === 'ruby' && semantic.value);
    if (ruby?.value) {
      const element = document.createElement('ruby');
      element.append(node);
      const annotation = document.createElement('rt');
      annotation.textContent = ruby.value;
      element.append(annotation);
      node = element;
    }
    if (activeMarks.some((mark) => mark.kind === 'strong')) {
      const element = document.createElement('strong');
      element.append(node);
      node = element;
    }
    if (activeMarks.some((mark) => mark.kind === 'emphasis')) {
      const element = document.createElement('em');
      element.append(node);
      node = element;
    }
    const language = activeSemantics.find((semantic) => semantic.kind === 'language' && semantic.value)?.value;
    if (language) {
      const element = document.createElement('span');
      element.lang = language;
      element.append(node);
      node = element;
    }
    if (activeMarks.some((mark) => mark.kind === 'link')) {
      const element = document.createElement('a');
      element.append(node);
      node = element;
    }
    content.append(node);
  }
}

function measurementBlock(paragraph: Paragraph, start: number, end: number): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'reader-virtual-row is-static';
  const paragraphRoot = document.createElement('div');
  paragraphRoot.className = 'reader-paragraph';
  let content: HTMLElement;
  switch (paragraph.documentKind) {
    case 'heading':
      content = document.createElement('h2');
      break;
    case 'blockquote':
      content = document.createElement('blockquote');
      break;
    case 'separator':
      content = document.createElement('hr');
      break;
    case 'image':
      content = document.createElement('div');
      content.className = 'reader-pagination-image-measure';
      break;
    default:
      content = document.createElement('p');
  }
  if (paragraph.documentKind === 'list_item') content.className = 'reader-list-item';
  if (paragraph.documentKind !== 'separator' && paragraph.documentKind !== 'image') {
    appendMeasurementInline(content, paragraph, start, end);
  }
  paragraphRoot.append(content);
  wrapper.append(paragraphRoot);
  return wrapper;
}

export function PaginatedReaderViewport(props: ReaderViewportProps & { readonly onPaginationFailure: () => void }) {
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
    onDocumentLink,
    assetRepository,
    onPaginationFailure,
  } = props;
  const rootRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const activeChapterIdRef = useRef(chapter.id);
  const paragraphCacheRef = useRef(new Map<number, Paragraph>());
  const paragraphPageLoadsRef = useRef(new Map<number, Promise<void>>());
  const fragmentCacheRef = useRef(new LruMap<number, readonly ReaderPageFragment[]>(PAGE_FRAGMENT_CACHE_LIMIT));
  const fragmentLoadsRef = useRef(new Map<number, Promise<readonly ReaderPageFragment[]>>());
  const transitionTimerRef = useRef<number>();
  const boundariesRef = useRef<readonly ReaderPageBoundary[]>([]);
  const currentPageRef = useRef(0);
  const requestedPageRef = useRef(0);
  const pageTurnQueueRef = useRef(Promise.resolve());
  const wheelDeltaRef = useRef(0);
  const pageFragmentsRef = useRef<readonly ReaderPageFragment[]>([]);
  const appliedOpenSequenceRef = useRef<number>();
  const visibleAnchorRef = useRef<ReaderAnchor>();
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [boundaries, setBoundaries] = useState<readonly ReaderPageBoundary[]>([]);
  const [complete, setComplete] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [pageFragments, setPageFragments] = useState<readonly ReaderPageFragment[]>([]);
  const [outgoingFragments, setOutgoingFragments] = useState<readonly ReaderPageFragment[]>([]);
  const [transitionDirection, setTransitionDirection] = useState<-1 | 1>();
  const [transitionSequence, setTransitionSequence] = useState(0);
  activeChapterIdRef.current = chapter.id;
  const contentRevisionId = novel.activeContentRevisionId ?? `${novel.id}:${chapter.textHash}`;
  const { schedule: schedulePosition, flush: flushPosition } = useReaderPositionPersistence({
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
        const requestedChapterId = chapter.id;
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
    paragraphCacheRef.current.clear();
    paragraphPageLoadsRef.current.clear();
    fragmentCacheRef.current.clear();
    fragmentLoadsRef.current.clear();
    boundariesRef.current = [];
    setBoundaries([]);
    setComplete(false);
    setCurrentPage(0);
    currentPageRef.current = 0;
    requestedPageRef.current = 0;
    setPageFragments([]);
    setOutgoingFragments([]);
  }, [chapter.id]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    let timer: number | undefined;
    const publish = () => {
      const next = { width: Math.floor(page.clientWidth), height: Math.floor(page.clientHeight) };
      setDimensions((current) => (current.width === next.width && current.height === next.height ? current : next));
    };
    publish();
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(publish, 120);
    });
    observer.observe(page);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  const layoutKey = useMemo(
    () =>
      JSON.stringify({
        contentRevisionId,
        rendererVersion: PAGINATION_RENDERER_VERSION,
        viewportWidth: dimensions.width,
        viewportHeight: dimensions.height,
        devicePixelRatioBucket: Math.round((globalThis.devicePixelRatio || 1) * 2) / 2,
        fontId: settings.readingProfile.fontId,
        fontSize: settings.readingProfile.fontSize,
        fontWeight: settings.readingProfile.fontWeight,
        lineHeight: settings.readingProfile.lineHeight,
        letterSpacing: settings.readingProfile.letterSpacing,
        paragraphSpacing: settings.readingProfile.paragraphSpacing,
        firstLineIndent: settings.readingProfile.firstLineIndent,
        textAlign: settings.readingProfile.textAlign,
        marginX: settings.readingProfile.marginX,
        marginY: settings.readingProfile.marginY,
      }),
    [contentRevisionId, dimensions.height, dimensions.width, settings.readingProfile],
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

  useEffect(() => {
    fragmentCacheRef.current.clear();
    fragmentLoadsRef.current.clear();
    window.clearTimeout(transitionTimerRef.current);
    setOutgoingFragments([]);
    setTransitionDirection(undefined);
  }, [layoutKey]);

  useEffect(
    () => () => {
      window.clearTimeout(transitionTimerRef.current);
    },
    [],
  );

  const applyBoundaries = useCallback(
    (next: readonly ReaderPageBoundary[], done: boolean, preservedAnchor = visibleAnchorRef.current) => {
      boundariesRef.current = next;
      setBoundaries(next);
      setComplete(done);
      setCurrentPage((current) => {
        const anchored = preservedAnchor && next.length > 0 ? pageIndexForAnchor(next, preservedAnchor) : -1;
        const target = anchored >= 0 ? anchored : clamp(current, 0, Math.max(0, next.length - 1));
        currentPageRef.current = target;
        requestedPageRef.current = target;
        return target;
      });
    },
    [],
  );

  useEffect(() => {
    if (dimensions.width < 100 || dimensions.height < 180 || !measureRef.current) return;
    const preservedAnchor = visibleAnchorRef.current;
    const cached = getCachedPageMap(pageMapKey);
    if (cached) {
      applyBoundaries(cached.boundaries, true, preservedAnchor);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const stored = await loadReaderPageMap(pageMapIdentity);
        if (stored && !cancelled) {
          cachePageMap({ key: pageMapKey, boundaries: stored.boundaries });
          applyBoundaries(stored.boundaries, true, preservedAnchor);
          return;
        }
      } catch {
        // The layout cache is an optional local acceleration layer (private mode may reject IndexedDB).
      }
      await document.fonts?.ready;
      const measure = measureRef.current;
      if (!measure || cancelled) return;
      const next: ReaderPageBoundary[] = [];
      let paragraphIndex = 0;
      let offset = 0;
      let pageStart = { paragraphIndex: 0, offset: 0, paragraphId: '' };
      measure.replaceChildren();
      const anchor = (paragraphId: string, paragraph: number, characterOffset: number): ReaderAnchor => ({
        bookId: novel.id,
        contentRevisionId,
        sectionId: chapter.id,
        blockId: paragraphId,
        blockIndex: paragraph,
        offset: characterOffset,
        sourceLocator: paragraphCacheRef.current.get(paragraph)?.sourceLocator,
      });
      const publishBoundary = (paragraphId: string, endParagraph: number, endOffset: number) => {
        const startId = pageStart.paragraphId || paragraphId;
        next.push({
          index: next.length,
          start: anchor(startId, pageStart.paragraphIndex, pageStart.offset),
          end: anchor(paragraphId, endParagraph, endOffset),
        });
        measure.replaceChildren();
      };
      const fitsPage = () => {
        const last = measure.lastElementChild;
        if (!last) return true;
        const containerTop = measure.getBoundingClientRect().top;
        return last.getBoundingClientRect().bottom <= containerTop + Math.max(0, measure.clientHeight - PAGE_SAFETY_PX);
      };

      while (paragraphIndex < chapter.paragraphCount && !cancelled) {
        const paragraph = await getParagraphAtIndex(paragraphIndex);
        if (!paragraph) throw new Error(`Paragraph ${paragraphIndex} is unavailable during pagination.`);
        if (!pageStart.paragraphId) pageStart = { paragraphIndex, offset, paragraphId: paragraph.id };
        const block = measurementBlock(paragraph, offset, paragraph.text.length);
        measure.append(block);
        if (fitsPage()) {
          paragraphIndex += 1;
          offset = 0;
          continue;
        }
        block.remove();
        const existingBlocks = measure.childElementCount > 0;
        const atomic =
          paragraph.documentKind === 'image' ||
          paragraph.documentKind === 'separator' ||
          paragraph.documentKind === 'heading';
        if (atomic && existingBlocks) {
          publishBoundary(paragraph.id, paragraphIndex, offset);
          pageStart = { paragraphIndex, offset, paragraphId: paragraph.id };
        } else if (atomic || paragraph.text.length === 0) {
          measure.append(block);
          publishBoundary(paragraph.id, paragraphIndex, paragraph.text.length);
          paragraphIndex += 1;
          offset = 0;
          pageStart = { paragraphIndex, offset: 0, paragraphId: '' };
        } else {
          let fit = offset;
          for (const sentenceEnd of sentenceEnds(paragraph.text, offset)) {
            const candidate = measurementBlock(paragraph, offset, sentenceEnd);
            measure.append(candidate);
            const fits = fitsPage();
            candidate.remove();
            if (!fits) break;
            fit = sentenceEnd;
          }
          if (fit === offset && existingBlocks) {
            publishBoundary(paragraph.id, paragraphIndex, offset);
            pageStart = { paragraphIndex, offset, paragraphId: paragraph.id };
            continue;
          }
          if (fit === offset) {
            let low = Math.min(offset + 1, paragraph.text.length);
            let high = paragraph.text.length;
            let measuredFit = low;
            while (low <= high) {
              const middle = Math.floor((low + high) / 2);
              const candidate = measurementBlock(paragraph, offset, middle);
              measure.replaceChildren(candidate);
              if (fitsPage()) {
                measuredFit = middle;
                low = middle + 1;
              } else {
                high = middle - 1;
              }
            }
            fit = safeOversizedSentenceEnd(paragraph.text, offset, measuredFit);
          }
          measure.replaceChildren(measurementBlock(paragraph, offset, fit));
          publishBoundary(paragraph.id, paragraphIndex, fit);
          offset = fit;
          if (offset >= paragraph.text.length) {
            paragraphIndex += 1;
            offset = 0;
          }
          pageStart = {
            paragraphIndex,
            offset,
            paragraphId: offset > 0 && paragraphIndex < chapter.paragraphCount ? paragraph.id : '',
          };
        }
        if (next.length === 1 || next.length % 8 === 0) {
          applyBoundaries([...next], false, preservedAnchor);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      if (cancelled) return;
      if (measure.childElementCount > 0 || next.length === 0) {
        const lastIndex = Math.max(0, chapter.paragraphCount - 1);
        const last = await getParagraphAtIndex(lastIndex);
        if (last) publishBoundary(last.id, lastIndex, last.text.length);
      }
      const result = [...next];
      applyBoundaries(result, true, preservedAnchor);
      cachePageMap({ key: pageMapKey, boundaries: result });
      void saveReaderPageMap(pageMapIdentity, result)
        .then(() => pruneReaderPageMaps(PAGE_MAP_CACHE_LIMIT))
        .catch(() => undefined);
    };
    void run().catch(() => {
      if (!cancelled) {
        setComplete(false);
        screenHandle.getActions().notify('페이지 계산에 실패해 스크롤 방식으로 전환합니다.', 'warning');
        onPaginationFailure();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    applyBoundaries,
    chapter.id,
    chapter.paragraphCount,
    contentRevisionId,
    dimensions.height,
    dimensions.width,
    getParagraphAtIndex,
    layoutKey,
    novel.id,
    onPaginationFailure,
    pageMapIdentity,
    pageMapKey,
    screenHandle,
  ]);

  useEffect(() => {
    if (!complete) return;
    let cancelled = false;
    const warm = async () => {
      const adjacent = chapters.filter((candidate) => Math.abs(candidate.index - chapter.index) === 1);
      for (const candidate of adjacent) {
        const pageCount = Math.ceil(candidate.paragraphCount / PARAGRAPHS_PER_PAGE);
        const indexes = Array.from({ length: pageCount }, (_, index) => index);
        if (candidate.index > chapter.index) indexes.reverse();
        for (const pageIndex of indexes) {
          if (cancelled) return;
          await loadSharedParagraphPage(repository, contentRevisionId, candidate.id, pageIndex).catch(() => []);
        }
      }
    };
    const idleId = globalThis.requestIdleCallback(() => void warm(), { timeout: 1_500 });
    return () => {
      cancelled = true;
      globalThis.cancelIdleCallback(idleId);
    };
  }, [chapter.index, chapters, complete, contentRevisionId, repository]);

  const loadPageFragments = useCallback(
    async (pageIndex: number): Promise<readonly ReaderPageFragment[]> => {
      const cached = fragmentCacheRef.current.get(pageIndex);
      if (cached && (cached.length > 0 || chapter.paragraphCount === 0)) return cached;
      const existing = fragmentLoadsRef.current.get(pageIndex);
      if (existing) return existing;
      const boundary = boundariesRef.current[pageIndex];
      if (!boundary) return [];
      const pending = (async () => {
        const fragments: ReaderPageFragment[] = [];
        const startIndex = boundary.start.blockIndex ?? 0;
        const endIndex = boundary.end.blockIndex ?? startIndex;
        for (let index = startIndex; index <= endIndex; index += 1) {
          if (index === endIndex && boundary.end.offset === 0 && endIndex > startIndex) break;
          const paragraph = await getParagraphAtIndex(index);
          if (!paragraph) throw new Error(`Paragraph ${index} is unavailable while materializing page ${pageIndex}.`);
          const start = index === startIndex ? boundary.start.offset : 0;
          const end = index === endIndex ? boundary.end.offset : paragraph.text.length;
          fragments.push({ paragraph, paragraphIndex: index, startOffset: start, endOffset: end });
        }
        if (fragments.length === 0 && chapter.paragraphCount > 0) {
          throw new Error(`Page ${pageIndex} did not materialize any source fragments.`);
        }
        fragmentCacheRef.current.set(pageIndex, fragments);
        return fragments;
      })();
      fragmentLoadsRef.current.set(pageIndex, pending);
      try {
        return await pending;
      } finally {
        fragmentLoadsRef.current.delete(pageIndex);
      }
    },
    [chapter.paragraphCount, getParagraphAtIndex],
  );

  useEffect(() => {
    const boundary = boundaries[currentPage];
    if (!boundary) return;
    currentPageRef.current = currentPage;
    let cancelled = false;
    void loadPageFragments(currentPage).then((fragments) => {
      if (!cancelled && currentPageRef.current === currentPage) setPageFragments(fragments);
    });
    for (let distance = 1; distance <= PAGE_PREFETCH_RADIUS; distance += 1) {
      if (currentPage - distance >= 0) void loadPageFragments(currentPage - distance);
      if (currentPage + distance < boundaries.length) void loadPageFragments(currentPage + distance);
    }
    return () => {
      cancelled = true;
    };
  }, [boundaries, currentPage, loadPageFragments]);

  useEffect(() => {
    pageFragmentsRef.current = pageFragments;
  }, [pageFragments]);

  const currentBoundary = boundaries[currentPage];
  const currentParagraph = pageFragments[0]?.paragraph;
  const location = useMemo(
    () =>
      currentBoundary
        ? {
            progress:
              chapter.paragraphCount > 1 ? (currentBoundary.start.blockIndex ?? 0) / (chapter.paragraphCount - 1) : 0,
            scrollTop: currentPage,
            paragraphIndex: currentParagraph?.index ?? (currentBoundary.start.blockIndex ?? 0) + 1,
            paragraph: currentParagraph,
            offsetInParagraph: currentBoundary.start.offset,
            ttsIndex: currentBoundary.start.blockIndex ?? 0,
          }
        : undefined,
    [chapter.paragraphCount, currentBoundary, currentPage, currentParagraph],
  );

  useEffect(() => {
    if (complete && currentBoundary) visibleAnchorRef.current = currentBoundary.start;
  }, [complete, currentBoundary]);

  useEffect(() => {
    if (!location) return;
    onVisualLocation(location);
    schedulePosition(location, currentBoundary?.start.offset ?? 0);
  }, [currentBoundary?.start.offset, location, onVisualLocation, schedulePosition]);

  useEffect(() => {
    if (
      !openRequest?.position?.paragraphId ||
      boundaries.length === 0 ||
      appliedOpenSequenceRef.current === openRequest.sequence
    )
      return;
    let cancelled = false;
    void repository.getParagraph(openRequest.position.paragraphId).then((target) => {
      if (!target || cancelled) return;
      const targetAnchor: ReaderAnchor = {
        bookId: novel.id,
        contentRevisionId,
        sectionId: chapter.id,
        blockId: target.id,
        blockIndex: target.index - 1,
        offset: openRequest.position?.offsetInParagraph ?? 0,
      };
      const index = pageIndexForAnchor(boundaries, targetAnchor);
      if (index >= 0) {
        appliedOpenSequenceRef.current = openRequest.sequence;
        currentPageRef.current = index;
        requestedPageRef.current = index;
        setCurrentPage(index);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [boundaries, chapter.id, contentRevisionId, novel.id, openRequest, repository]);

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

  const activatePage = useCallback(
    async (targetPage: number, direction: -1 | 1) => {
      const fragments = await loadPageFragments(targetPage);
      window.clearTimeout(transitionTimerRef.current);
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const animate = settings.readingProfile.pageTurnMotion === 'smooth' && !reducedMotion;
      if (animate && pageFragmentsRef.current.length > 0) {
        setOutgoingFragments(pageFragmentsRef.current);
        setTransitionDirection(direction);
        setTransitionSequence((sequence) => sequence + 1);
        transitionTimerRef.current = window.setTimeout(() => {
          setOutgoingFragments([]);
          setTransitionDirection(undefined);
        }, PAGE_TURN_DURATION_MS);
      } else {
        setOutgoingFragments([]);
        setTransitionDirection(undefined);
      }
      pageFragmentsRef.current = fragments;
      currentPageRef.current = targetPage;
      requestedPageRef.current = targetPage;
      setPageFragments(fragments);
      setCurrentPage(targetPage);
    },
    [loadPageFragments, settings.readingProfile.pageTurnMotion],
  );

  const pageJump = useCallback(
    (direction: -1 | 1) => {
      const target = requestedPageRef.current + direction;
      if (target < 0 || target >= boundariesRef.current.length) {
        pageTurnQueueRef.current = pageTurnQueueRef.current.then(() => goChapter(direction)).catch(() => undefined);
      } else {
        requestedPageRef.current = target;
        pageTurnQueueRef.current = pageTurnQueueRef.current
          .then(() => activatePage(target, direction))
          .catch(() => {
            requestedPageRef.current = currentPageRef.current;
          });
      }
      onRevealChrome();
    },
    [activatePage, goChapter, onRevealChrome],
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
  });

  const api = useMemo<ReaderViewportApi>(
    () => ({
      resetContent: () => {
        currentPageRef.current = 0;
        requestedPageRef.current = 0;
        setCurrentPage(0);
      },
      flushPosition,
      scrollToParagraph: async (paragraphId) => {
        const paragraph = await repository.getParagraph(paragraphId);
        if (!paragraph || paragraph.chapterId !== chapter.id) return false;
        const page = pageIndexForAnchor(boundaries, {
          bookId: novel.id,
          contentRevisionId,
          sectionId: chapter.id,
          blockId: paragraph.id,
          blockIndex: paragraph.index - 1,
          offset: 0,
        });
        if (page >= 0) {
          currentPageRef.current = page;
          requestedPageRef.current = page;
          setCurrentPage(page);
        }
        return page >= 0;
      },
      scrollToParagraphIndex: async (index) => {
        const paragraph = await getParagraphAtIndex(index);
        if (!paragraph) return;
        const page = pageIndexForAnchor(boundaries, {
          bookId: novel.id,
          contentRevisionId,
          sectionId: chapter.id,
          blockId: paragraph.id,
          blockIndex: paragraph.index - 1,
          offset: 0,
        });
        if (page >= 0) {
          currentPageRef.current = page;
          requestedPageRef.current = page;
          setCurrentPage(page);
        }
      },
      scrubTo: async (progress) => {
        if (boundaries.length) {
          const page = clamp(Math.round(progress * (boundaries.length - 1)), 0, boundaries.length - 1);
          currentPageRef.current = page;
          requestedPageRef.current = page;
          setCurrentPage(page);
        }
      },
      pageJump,
      getAnchor: () => currentBoundary?.start,
      scrollToAnchor: async (anchor) => {
        if (!boundaries.length) return false;
        const page = pageIndexForAnchor(boundaries, anchor);
        currentPageRef.current = page;
        requestedPageRef.current = page;
        setCurrentPage(page);
        return true;
      },
      getParagraphAtIndex,
      getCachedParagraphById: (paragraphId) =>
        [...paragraphCacheRef.current.values()].find((paragraph) => paragraph.id === paragraphId),
      getLocation: () => location,
      getSelection: () => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.toString().trim()) return undefined;
        const node = selection.anchorNode?.parentElement?.closest<HTMLElement>('[data-paragraph-id]');
        const paragraphId = node?.dataset.paragraphId;
        return paragraphId ? { text: selection.toString(), paragraphId } : undefined;
      },
    }),
    [
      boundaries,
      chapter.id,
      contentRevisionId,
      currentBoundary,
      flushPosition,
      getParagraphAtIndex,
      location,
      novel.id,
      pageJump,
      repository,
    ],
  );

  useEffect(() => {
    apiRef.current = api;
    onApiReady(api);
    return () => {
      if (apiRef.current === api) apiRef.current = undefined;
      onApiReady(undefined);
    };
  }, [api, apiRef, onApiReady]);

  return (
    <section
      className={`reader-scroll font-${settings.font} mode-${mode} reader-paginated-root`}
      ref={rootRef}
      tabIndex={0}
      onPointerDown={gestureHandlers.onPointerDown}
      onPointerUp={gestureHandlers.onPointerUp}
      onWheel={(event) => {
        if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
        event.preventDefault();
        wheelDeltaRef.current += event.deltaY;
        if (Math.abs(wheelDeltaRef.current) < 40) return;
        pageJump(wheelDeltaRef.current > 0 ? 1 : -1);
        wheelDeltaRef.current = 0;
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        ref={measureRef}
        className="reader-document reader-pagination-measure"
        style={{ width: Math.max(120, dimensions.width), height: Math.max(160, dimensions.height) }}
        aria-hidden="true"
      />
      <div
        className={`reader-pagination-stage${transitionDirection ? ` turn-${transitionDirection > 0 ? 'next' : 'previous'}` : ''}`}
      >
        {outgoingFragments.length > 0 && (
          <article key={`outgoing-${transitionSequence}`} className="reader-document reader-paginated-page is-outgoing">
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
        <article
          key={`current-${transitionSequence}`}
          ref={pageRef}
          className="reader-document reader-paginated-page is-current"
          onMouseUp={() => onSelectionChanged(api.getSelection())}
        >
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
          {!boundaries.length && <div className="reader-pagination-status">첫 페이지 계산 중</div>}
        </article>
      </div>
      <footer className="reader-pagination-controls">
        <button
          type="button"
          className="mini-icon-btn"
          disabled={currentPage <= 0 && chapter.index <= 1}
          onClick={() => pageJump(-1)}
          aria-label="이전 페이지"
          title="이전 페이지"
        >
          <SkipBack size={17} />
        </button>
        <span>
          {boundaries.length ? `${currentPage + 1} / ${complete ? boundaries.length : '계산 중'}` : '페이지 계산 중'}
        </span>
        <button
          type="button"
          className="mini-icon-btn"
          disabled={currentPage >= boundaries.length - 1 && chapter.index >= chapters.length}
          onClick={() => pageJump(1)}
          aria-label="다음 페이지"
          title="다음 페이지"
        >
          <SkipForward size={17} />
        </button>
      </footer>
      <nav className="chapter-nav reader-pagination-chapter-nav">
        <button className="ghost-btn" disabled={chapter.index <= 1} onClick={() => void goChapter(-1)}>
          <SkipBack size={18} /> 이전 화
        </button>
        <button className="ghost-btn" disabled={chapter.index >= chapters.length} onClick={() => void goChapter(1)}>
          다음 화 <SkipForward size={18} />
        </button>
      </nav>
    </section>
  );
}
