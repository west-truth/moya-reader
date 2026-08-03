import { SkipBack, SkipForward } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Paragraph, ReaderAnchor, ReaderPageBoundary } from '../../domain/types';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { clamp } from '../../utils/format';
import { ReaderParagraphRow } from './ReaderParagraphRow';
import type { ReaderViewportApi, ReaderViewportProps } from './ReaderViewport';
import { useReaderGestureHandlers } from './use-reader-gestures';
import { useReaderPositionPersistence } from './use-reader-progress';

const PAGINATION_RENDERER_VERSION = 'reader-pagination-v1';
const PAGE_MAP_CACHE_LIMIT = 6;

interface CachedPageMap {
  readonly key: string;
  readonly boundaries: readonly ReaderPageBoundary[];
}

const pageMapCache = new Map<string, CachedPageMap>();

function cachePageMap(value: CachedPageMap): void {
  pageMapCache.delete(value.key);
  pageMapCache.set(value.key, value);
  while (pageMapCache.size > PAGE_MAP_CACHE_LIMIT) {
    const oldest = pageMapCache.keys().next().value as string | undefined;
    if (!oldest) break;
    pageMapCache.delete(oldest);
  }
}

function measurementBlock(paragraph: Paragraph, text: string): HTMLElement {
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
  if (paragraph.documentKind !== 'separator' && paragraph.documentKind !== 'image') content.textContent = text;
  paragraphRoot.append(content);
  wrapper.append(paragraphRoot);
  return wrapper;
}

function adjustedParagraph(paragraph: Paragraph, start: number, end: number): Paragraph {
  if (start === 0 && end >= paragraph.text.length) return paragraph;
  return {
    ...paragraph,
    text: paragraph.text.slice(start, end),
    inlineMarks: paragraph.inlineMarks
      ?.map((mark) => ({
        ...mark,
        start: Math.max(0, mark.start - start),
        end: Math.min(end - start, mark.end - start),
      }))
      .filter((mark) => mark.end > mark.start),
    inlineSemantics: paragraph.inlineSemantics
      ?.map((semantic) => ({
        ...semantic,
        start: Math.max(0, semantic.start - start),
        end: Math.min(end - start, semantic.end - start),
      }))
      .filter((semantic) => semantic.end > semantic.start),
  };
}

function boundaryContains(boundary: ReaderPageBoundary, paragraph: Paragraph): boolean {
  const index = paragraph.index - 1;
  const start = boundary.start.blockIndex ?? 0;
  const end = boundary.end.blockIndex ?? start;
  if (index < start || index > end) return false;
  return !(index === end && boundary.end.offset === 0 && end > start);
}

function boundaryContainsAnchor(boundary: ReaderPageBoundary, anchor: ReaderAnchor): boolean {
  const target = anchor.blockIndex ?? 0;
  const start = boundary.start.blockIndex ?? 0;
  const end = boundary.end.blockIndex ?? start;
  if (target < start || target > end) return false;
  if (target === start && anchor.offset < boundary.start.offset) return false;
  if (target === end && anchor.offset >= boundary.end.offset && end > start) return false;
  return true;
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
    onToggleChrome,
    onDocumentLink,
    assetRepository,
    onPaginationFailure,
  } = props;
  const rootRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const paragraphCacheRef = useRef(new Map<number, Paragraph>());
  const appliedOpenSequenceRef = useRef<number>();
  const visibleAnchorRef = useRef<ReaderAnchor>();
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [boundaries, setBoundaries] = useState<readonly ReaderPageBoundary[]>([]);
  const [complete, setComplete] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [pageParagraphs, setPageParagraphs] = useState<Paragraph[]>([]);
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
      if (cached) return cached;
      const page = await repository.getParagraphPage(chapter.id, Math.floor(index / PARAGRAPHS_PER_PAGE));
      for (const paragraph of page?.paragraphs ?? []) {
        const logicalIndex = paragraph.index - 1;
        paragraphCacheRef.current.set(logicalIndex, paragraph);
      }
      while (paragraphCacheRef.current.size > 256) {
        const oldest = paragraphCacheRef.current.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        paragraphCacheRef.current.delete(oldest);
      }
      return paragraphCacheRef.current.get(index);
    },
    [chapter.id, chapter.paragraphCount, repository],
  );

  useEffect(() => {
    paragraphCacheRef.current.clear();
    setBoundaries([]);
    setComplete(false);
    setCurrentPage(0);
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

  const applyBoundaries = useCallback(
    (next: readonly ReaderPageBoundary[], done: boolean, preservedAnchor = visibleAnchorRef.current) => {
      setBoundaries(next);
      setComplete(done);
      setCurrentPage((current) => {
        const anchored = preservedAnchor
          ? next.findIndex((boundary) => boundaryContainsAnchor(boundary, preservedAnchor))
          : -1;
        return anchored >= 0 ? anchored : clamp(current, 0, Math.max(0, next.length - 1));
      });
    },
    [],
  );

  useEffect(() => {
    if (dimensions.width < 100 || dimensions.height < 180 || !measureRef.current) return;
    const preservedAnchor = visibleAnchorRef.current;
    const cached = pageMapCache.get(`${chapter.id}:${layoutKey}`);
    if (cached) {
      applyBoundaries(cached.boundaries, true, preservedAnchor);
      return;
    }
    let cancelled = false;
    const run = async () => {
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

      while (paragraphIndex < chapter.paragraphCount && !cancelled) {
        const paragraph = await getParagraphAtIndex(paragraphIndex);
        if (!paragraph) throw new Error(`Paragraph ${paragraphIndex} is unavailable during pagination.`);
        if (!pageStart.paragraphId) pageStart = { paragraphIndex, offset, paragraphId: paragraph.id };
        const block = measurementBlock(paragraph, paragraph.text.slice(offset));
        measure.append(block);
        if (measure.scrollHeight <= measure.clientHeight + 1) {
          paragraphIndex += 1;
          offset = 0;
          continue;
        }
        block.remove();
        if (measure.childElementCount > 0) {
          publishBoundary(paragraph.id, paragraphIndex, offset);
          pageStart = { paragraphIndex, offset, paragraphId: paragraph.id };
        } else if (paragraph.documentKind === 'image' || paragraph.text.length === 0) {
          measure.append(block);
          publishBoundary(paragraph.id, paragraphIndex, paragraph.text.length);
          paragraphIndex += 1;
          offset = 0;
          pageStart = { paragraphIndex, offset: 0, paragraphId: '' };
        } else {
          let low = Math.min(offset + 1, paragraph.text.length);
          let high = paragraph.text.length;
          let fit = low;
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const candidate = measurementBlock(paragraph, paragraph.text.slice(offset, middle));
            measure.replaceChildren(candidate);
            if (measure.scrollHeight <= measure.clientHeight + 1) {
              fit = middle;
              low = middle + 1;
            } else {
              high = middle - 1;
            }
          }
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
      cachePageMap({ key: `${chapter.id}:${layoutKey}`, boundaries: result });
    };
    void run().catch(() => {
      if (!cancelled) {
        setComplete(false);
        screenHandle.getActions().notify('페이지 계산에 실패해 화면 넘김 방식으로 전환합니다.', 'warning');
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
    screenHandle,
  ]);

  useEffect(() => {
    const boundary = boundaries[currentPage];
    if (!boundary) return;
    let cancelled = false;
    const run = async () => {
      const paragraphs: Paragraph[] = [];
      const startIndex = boundary.start.blockIndex ?? 0;
      const endIndex = boundary.end.blockIndex ?? startIndex;
      for (let index = startIndex; index <= endIndex; index += 1) {
        if (index === endIndex && boundary.end.offset === 0 && endIndex > startIndex) break;
        const paragraph = await getParagraphAtIndex(index);
        if (!paragraph) continue;
        const start = index === startIndex ? boundary.start.offset : 0;
        const end = index === endIndex ? boundary.end.offset : paragraph.text.length;
        paragraphs.push(adjustedParagraph(paragraph, start, end));
      }
      if (!cancelled) setPageParagraphs(paragraphs);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [boundaries, currentPage, getParagraphAtIndex]);

  const currentBoundary = boundaries[currentPage];
  const currentParagraph = pageParagraphs[0];
  const location = useMemo(
    () =>
      currentBoundary
        ? {
            progress:
              chapter.paragraphCount > 1 ? (currentBoundary.start.blockIndex ?? 0) / (chapter.paragraphCount - 1) : 0,
            scrollTop: currentPage,
            paragraphIndex: currentParagraph?.index ?? (currentBoundary.start.blockIndex ?? 0) + 1,
            paragraph: currentParagraph,
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
      const index = boundaries.findIndex((boundary) => boundaryContainsAnchor(boundary, targetAnchor));
      if (index >= 0) {
        appliedOpenSequenceRef.current = openRequest.sequence;
        setCurrentPage(index);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [boundaries, chapter.id, contentRevisionId, novel.id, openRequest, repository]);

  const pageJump = useCallback(
    (direction: -1 | 1) => {
      setCurrentPage((current) => clamp(current + direction, 0, Math.max(0, boundaries.length - 1)));
      onRevealChrome();
    },
    [boundaries.length, onRevealChrome],
  );

  const gestureHandlers = useReaderGestureHandlers({
    bindings: settings.gestureBindings,
    viewportWidth: () => rootRef.current?.clientWidth ?? window.innerWidth,
    actions: {
      previousPage: () => pageJump(-1),
      nextPage: () => pageJump(1),
      toggleChrome: onToggleChrome,
      openToc: () => screenHandle.getActions().openAddon('outline'),
      openSettings: () => screenHandle.getActions().openSettings(),
      toggleTTS: () => screenHandle.getActions().toggleTTS(location?.ttsIndex ?? 0),
    },
  });

  const api = useMemo<ReaderViewportApi>(
    () => ({
      resetContent: () => setCurrentPage(0),
      flushPosition,
      scrollToParagraph: async (paragraphId) => {
        for (let index = 0; index < chapter.paragraphCount; index += 1) {
          const paragraph = await getParagraphAtIndex(index);
          if (paragraph?.id !== paragraphId) continue;
          const page = boundaries.findIndex((boundary) => boundaryContains(boundary, paragraph));
          if (page >= 0) setCurrentPage(page);
          return page >= 0;
        }
        return false;
      },
      scrollToParagraphIndex: async (index) => {
        const paragraph = await getParagraphAtIndex(index);
        if (!paragraph) return;
        const page = boundaries.findIndex((boundary) => boundaryContains(boundary, paragraph));
        if (page >= 0) setCurrentPage(page);
      },
      scrubTo: async (progress) => {
        if (boundaries.length)
          setCurrentPage(clamp(Math.round(progress * (boundaries.length - 1)), 0, boundaries.length - 1));
      },
      pageJump,
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
    [boundaries, chapter.paragraphCount, flushPosition, getParagraphAtIndex, location, pageJump],
  );

  useEffect(() => {
    apiRef.current = api;
    onApiReady(api);
    return () => {
      if (apiRef.current === api) apiRef.current = undefined;
      onApiReady(undefined);
    };
  }, [api, apiRef, onApiReady]);

  const goChapter = useCallback(
    async (direction: -1 | 1) => {
      const next = chapters.find((candidate) => candidate.index === chapter.index + direction);
      if (next) await screenHandle.getActions().openChapter(next);
    },
    [chapter.index, chapters, screenHandle],
  );

  return (
    <section
      className={`reader-scroll font-${settings.font} mode-${mode} reader-paginated-root`}
      ref={rootRef}
      tabIndex={0}
      onPointerDown={gestureHandlers.onPointerDown}
      onPointerUp={gestureHandlers.onPointerUp}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        ref={measureRef}
        className="reader-document reader-pagination-measure"
        style={{ width: Math.max(120, dimensions.width), height: Math.max(160, dimensions.height) }}
        aria-hidden="true"
      />
      <article
        ref={pageRef}
        className="reader-document reader-paginated-page"
        onMouseUp={() => onSelectionChanged(api.getSelection())}
      >
        {pageParagraphs.map((paragraph, index) => (
          <ReaderParagraphRow
            key={`${paragraph.id}:${index}:${paragraph.text.length}`}
            paragraph={paragraph}
            virtualIndex={paragraph.index - 1}
            start={0}
            staticLayout
            isSpeaking={ttsIndex === paragraph.index - 1}
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
      <footer className="reader-pagination-controls">
        <button
          type="button"
          className="mini-icon-btn"
          disabled={currentPage <= 0}
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
          disabled={currentPage >= boundaries.length - 1}
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
