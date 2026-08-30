import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  EyeOff,
  Expand,
  Focus,
  Highlighter,
  ListOrdered,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RotateCw,
  Search,
  Settings2,
  StickyNote,
  TextCursorInput,
  X,
} from 'lucide-react';
import { persistentId128 } from '@noveldesk/text-core/hash';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type {
  Chapter,
  BookAssetMetadata,
  ComicReadingProfile,
  DocumentAnnotation,
  DocumentTextBlock,
  DocumentTextRevision,
  ListeningPosition,
  Novel,
  ReadingPosition,
} from '../../domain/types';
import { bookFormatLabel } from '../../domain/book-format';
import {
  applyDocumentTextOrderOverride,
  createDocumentTextOrderOverride,
  documentTextBlockFingerprint,
} from '../../domain/document-text-order';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { IndexedDbDocumentAnnotationRepository } from '../../storage/document-annotation-store';
import type { DocumentTextSearchResult } from '../../repositories/document-text-repository';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { LocalTesseractOcrProvider } from '../../providers/local-tesseract-ocr-provider';
import { useScrollChapterBoundary } from '../reader/use-scroll-chapter-boundary';
import { IndexedDbDocumentTextRepository } from '../../storage/document-text-store';
import { IndexedDbComicReadingProfileRepository } from '../../storage/comic-reading-profile-store';
import {
  getDocumentThumbnail,
  pruneDocumentThumbnails,
  saveDocumentThumbnail,
} from '../../storage/document-thumbnail-store';
import { buildOcrDocumentText, rasterizePdfPageForOcr } from './ocr/pdf-ocr';
import {
  inspectOcrLanguageModelCache,
  OCR_LANGUAGE_MODELS,
  removeOcrLanguageModelCache,
  type OcrLanguageModel,
  type OcrLanguageModelCacheEntry,
} from './ocr/ocr-language-model-cache';
import {
  archiveFullImageWindow,
  archiveThumbnailFingerprint,
  archiveThumbnailPageHash,
  renderArchiveThumbnail,
} from './archive-thumbnail';
import { renderPdfGeneratedCover } from './pdf-generated-cover';
import { pdfThumbnailFingerprint, renderPdfThumbnail } from './pdf-thumbnail';
import { runDocumentThumbnailBatch, type DocumentThumbnailBatchProgress } from './document-thumbnail-batch';
import { needsPdfOcr, normalizeOcrPageRange } from './ocr/ocr-range-plan';
import { BookSourcePdfRangeTransport } from './pdf-range-transport';
import { extractPdfNativeText, pdfNativeTextRevisionId } from './text/pdf-native-text';
import { buildFixedTextSelection, type FixedTextSelectionRange } from './text/fixed-text-selection';
import { remapFixedTextAnnotation } from './text/fixed-text-annotation-remap';
import { manuallyReanchorFixedTextAnnotation } from './text/manual-fixed-text-reanchor';
import {
  buildComicSpreads,
  comicProfileModeToViewMode,
  comicSpreadForPage,
  comicSpreadPages,
  comicViewModeToProfileMode,
  DEFAULT_COMIC_READING_PROFILE,
  isContinuousComicViewMode,
  type ComicViewMode,
  type ComicPageLayoutHint,
} from './comic-layout';
import { comicCropRefitScale, detectComicContentBounds, runComicAutoCropBatch } from './comic-auto-crop';
import {
  captureViewportFocalAnchor,
  focalAnchorScrollDelta,
  type PageFocalRect,
  type ViewportFocalAnchor,
} from './viewport-focal-anchor';
import {
  continuousComicPageEstimatedHeight,
  continuousComicPageIndexes,
  continuousComicPageWidth,
  continuousComicSectionIndex,
  continuousPageNearestViewportCenter,
  representativeContinuousImageDimensions,
  shouldAnchorContinuousPageResize,
  type ContinuousImageDimensions,
} from './continuous-scroll';
import { projectFixedDocumentSections } from './fixed-document-sections';
import './fixed-document.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type FitMode = ComicReadingProfile['fit'];
type ViewMode = ComicViewMode;
type PdfTextPageState = 'ready' | 'ocr_candidate' | 'failed';

interface LoadedArchivePage {
  readonly index: number;
  readonly blob: Blob;
  readonly hint?: ComicPageLayoutHint;
}

const documentTextRepository = new IndexedDbDocumentTextRepository();
const documentAnnotationRepository = new IndexedDbDocumentAnnotationRepository();
const comicReadingProfileRepository = new IndexedDbComicReadingProfileRepository();
const CONTINUOUS_SECTION_NAV_HEIGHT = 112;
const CONTINUOUS_SECTION_BOUNDARY_HEIGHT = 196;

const OCR_LANGUAGE_LABELS: Record<OcrLanguageModel, string> = {
  kor: '한국어',
  jpn: '일본어',
  eng: '영어',
};

function formatStoredBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function mobileComicSectionLabel(title: string): string {
  const normalized = title.trim();
  return /^\d+(?:\.\d+)?$/.test(normalized) ? `${normalized}화` : normalized;
}

interface PdfTextSelection {
  readonly pageIndex: number;
  readonly textRevisionId: string;
  readonly ranges: readonly FixedTextSelectionRange[];
  readonly quote: string;
  readonly quads: readonly DocumentTextBlock['quads'][number][];
}

interface PdfRegionSelection {
  readonly pageIndex: number;
  readonly quad: { x: number; y: number; width: number; height: number };
}

export interface FixedDocumentScreenProps {
  readonly novel: Novel;
  readonly chapters: readonly Chapter[];
  readonly readingPosition?: ReadingPosition;
  readonly initialChapterId?: string;
  readonly repository: ReaderRepository;
  readonly assets: BookAssetRepository;
  readonly onBack: () => void;
  readonly onPageSettled: (pageIndex: number) => void | Promise<void>;
  readonly onGeneratedCover?: (cover: BookAssetMetadata) => void;
  readonly onStartListening?: (pageIndex: number, blockId?: string, startOffset?: number) => void | Promise<void>;
  readonly onPrepareListening?: (startPageIndex: number, endPageIndex: number) => void | Promise<void>;
  readonly onCancelListeningPreparation?: () => void;
  readonly listeningPreparationBusy?: boolean;
  readonly listeningPosition?: ListeningPosition;
  readonly annotationSyncRevision?: string;
}

function initialPage(chapters: readonly Chapter[], position?: ReadingPosition, initialChapterId?: string): number {
  const index = chapters.findIndex((chapter) => chapter.id === (initialChapterId ?? position?.chapterId));
  return Math.max(0, index);
}

function clampPage(page: number, total: number): number {
  return Math.max(0, Math.min(Math.max(0, total - 1), Math.floor(page)));
}

function comicPageTypeLabel(type?: string): string | undefined {
  switch (type?.trim().toLocaleLowerCase()) {
    case 'frontcover':
      return '표지';
    case 'backcover':
      return '뒤표지';
    case 'story':
      return '본문';
    case 'advertisement':
      return '광고';
    case 'deleted':
      return '삭제 표기';
    default:
      return type?.trim() || undefined;
  }
}

function pdfPageHash(novel: Novel, pageIndex: number): string {
  return `${novel.rawTextHash}:pdf-page:${pageIndex}`;
}

function pendingOcrRevision(novel: Novel, pageIndex: number, language: string): DocumentTextRevision {
  const timestamp = new Date().toISOString();
  const pageHash = pdfPageHash(novel, pageIndex);
  return {
    id: persistentId128('document_text_revision', [
      novel.id,
      pageHash,
      'ocr',
      'local-tesseract-v7',
      language,
      'pending',
    ]),
    bookId: novel.id,
    pageIndex,
    pageHash,
    source: 'ocr',
    engine: 'local-tesseract-v7',
    engineVersion: 'pending',
    language,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function detectComicCrop(image: Blob) {
  const bitmap = await createImageBitmap(image);
  try {
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('이미지 분석 화면을 만들 수 없습니다.');
    context.drawImage(bitmap, 0, 0, width, height);
    return detectComicContentBounds(context.getImageData(0, 0, width, height).data, width, height);
  } finally {
    bitmap.close();
  }
}

function rotateTextQuad(quad: DocumentTextBlock['quads'][number], rotation: number) {
  if (rotation === 90) {
    return { x: 1 - quad.y - quad.height, y: quad.x, width: quad.height, height: quad.width };
  }
  if (rotation === 180) {
    return { x: 1 - quad.x - quad.width, y: 1 - quad.y - quad.height, width: quad.width, height: quad.height };
  }
  if (rotation === 270) {
    return { x: quad.y, y: 1 - quad.x - quad.width, width: quad.height, height: quad.width };
  }
  return quad;
}

function unrotateTextQuad(quad: DocumentTextBlock['quads'][number], rotation: number) {
  return rotateTextQuad(quad, (360 - rotation) % 360);
}

function PdfThumbnailPreview({
  page,
  bookId,
  pageIndex,
  pageHash,
}: {
  readonly page: PDFPageProxy;
  readonly bookId: string;
  readonly pageIndex: number;
  readonly pageHash: string;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const renderFingerprint = pdfThumbnailFingerprint();
      const cached = await getDocumentThumbnail({ bookId, pageIndex, pageHash, renderFingerprint });
      let blob = cached?.blob;
      if (!blob) {
        const rendered = await renderPdfThumbnail(page, controller.signal);
        blob = rendered.blob;
        await saveDocumentThumbnail({
          bookId,
          pageIndex,
          pageHash,
          renderFingerprint: rendered.renderFingerprint,
          contentType: rendered.contentType,
          pixelWidth: rendered.pixelWidth,
          pixelHeight: rendered.pixelHeight,
          blob,
        }).catch(() => undefined);
        void pruneDocumentThumbnails(bookId).catch(() => undefined);
      }
      controller.signal.throwIfAborted();
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    })().catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bookId, page, pageHash, pageIndex]);
  return url ? <img src={url} alt="" draggable={false} /> : <span>{pageIndex + 1}</span>;
}

function ArchiveThumbnailPreview({
  bookId,
  sourceHash,
  chapterId,
  pageIndex,
  repository,
  assets,
  onPageHint,
}: {
  readonly bookId: string;
  readonly sourceHash: string;
  readonly chapterId: string;
  readonly pageIndex: number;
  readonly repository: ReaderRepository;
  readonly assets: BookAssetRepository;
  readonly onPageHint: (pageIndex: number, hint: ComicPageLayoutHint) => void;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const paragraphPage = await repository.getParagraphPage(chapterId, 0);
      const paragraph = paragraphPage?.paragraphs[0];
      if (paragraph?.documentPageType !== undefined || paragraph?.documentPageDouble !== undefined) {
        onPageHint(pageIndex, {
          type: paragraph.documentPageType,
          doublePage: paragraph.documentPageDouble,
        });
      }
      const assetId = paragraph?.assetId;
      if (!assetId) throw new Error('이미지 페이지 정보를 찾을 수 없습니다.');
      const pageHash = archiveThumbnailPageHash(sourceHash, assetId, pageIndex);
      const renderFingerprint = archiveThumbnailFingerprint();
      const cached = await getDocumentThumbnail({ bookId, pageIndex, pageHash, renderFingerprint });
      let blob = cached?.blob;
      if (!blob) {
        const resource = await assets.getEmbeddedResource(bookId, assetId);
        if (!resource) throw new Error('이미지 페이지를 찾을 수 없습니다.');
        const rendered = await renderArchiveThumbnail(resource.blob, controller.signal);
        blob = rendered.blob;
        await saveDocumentThumbnail({
          bookId,
          pageIndex,
          pageHash,
          renderFingerprint: rendered.renderFingerprint,
          contentType: rendered.contentType,
          pixelWidth: rendered.pixelWidth,
          pixelHeight: rendered.pixelHeight,
          blob,
        }).catch(() => undefined);
        void pruneDocumentThumbnails(bookId).catch(() => undefined);
      }
      controller.signal.throwIfAborted();
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    })().catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assets, bookId, chapterId, onPageHint, pageIndex, repository, sourceHash]);
  return url ? <img src={url} alt="" draggable={false} /> : <span>{pageIndex + 1}</span>;
}

function PdfCanvas({
  page,
  fit,
  zoom,
  rotation,
  availableWidth,
  availableHeight,
  textBlocks = [],
  selectionEnabled = false,
  searchQuery = '',
  pageIndex,
  annotations = [],
  onTextSelection,
  regionSelectionEnabled = false,
  onRegionSelection,
  activeRange,
}: {
  page?: PDFPageProxy;
  fit: FitMode;
  zoom: number;
  rotation: number;
  availableWidth: number;
  availableHeight: number;
  textBlocks?: readonly DocumentTextBlock[];
  selectionEnabled?: boolean;
  searchQuery?: string;
  pageIndex: number;
  annotations?: readonly DocumentAnnotation[];
  onTextSelection?: (selection: PdfTextSelection) => void;
  regionSelectionEnabled?: boolean;
  onRegionSelection?: (selection: PdfRegionSelection) => void;
  activeRange?: { readonly blockId: string; readonly startOffset: number; readonly endOffset: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const [regionDrag, setRegionDrag] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  }>();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!page || !canvas) return;
    const base = page.getViewport({ scale: 1, rotation });
    const widthScale = Math.max(0.1, availableWidth / base.width);
    const heightScale = Math.max(0.1, availableHeight / base.height);
    const fitScale =
      fit === 'width'
        ? widthScale
        : fit === 'height'
          ? heightScale
          : fit === 'original'
            ? 1
            : Math.min(widthScale, heightScale);
    const scale = fitScale * zoom;
    const viewport = page.getViewport({ scale, rotation });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2.5);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    setCanvasSize({ width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    void task.promise.catch((error) => {
      if (!(error instanceof Error) || error.name !== 'RenderingCancelledException') throw error;
    });
    return () => task.cancel();
  }, [availableHeight, availableWidth, fit, page, rotation, zoom]);
  const needle = searchQuery.normalize('NFKC').toLocaleLowerCase().trim();
  const selectionFinished = () => {
    if (!selectionEnabled || !onTextSelection) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const startSpan =
      range.startContainer.parentElement?.closest<HTMLElement>('[data-document-block-id]') ??
      (range.startContainer instanceof HTMLElement
        ? range.startContainer.closest<HTMLElement>('[data-document-block-id]')
        : null);
    const endSpan =
      range.endContainer.parentElement?.closest<HTMLElement>('[data-document-block-id]') ??
      (range.endContainer instanceof HTMLElement
        ? range.endContainer.closest<HTMLElement>('[data-document-block-id]')
        : null);
    if (!startSpan || !endSpan) return;
    const offsetWithin = (span: HTMLElement, container: Node, offset: number) => {
      const prefix = document.createRange();
      prefix.selectNodeContents(span);
      prefix.setEnd(container, offset);
      return prefix.toString().length;
    };
    const built = buildFixedTextSelection({
      blocks: textBlocks,
      startBlockId: startSpan.dataset.documentBlockId ?? '',
      startOffset: offsetWithin(startSpan, range.startContainer, range.startOffset),
      endBlockId: endSpan.dataset.documentBlockId ?? '',
      endOffset: offsetWithin(endSpan, range.endContainer, range.endOffset),
    });
    const first = built?.ranges[0];
    if (!built || !first) return;
    onTextSelection({
      pageIndex,
      textRevisionId: first.block.revisionId,
      ranges: built.ranges,
      quote: built.quote,
      quads: built.quads,
    });
  };
  const regionPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height))),
    };
  };
  const startRegionSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!regionSelectionEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = regionPoint(event);
    setRegionDrag({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
  };
  const moveRegionSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!regionDrag || !regionSelectionEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    const point = regionPoint(event);
    setRegionDrag((current) => current && { ...current, currentX: point.x, currentY: point.y });
  };
  const finishRegionSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!regionDrag || !regionSelectionEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    const point = regionPoint(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const displayed = {
      x: Math.min(regionDrag.startX, point.x),
      y: Math.min(regionDrag.startY, point.y),
      width: Math.abs(point.x - regionDrag.startX),
      height: Math.abs(point.y - regionDrag.startY),
    };
    setRegionDrag(undefined);
    if (displayed.width < 0.01 || displayed.height < 0.01) return;
    onRegionSelection?.({ pageIndex, quad: unrotateTextQuad(displayed, rotation) });
  };
  return (
    <div className="fixed-doc-pdf-page" style={canvasSize}>
      <canvas ref={canvasRef} className="fixed-doc-canvas" />
      {textBlocks.length > 0 && (
        <div
          className={`fixed-doc-text-layer${selectionEnabled ? ' is-selectable' : ''}`}
          aria-label="PDF 텍스트 계층"
          onPointerUp={selectionFinished}
        >
          {textBlocks.map((block) => {
            const quads = block.quads.map((quad) => rotateTextQuad(quad, rotation));
            const x = Math.min(...quads.map((quad) => quad.x));
            const y = Math.min(...quads.map((quad) => quad.y));
            const right = Math.max(...quads.map((quad) => quad.x + quad.width));
            const bottom = Math.max(...quads.map((quad) => quad.y + quad.height));
            const matched = Boolean(needle && block.normalizedText.includes(needle));
            const active = block.id === activeRange?.blockId;
            const activeStartRatio = active
              ? Math.max(0, Math.min(1, activeRange.startOffset / Math.max(1, block.text.length)))
              : 0;
            const activeEndRatio = active
              ? Math.max(activeStartRatio, Math.min(1, activeRange.endOffset / Math.max(1, block.text.length)))
              : 1;
            const activeFrom = block.direction === 'rtl' ? 1 - activeEndRatio : activeStartRatio;
            const activeTo = block.direction === 'rtl' ? 1 - activeStartRatio : activeEndRatio;
            return (
              <span
                key={block.id}
                data-document-block-id={block.id}
                className={`${matched ? 'is-search-hit' : ''}${active ? ' is-tts-active' : ''}`}
                dir={block.direction === 'rtl' ? 'rtl' : 'ltr'}
                style={{
                  left: `${x * 100}%`,
                  top: `${y * 100}%`,
                  width: `${Math.max(0.2, (right - x) * 100)}%`,
                  height: `${Math.max(0.2, (bottom - y) * 100)}%`,
                  fontSize: `${Math.max(4, (bottom - y) * canvasSize.height * 0.85)}px`,
                  background: active
                    ? `linear-gradient(to right, transparent ${activeFrom * 100}%, rgba(177, 69, 49, 0.28) ${activeFrom * 100}%, rgba(177, 69, 49, 0.28) ${activeTo * 100}%, transparent ${activeTo * 100}%)`
                    : undefined,
                  boxShadow: active ? 'none' : undefined,
                }}
              >
                {block.text}
              </span>
            );
          })}
        </div>
      )}
      {annotations.length > 0 && (
        <div className="fixed-doc-annotation-layer" aria-hidden="true">
          {annotations.flatMap((annotation) =>
            ('quads' in annotation.anchor ? (annotation.anchor.quads ?? []) : []).map((quad, index) => {
              const rotated = rotateTextQuad(quad, rotation);
              return (
                <i
                  key={`${annotation.id}:${index}`}
                  className={`is-${annotation.type}${annotation.textAnchorRemap?.status === 'needs_review' ? ' is-remap-review' : ''}`}
                  style={{
                    left: `${rotated.x * 100}%`,
                    top: `${rotated.y * 100}%`,
                    width: `${rotated.width * 100}%`,
                    height: `${rotated.height * 100}%`,
                  }}
                />
              );
            }),
          )}
        </div>
      )}
      {regionSelectionEnabled && (
        <div
          className="fixed-doc-region-select-layer"
          aria-label="PDF 영역 선택"
          onPointerDown={startRegionSelection}
          onPointerMove={moveRegionSelection}
          onPointerUp={finishRegionSelection}
          onPointerCancel={() => setRegionDrag(undefined)}
        >
          {regionDrag && (
            <i
              style={{
                left: `${Math.min(regionDrag.startX, regionDrag.currentX) * 100}%`,
                top: `${Math.min(regionDrag.startY, regionDrag.currentY) * 100}%`,
                width: `${Math.abs(regionDrag.currentX - regionDrag.startX) * 100}%`,
                height: `${Math.abs(regionDrag.currentY - regionDrag.startY) * 100}%`,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default function FixedDocumentScreen({
  novel,
  chapters,
  readingPosition,
  initialChapterId,
  repository,
  assets,
  onBack,
  onPageSettled,
  onGeneratedCover,
  onStartListening,
  onPrepareListening,
  onCancelListeningPreparation,
  listeningPreparationBusy = false,
  listeningPosition,
  annotationSyncRevision,
}: FixedDocumentScreenProps) {
  const sortedChapters = useMemo(() => [...chapters].sort((left, right) => left.index - right.index), [chapters]);
  const documentSections = useMemo(
    () => projectFixedDocumentSections(novel.id, sortedChapters),
    [novel.id, sortedChapters],
  );
  const totalPages = sortedChapters.length;
  const [pageIndex, setPageIndex] = useState(() => initialPage(sortedChapters, readingPosition, initialChapterId));
  const [pageDraft, setPageDraft] = useState(String(pageIndex + 1));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileThumbnailOpen, setMobileThumbnailOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fit, setFit] = useState<FitMode>('page');
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [pdfPages, setPdfPages] = useState<Map<number, PDFPageProxy>>(() => new Map());
  const [imageUrls, setImageUrls] = useState<Map<number, string>>(() => new Map());
  const imageUrlsRef = useRef<Map<number, string>>(new Map());
  const [imageDimensions, setImageDimensions] = useState<Map<number, ContinuousImageDimensions>>(() => new Map());
  const archiveImageLoadsRef = useRef(new Map<string, Promise<LoadedArchivePage>>());
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const viewportRef = useRef<HTMLElement>(null);
  const continuousContentRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1000, height: 800 });
  const viewportSizeRef = useRef(viewportSize);
  const viewportScrollFrameRef = useRef<number>();
  const pendingContinuousPageRef = useRef<number>();
  const [focalRestoreRevision, setFocalRestoreRevision] = useState(0);
  const pointerStartRef = useRef<{ x: number; y: number; at: number; immersiveEligible: boolean }>();
  const suppressViewportClickRef = useRef(false);
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    distance: number;
    zoom: number;
    active: boolean;
    anchor?: ViewportFocalAnchor;
  }>();
  const pendingFocalAnchorRef = useRef<ViewportFocalAnchor>();
  const textExtractionInFlightRef = useRef(new Map<number, Promise<void>>());
  const textIndexControllerRef = useRef<AbortController>();
  const ocrControllerRef = useRef<AbortController>();
  const ocrProviderRef = useRef<LocalTesseractOcrProvider>();
  const comicCropControllerRef = useRef<AbortController>();
  const generatedCoverAttemptRef = useRef<string>();
  const thumbnailBatchControllerRef = useRef<AbortController>();
  const [textBlocksByPage, setTextBlocksByPage] = useState<Map<number, DocumentTextBlock[]>>(() => new Map());
  const [textPageStates, setTextPageStates] = useState<Map<number, PdfTextPageState>>(() => new Map());
  const [readyTextPages, setReadyTextPages] = useState(0);
  const [selectionMode, setSelectionMode] = useState(false);
  const [regionMode, setRegionMode] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [listeningPreparationOpen, setListeningPreparationOpen] = useState(false);
  const [listeningRangeStart, setListeningRangeStart] = useState(pageIndex + 1);
  const [listeningRangeEnd, setListeningRangeEnd] = useState(Math.min(totalPages, pageIndex + 10));
  const [comicSettingsOpen, setComicSettingsOpen] = useState(false);
  const [comicProfile, setComicProfile] = useState<ComicReadingProfile>(DEFAULT_COMIC_READING_PROFILE);
  const [comicPageHints, setComicPageHints] = useState<Map<number, ComicPageLayoutHint>>(() => new Map());
  const [comicCropStatus, setComicCropStatus] = useState<'idle' | 'running' | 'failed'>('idle');
  const [comicCropProgress, setComicCropProgress] = useState<{ current: number; total: number; detected: number }>();
  const [comicCropFailedPages, setComicCropFailedPages] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DocumentTextSearchResult[]>([]);
  const [searchCursor, setSearchCursor] = useState(0);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [readingOrderOpen, setReadingOrderOpen] = useState(false);
  const [readingOrderRevision, setReadingOrderRevision] = useState<DocumentTextRevision>();
  const [readingOrderBlocks, setReadingOrderBlocks] = useState<DocumentTextBlock[]>([]);
  const [readingOrderExcludedIds, setReadingOrderExcludedIds] = useState<Set<string>>(() => new Set());
  const [readingOrderStatus, setReadingOrderStatus] = useState<'idle' | 'loading' | 'saving' | 'failed'>('idle');
  const [readingOrderError, setReadingOrderError] = useState('');
  const [readingOrderVersion, setReadingOrderVersion] = useState(0);
  const [textIndexProgress, setTextIndexProgress] = useState<{ current: number; total: number }>();
  const [thumbnailBatchProgress, setThumbnailBatchProgress] = useState<DocumentThumbnailBatchProgress>();
  const [thumbnailBatchSummary, setThumbnailBatchSummary] = useState<{
    readonly rendered: number;
    readonly failed: number;
    readonly cancelled: boolean;
  }>();
  const [ocrLanguage, setOcrLanguage] = useState('kor+eng');
  const [ocrRangeStart, setOcrRangeStart] = useState(pageIndex + 1);
  const [ocrRangeEnd, setOcrRangeEnd] = useState(Math.min(totalPages, pageIndex + 10));
  const [ocrWorkerLanguage, setOcrWorkerLanguage] = useState<string>();
  const [ocrProgress, setOcrProgress] = useState<{
    pageIndex: number;
    progress: number;
    status: string;
    current: number;
    total: number;
  }>();
  const [ocrError, setOcrError] = useState('');
  const [ocrModelCache, setOcrModelCache] = useState<OcrLanguageModelCacheEntry[]>([]);
  const [ocrModelCacheStatus, setOcrModelCacheStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [ocrModelCacheError, setOcrModelCacheError] = useState('');
  const [documentAnnotations, setDocumentAnnotations] = useState<DocumentAnnotation[]>([]);
  const [pendingTextSelection, setPendingTextSelection] = useState<PdfTextSelection>();
  const [reanchorTargetId, setReanchorTargetId] = useState<string>();
  const [selectionNoteDraft, setSelectionNoteDraft] = useState('');
  const [pendingRegionSelection, setPendingRegionSelection] = useState<PdfRegionSelection>();
  const [regionNoteDraft, setRegionNoteDraft] = useState('');

  const refreshOcrModelCache = useCallback(async () => {
    setOcrModelCacheStatus('loading');
    setOcrModelCacheError('');
    try {
      setOcrModelCache(await inspectOcrLanguageModelCache());
      setOcrModelCacheStatus('ready');
    } catch (error) {
      setOcrModelCacheStatus('failed');
      setOcrModelCacheError(error instanceof Error ? error.message : 'OCR 언어 데이터 상태를 확인하지 못했습니다.');
    }
  }, []);

  const requestedViewMode =
    novel.format !== 'image_archive' && viewMode === 'continuous-seamless' ? 'continuous' : viewMode;
  const effectiveViewMode: ViewMode =
    requestedViewMode === 'spread' && viewportSize.width < 720 ? 'single' : requestedViewMode;
  const continuousView = isContinuousComicViewMode(effectiveViewMode);
  const seamlessContinuousView = effectiveViewMode === 'continuous-seamless';

  const captureFocalAnchor = useCallback(
    (clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return undefined;
      const viewportRect = viewport.getBoundingClientRect();
      const pages = [...viewport.querySelectorAll<HTMLElement>('[data-page-index]')].map<PageFocalRect>((element) => {
        const rect = element.getBoundingClientRect();
        return {
          pageIndex: Number(element.dataset.pageIndex),
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      });
      return captureViewportFocalAnchor({
        viewport: viewportRect,
        pages,
        preferredPageIndex: pageIndex,
        clientX,
        clientY,
      });
    },
    [pageIndex],
  );

  const preserveFocalPoint = useCallback(
    (change: () => void, clientX?: number, clientY?: number) => {
      pendingFocalAnchorRef.current = captureFocalAnchor(clientX, clientY);
      setFocalRestoreRevision((revision) => revision + 1);
      change();
    },
    [captureFocalAnchor],
  );

  const closeTransientChrome = useCallback(() => {
    setMobileMenuOpen(false);
    setMobileThumbnailOpen(false);
    setSearchOpen(false);
    setAnnotationOpen(false);
    setComicSettingsOpen(false);
    setListeningPreparationOpen(false);
    setReadingOrderOpen(false);
    setSelectionMode(false);
    setRegionMode(false);
    setPendingTextSelection(undefined);
    setPendingRegionSelection(undefined);
    setReanchorTargetId(undefined);
    window.getSelection()?.removeAllRanges();
  }, []);

  const toggleImmersive = useCallback(() => {
    if (!immersive) closeTransientChrome();
    setImmersive((current) => !current);
  }, [closeTransientChrome, immersive]);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (!document.fullscreenEnabled || !document.documentElement.requestFullscreen) return;
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', syncFullscreen);
    syncFullscreen();
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  useLayoutEffect(() => {
    const anchor = pendingFocalAnchorRef.current;
    if (!anchor) return;
    let settleFrame = 0;
    const layoutFrame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(() => {
        if (pendingFocalAnchorRef.current !== anchor) return;
        const viewport = viewportRef.current;
        const page = viewport?.querySelector<HTMLElement>(`[data-page-index="${anchor.pageIndex}"]`);
        if (!viewport || !page) {
          pendingFocalAnchorRef.current = undefined;
          return;
        }
        const delta = focalAnchorScrollDelta(anchor, viewport.getBoundingClientRect(), page.getBoundingClientRect());
        viewport.scrollBy({ left: delta.left, top: delta.top });
        pendingFocalAnchorRef.current = undefined;
      });
    });
    return () => {
      window.cancelAnimationFrame(layoutFrame);
      if (settleFrame) window.cancelAnimationFrame(settleFrame);
    };
  }, [
    effectiveViewMode,
    fit,
    focalRestoreRevision,
    rotation,
    sidebarOpen,
    viewportSize.height,
    viewportSize.width,
    zoom,
  ]);
  const comicSpreads = useMemo(
    () => buildComicSpreads(totalPages, comicProfile, comicPageHints),
    [comicPageHints, comicProfile, totalPages],
  );
  const archiveEstimateDimensions = useMemo(
    () => representativeContinuousImageDimensions(imageDimensions.values()),
    [imageDimensions],
  );
  const currentDocumentSectionIndex = useMemo(
    () => continuousComicSectionIndex(documentSections, pageIndex),
    [documentSections, pageIndex],
  );
  const currentDocumentSection = documentSections[currentDocumentSectionIndex];
  const previousDocumentSection = documentSections[currentDocumentSectionIndex - 1];
  const nextDocumentSection = documentSections[currentDocumentSectionIndex + 1];
  const continuousPageIndexes = useMemo(
    () =>
      continuousComicPageIndexes(
        totalPages,
        currentDocumentSection ? [currentDocumentSection] : [],
        currentDocumentSection?.startPageIndex ?? 0,
      ),
    [currentDocumentSection, totalPages],
  );
  const continuousVirtualIndexByPage = useMemo(
    () => new Map(continuousPageIndexes.map((globalPageIndex, virtualIndex) => [globalPageIndex, virtualIndex])),
    [continuousPageIndexes],
  );
  const continuousSectionKey = currentDocumentSection?.id ?? `${novel.id}:all-pages`;
  const estimateContinuousPageSize = useCallback(
    (index: number) =>
      continuousComicPageEstimatedHeight({
        fit,
        viewportWidth: viewportSize.width,
        viewportHeight: viewportSize.height,
        zoom,
        seamless: seamlessContinuousView,
        dimensions: imageDimensions.get(index) ?? archiveEstimateDimensions,
      }),
    [
      archiveEstimateDimensions,
      fit,
      imageDimensions,
      seamlessContinuousView,
      viewportSize.height,
      viewportSize.width,
      zoom,
    ],
  );
  const seamlessContinuousPageWidth = useCallback(
    (index: number) =>
      continuousComicPageWidth({
        fit,
        viewportWidth: viewportSize.width,
        viewportHeight: viewportSize.height,
        zoom,
        seamless: true,
        dimensions: imageDimensions.get(index) ?? archiveEstimateDimensions,
      }),
    [archiveEstimateDimensions, fit, imageDimensions, viewportSize.height, viewportSize.width, zoom],
  );
  const continuousVirtualizer = useVirtualizer({
    count: continuousView ? continuousPageIndexes.length : 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: (virtualIndex) => estimateContinuousPageSize(continuousPageIndexes[virtualIndex] ?? pageIndex),
    gap: seamlessContinuousView ? -1 : 32,
    overscan: 2,
  });
  continuousVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    shouldAnchorContinuousPageResize(item.end, instance.scrollOffset ?? 0, Boolean(pendingFocalAnchorRef.current));
  const sidebarVirtualizer = useVirtualizer({
    count: sidebarOpen ? totalPages : 0,
    getScrollElement: () => sidebarRef.current,
    estimateSize: () => 180,
    overscan: 4,
  });
  const continuousItems = continuousVirtualizer.getVirtualItems();
  const sidebarItems = sidebarVirtualizer.getVirtualItems();
  const continuousDisplayedPages = continuousItems
    .map((item) => continuousPageIndexes[item.index])
    .filter((index) => index !== undefined);
  const displayedPages = continuousView
    ? continuousDisplayedPages.length
      ? continuousDisplayedPages
      : [pageIndex]
    : effectiveViewMode === 'spread' && novel.format === 'image_archive'
      ? comicSpreadPages(comicSpreads[comicSpreadForPage(comicSpreads, pageIndex)] ?? { readingOrder: [pageIndex] })
      : [pageIndex];
  const displayedPageKey = [...displayedPages].sort((left, right) => left - right).join(',');
  const wantedPageKey = [...new Set([...displayedPages, ...sidebarItems.map((item) => item.index)])]
    .sort((left, right) => left - right)
    .join(',');
  const wantedPageIndexes = useMemo(
    () => new Set(wantedPageKey.split(',').filter(Boolean).map(Number)),
    [wantedPageKey],
  );
  const imageWantedPageIndexes = useMemo(() => {
    const displayed = displayedPageKey.split(',').filter(Boolean).map(Number);
    const wanted = archiveFullImageWindow(displayed, pageIndex, totalPages);
    if (!continuousView || !currentDocumentSection) return new Set(wanted);
    const sectionEnd = currentDocumentSection.startPageIndex + currentDocumentSection.pageCount;
    return new Set(wanted.filter((index) => index >= currentDocumentSection.startPageIndex && index < sectionEnd));
  }, [continuousView, currentDocumentSection, displayedPageKey, pageIndex, totalPages]);

  const goToPage = useCallback(
    (next: number) => {
      const normalized = clampPage(next, totalPages);
      setPageIndex(normalized);
      setPageDraft(String(normalized + 1));
      if (!continuousView) return;
      const virtualIndex = continuousVirtualIndexByPage.get(normalized);
      if (virtualIndex === undefined) pendingContinuousPageRef.current = normalized;
      else continuousVirtualizer.scrollToIndex(virtualIndex, { align: seamlessContinuousView ? 'start' : 'center' });
    },
    [continuousView, continuousVirtualIndexByPage, continuousVirtualizer, seamlessContinuousView, totalPages],
  );

  const explicitEntryTarget = initialChapterId
    ? `${novel.id}:${novel.activeContentRevisionId ?? ''}:${initialChapterId}`
    : undefined;
  const appliedEntryTargetRef = useRef<string>();
  useEffect(() => {
    if (!explicitEntryTarget) {
      appliedEntryTargetRef.current = undefined;
      return;
    }
    if (appliedEntryTargetRef.current === explicitEntryTarget) return;
    const targetPage = sortedChapters.findIndex((chapter) => chapter.id === initialChapterId);
    if (targetPage < 0) return;
    appliedEntryTargetRef.current = explicitEntryTarget;
    goToPage(targetPage);
  }, [explicitEntryTarget, goToPage, initialChapterId, sortedChapters]);

  const turnPage = useCallback(
    (step: -1 | 1) => {
      if (effectiveViewMode === 'spread' && novel.format === 'image_archive') {
        const currentSpread = comicSpreadForPage(comicSpreads, pageIndex);
        const target = comicSpreads[Math.max(0, Math.min(comicSpreads.length - 1, currentSpread + step))];
        if (target) goToPage(target.readingOrder[0]);
        return;
      }
      goToPage(pageIndex + step);
    },
    [comicSpreads, effectiveViewMode, goToPage, novel.format, pageIndex],
  );

  const updateComicProfile = useCallback(
    (change: Partial<ComicReadingProfile>) => {
      setComicProfile((current) => {
        const next = { ...current, ...change };
        void comicReadingProfileRepository.save(novel.id, next);
        return next;
      });
    },
    [novel.id],
  );

  const recordComicPageHint = useCallback((index: number, hint: ComicPageLayoutHint) => {
    setComicPageHints((previous) => {
      const current = previous.get(index);
      if (current?.type === hint.type && current?.doublePage === hint.doublePage) return previous;
      return new Map(previous).set(index, hint);
    });
  }, []);

  const recordArchiveImageDimensions = useCallback((index: number, image: HTMLImageElement) => {
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    setImageDimensions((previous) => {
      const current = previous.get(index);
      if (current?.width === image.naturalWidth && current?.height === image.naturalHeight) return previous;
      return new Map(previous).set(index, { width: image.naturalWidth, height: image.naturalHeight });
    });
  }, []);

  const loadComicPageBlob = useCallback(
    async (index: number) => {
      const chapter = sortedChapters[index];
      const paragraphPage = chapter ? await repository.getParagraphPage(chapter.id, 0) : undefined;
      const assetId = paragraphPage?.paragraphs[0]?.assetId;
      const resource = assetId ? await assets.getEmbeddedResource(novel.id, assetId) : undefined;
      if (!resource) throw new Error(`${index + 1}페이지 이미지를 찾을 수 없습니다.`);
      return resource.blob;
    },
    [assets, novel.id, repository, sortedChapters],
  );

  const autoCropPages = useCallback(
    async (indexes: readonly number[]) => {
      if (indexes.length === 0 || comicCropControllerRef.current || comicCropStatus === 'running') return;
      const controller = new AbortController();
      comicCropControllerRef.current = controller;
      setComicCropStatus('running');
      setComicCropFailedPages(0);
      setComicCropProgress({ current: 0, total: indexes.length, detected: 0 });
      try {
        const result = await runComicAutoCropBatch({
          pageIndexes: indexes,
          existing: comicProfile.pageCrops,
          signal: controller.signal,
          analyze: async (index, signal) => {
            const blob = await loadComicPageBlob(index);
            if (signal.aborted) throw new DOMException('Comic crop cancelled.', 'AbortError');
            return detectComicCrop(blob);
          },
          onProgress: (current, total, detected) => setComicCropProgress({ current, total, detected }),
        });
        if (result.detected > 0) updateComicProfile({ crop: 'auto', pageCrops: result.pageCrops });
        setComicCropFailedPages(result.failedPages.length);
        setComicCropStatus(result.failedPages.length > 0 ? 'failed' : 'idle');
      } catch {
        setComicCropStatus('failed');
      } finally {
        if (comicCropControllerRef.current === controller) {
          comicCropControllerRef.current = undefined;
          setComicCropProgress(undefined);
        }
      }
    },
    [comicCropStatus, comicProfile.pageCrops, loadComicPageBlob, updateComicProfile],
  );

  const remapTextAnnotations = useCallback(
    async (revision: DocumentTextRevision, blocks: readonly DocumentTextBlock[]) => {
      const annotations = await documentAnnotationRepository.listPage(novel.id, revision.pageIndex);
      const remapped = annotations.map((annotation) =>
        remapFixedTextAnnotation({ annotation, targetRevision: revision, targetBlocks: blocks }),
      );
      const changed = remapped.filter((result) => result.changed);
      if (changed.length === 0) return;
      await Promise.all(changed.map((result) => documentAnnotationRepository.save(result.annotation)));
      setDocumentAnnotations(await documentAnnotationRepository.list(novel.id));
    },
    [novel.id],
  );

  const ensurePdfNativeText = useCallback(
    async (index: number, page: PDFPageProxy): Promise<void> => {
      const inFlight = textExtractionInFlightRef.current.get(index);
      if (inFlight) return inFlight;
      const task = (async () => {
        try {
          const pageHash = pdfPageHash(novel, index);
          const existing = await documentTextRepository.findReadyRevision(novel.id, index, pageHash);
          if (existing && (existing.source === 'ocr' || existing.id === pdfNativeTextRevisionId(novel.id, pageHash))) {
            const [rawBlocks, blocks] = await Promise.all([
              documentTextRepository.getRawBlocks(existing.id),
              documentTextRepository.getBlocks(existing.id),
            ]);
            await remapTextAnnotations(existing, rawBlocks).catch(() => undefined);
            setTextBlocksByPage((previous) => new Map(previous).set(index, blocks));
            const characters = rawBlocks.reduce((total, block) => total + block.text.length, 0);
            setTextPageStates((previous) =>
              new Map(previous).set(
                index,
                characters < 16 || (existing.qualityScore ?? 0) < 0.45 ? 'ocr_candidate' : 'ready',
              ),
            );
            return;
          }
          const result = await extractPdfNativeText({
            page,
            bookId: novel.id,
            pageIndex: index,
            pageHash,
          });
          await documentTextRepository.saveReadyPage(result.revision, result.blocks);
          await remapTextAnnotations(result.revision, result.blocks).catch(() => undefined);
          const activeBlocks = await documentTextRepository.getBlocks(result.revision.id);
          setTextBlocksByPage((previous) => new Map(previous).set(index, activeBlocks));
          setTextPageStates((previous) => new Map(previous).set(index, result.needsOcr ? 'ocr_candidate' : 'ready'));
          setReadyTextPages((await documentTextRepository.listReadyRevisions(novel.id)).length);
        } catch {
          setTextPageStates((previous) => new Map(previous).set(index, 'failed'));
        }
      })();
      textExtractionInFlightRef.current.set(index, task);
      try {
        await task;
      } finally {
        textExtractionInFlightRef.current.delete(index);
      }
    },
    [novel, remapTextAnnotations],
  );

  const indexAllPdfText = useCallback(async () => {
    if (!pdf || textIndexProgress) return;
    const controller = new AbortController();
    textIndexControllerRef.current = controller;
    setTextIndexProgress({ current: 0, total: pdf.numPages });
    try {
      for (let index = 0; index < pdf.numPages; index += 1) {
        if (controller.signal.aborted) break;
        const cached = pdfPages.get(index);
        const page = cached ?? (await pdf.getPage(index + 1));
        await ensurePdfNativeText(index, page);
        if (!cached) page.cleanup();
        setTextIndexProgress({ current: index + 1, total: pdf.numPages });
      }
      setReadyTextPages((await documentTextRepository.listReadyRevisions(novel.id)).length);
    } finally {
      textIndexControllerRef.current = undefined;
      setTextIndexProgress(undefined);
    }
  }, [ensurePdfNativeText, novel.id, pdf, pdfPages, textIndexProgress]);

  const prepareAllDocumentThumbnails = useCallback(async () => {
    const pdfDocument = pdf;
    const isPdf = novel.format === 'pdf';
    if (
      (isPdf && !pdfDocument) ||
      (!isPdf && novel.format !== 'image_archive') ||
      thumbnailBatchControllerRef.current
    ) {
      return;
    }
    const pageCount = isPdf ? (pdfDocument?.numPages ?? 0) : totalPages;
    const controller = new AbortController();
    const renderFingerprint = isPdf ? pdfThumbnailFingerprint() : archiveThumbnailFingerprint();
    const archiveSourceHash = novel.sourceContentHash ?? novel.rawTextHash;
    const archiveIdentities = new Map<number, Promise<{ assetId: string; pageHash: string }>>();
    const resolveArchiveIdentity = (index: number) => {
      const existing = archiveIdentities.get(index);
      if (existing) return existing;
      const task = (async () => {
        const chapter = sortedChapters[index];
        const paragraphPage = chapter ? await repository.getParagraphPage(chapter.id, 0) : undefined;
        const assetId = paragraphPage?.paragraphs[0]?.assetId;
        if (!assetId) throw new Error(`${index + 1}페이지 이미지 정보를 찾을 수 없습니다.`);
        return {
          assetId,
          pageHash: archiveThumbnailPageHash(archiveSourceHash, assetId, index),
        };
      })();
      archiveIdentities.set(index, task);
      return task;
    };
    thumbnailBatchControllerRef.current = controller;
    setThumbnailBatchSummary(undefined);
    setThumbnailBatchProgress({ current: 0, total: pageCount, rendered: 0, failed: 0 });
    try {
      const result = await runDocumentThumbnailBatch({
        totalPages: pageCount,
        signal: controller.signal,
        isCached: async (index) => {
          const pageHash = isPdf ? pdfPageHash(novel, index) : (await resolveArchiveIdentity(index)).pageHash;
          return Boolean(
            await getDocumentThumbnail({
              bookId: novel.id,
              pageIndex: index,
              pageHash,
              renderFingerprint,
              touch: false,
            }),
          );
        },
        renderPage: async (index, signal) => {
          if (isPdf && pdfDocument) {
            const cached = pdfPages.get(index);
            const page = cached ?? (await pdfDocument.getPage(index + 1));
            try {
              const rendered = await renderPdfThumbnail(page, signal);
              await saveDocumentThumbnail({
                bookId: novel.id,
                pageIndex: index,
                pageHash: pdfPageHash(novel, index),
                renderFingerprint: rendered.renderFingerprint,
                contentType: rendered.contentType,
                pixelWidth: rendered.pixelWidth,
                pixelHeight: rendered.pixelHeight,
                blob: rendered.blob,
              });
            } finally {
              if (!cached) page.cleanup();
            }
            return;
          }
          const identity = await resolveArchiveIdentity(index);
          const resource = await assets.getEmbeddedResource(novel.id, identity.assetId);
          if (!resource) throw new Error(`${index + 1}페이지 이미지를 찾을 수 없습니다.`);
          const rendered = await renderArchiveThumbnail(resource.blob, signal);
          await saveDocumentThumbnail({
            bookId: novel.id,
            pageIndex: index,
            pageHash: identity.pageHash,
            renderFingerprint: rendered.renderFingerprint,
            contentType: rendered.contentType,
            pixelWidth: rendered.pixelWidth,
            pixelHeight: rendered.pixelHeight,
            blob: rendered.blob,
          });
        },
        onProgress: setThumbnailBatchProgress,
      });
      await pruneDocumentThumbnails(novel.id);
      setThumbnailBatchSummary({
        rendered: result.rendered,
        failed: result.failed,
        cancelled: result.cancelled,
      });
    } finally {
      if (thumbnailBatchControllerRef.current === controller) thumbnailBatchControllerRef.current = undefined;
      setThumbnailBatchProgress(undefined);
    }
  }, [assets, novel, pdf, pdfPages, repository, sortedChapters, totalPages]);

  const recognizePdfPage = useCallback(
    async (index: number, signal: AbortSignal, current = 1, total = 1) => {
      if (!pdf) return;
      const cached = pdfPages.get(index);
      const page = cached ?? (await pdf.getPage(index + 1));
      const pendingRevision = pendingOcrRevision(novel, index, ocrLanguage);
      try {
        await documentTextRepository.saveRevision(pendingRevision);
        setOcrProgress({ pageIndex: index, progress: 0, status: '페이지 준비', current, total });
        const raster = await rasterizePdfPageForOcr(page);
        if (signal.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
        const provider = (ocrProviderRef.current ??= new LocalTesseractOcrProvider());
        const result = await provider.recognize(
          {
            ...raster,
            language: ocrLanguage,
            onProgress: (progress, status) => setOcrProgress({ pageIndex: index, progress, status, current, total }),
          },
          signal,
        );
        setOcrWorkerLanguage(ocrLanguage);
        const built = buildOcrDocumentText({
          result,
          bookId: novel.id,
          pageIndex: index,
          pageHash: pdfPageHash(novel, index),
          pixelWidth: raster.pixelWidth,
          pixelHeight: raster.pixelHeight,
          dpi: raster.dpi,
        });
        if (built.blocks.length === 0) throw new Error('인식된 텍스트가 없습니다.');
        await documentTextRepository.saveReadyPage(built.revision, built.blocks);
        await remapTextAnnotations(built.revision, built.blocks).catch(() => undefined);
        await documentTextRepository.markRevisionStatus(pendingRevision.id, 'stale').catch(() => undefined);
        const activeBlocks = await documentTextRepository.getBlocks(built.revision.id);
        setTextBlocksByPage((previous) => new Map(previous).set(index, activeBlocks));
        setTextPageStates((previous) => new Map(previous).set(index, 'ready'));
        setReadyTextPages((await documentTextRepository.listReadyRevisions(novel.id)).length);
      } catch (error) {
        const message =
          error instanceof DOMException && error.name === 'AbortError'
            ? 'OCR 작업이 취소되었습니다.'
            : error instanceof Error
              ? error.message
              : 'OCR을 완료하지 못했습니다.';
        await documentTextRepository.markRevisionStatus(pendingRevision.id, 'failed', message).catch(() => undefined);
        setTextPageStates((previous) => new Map(previous).set(index, 'failed'));
        throw error;
      } finally {
        if (!cached) page.cleanup();
      }
    },
    [novel, ocrLanguage, pdf, pdfPages, remapTextAnnotations],
  );

  const runOcrPages = useCallback(
    async (indexes: readonly number[]) => {
      if (indexes.length === 0 || ocrProgress) return;
      ocrControllerRef.current?.abort();
      const controller = new AbortController();
      ocrControllerRef.current = controller;
      setOcrError('');
      try {
        for (let offset = 0; offset < indexes.length; offset += 1) {
          if (controller.signal.aborted) break;
          await recognizePdfPage(indexes[offset], controller.signal, offset + 1, indexes.length);
        }
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'AbortError') {
          setOcrError(error instanceof Error ? error.message : 'OCR을 완료하지 못했습니다.');
        }
      } finally {
        if (ocrControllerRef.current === controller) ocrControllerRef.current = undefined;
        setOcrProgress(undefined);
        await refreshOcrModelCache();
      }
    },
    [ocrProgress, recognizePdfPage, refreshOcrModelCache],
  );

  const runOcrRange = useCallback(async () => {
    if (!pdf || textIndexProgress || ocrProgress) return;
    const range = normalizeOcrPageRange(ocrRangeStart, ocrRangeEnd, pdf.numPages);
    const controller = new AbortController();
    textIndexControllerRef.current = controller;
    setOcrError('');
    setTextIndexProgress({ current: 0, total: range.pageIndexes.length });
    const candidates: number[] = [];
    try {
      for (const [offset, index] of range.pageIndexes.entries()) {
        controller.signal.throwIfAborted();
        const cached = pdfPages.get(index);
        const page = cached ?? (await pdf.getPage(index + 1));
        await ensurePdfNativeText(index, page);
        if (!cached) page.cleanup();
        const revision = await documentTextRepository.findReadyRevision(novel.id, index, pdfPageHash(novel, index));
        const blocks = revision ? await documentTextRepository.getBlocks(revision.id) : [];
        const characters = blocks.reduce((total, block) => total + block.text.length, 0);
        if (
          needsPdfOcr({
            hasRevision: Boolean(revision),
            characters,
            qualityScore: revision?.qualityScore,
          })
        ) {
          candidates.push(index);
        }
        setTextIndexProgress({ current: offset + 1, total: range.pageIndexes.length });
      }
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'AbortError') {
        setOcrError(error instanceof Error ? error.message : 'OCR 범위를 준비하지 못했습니다.');
      }
      return;
    } finally {
      if (textIndexControllerRef.current === controller) textIndexControllerRef.current = undefined;
      setTextIndexProgress(undefined);
    }
    if (controller.signal.aborted) return;
    if (!candidates.length) {
      setOcrError('선택 범위의 native text 품질이 충분해 OCR할 페이지가 없습니다.');
      return;
    }
    await runOcrPages(candidates);
  }, [
    ensurePdfNativeText,
    novel,
    ocrProgress,
    ocrRangeEnd,
    ocrRangeStart,
    pdf,
    pdfPages,
    runOcrPages,
    textIndexProgress,
  ]);

  const unloadOcrWorker = useCallback(async () => {
    ocrControllerRef.current?.abort();
    const provider = ocrProviderRef.current;
    ocrProviderRef.current = undefined;
    if (provider) await provider.dispose();
    setOcrWorkerLanguage(undefined);
  }, []);

  const removeOcrModel = useCallback(
    async (language: OcrLanguageModel) => {
      if (ocrProgress || ocrModelCacheStatus === 'loading') return;
      setOcrModelCacheStatus('loading');
      setOcrModelCacheError('');
      try {
        await unloadOcrWorker();
        await removeOcrLanguageModelCache([language]);
        await refreshOcrModelCache();
      } catch (error) {
        setOcrModelCacheStatus('failed');
        setOcrModelCacheError(error instanceof Error ? error.message : 'OCR 언어 데이터를 삭제하지 못했습니다.');
      }
    },
    [ocrModelCacheStatus, ocrProgress, refreshOcrModelCache, unloadOcrWorker],
  );

  const openReadingOrderEditor = useCallback(async () => {
    setReadingOrderOpen(true);
    setReadingOrderStatus('loading');
    setReadingOrderError('');
    try {
      const cached = pdfPages.get(pageIndex);
      const page = cached ?? (pdf ? await pdf.getPage(pageIndex + 1) : undefined);
      try {
        if (page) await ensurePdfNativeText(pageIndex, page);
      } finally {
        if (page && !cached) page.cleanup();
      }
      const revision = await documentTextRepository.findReadyRevision(
        novel.id,
        pageIndex,
        pdfPageHash(novel, pageIndex),
      );
      if (!revision) throw new Error('현재 페이지의 텍스트를 먼저 준비해 주세요.');
      const [rawBlocks, override] = await Promise.all([
        documentTextRepository.getRawBlocks(revision.id),
        documentTextRepository.getOrderOverride(novel.id, pageIndex),
      ]);
      if (rawBlocks.length === 0) throw new Error('교정할 텍스트 블록이 없습니다.');
      const excludedFingerprints = new Set(override?.excludedBlockFingerprints ?? []);
      setReadingOrderRevision(revision);
      setReadingOrderBlocks(applyDocumentTextOrderOverride(rawBlocks, override, { includeExcluded: true }));
      setReadingOrderExcludedIds(
        new Set(
          rawBlocks
            .filter((block) => excludedFingerprints.has(documentTextBlockFingerprint(block)))
            .map((block) => block.id),
        ),
      );
      setReadingOrderStatus('idle');
    } catch (error) {
      setReadingOrderRevision(undefined);
      setReadingOrderBlocks([]);
      setReadingOrderExcludedIds(new Set());
      setReadingOrderStatus('failed');
      setReadingOrderError(error instanceof Error ? error.message : '읽기 순서를 불러오지 못했습니다.');
    }
  }, [ensurePdfNativeText, novel, pageIndex, pdf, pdfPages]);

  const moveReadingOrderBlock = useCallback((index: number, delta: -1 | 1) => {
    setReadingOrderBlocks((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const toggleReadingOrderExcluded = useCallback((blockId: string) => {
    setReadingOrderExcludedIds((current) => {
      const next = new Set(current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  }, []);

  const saveReadingOrder = useCallback(async () => {
    if (!readingOrderRevision) return;
    setReadingOrderStatus('saving');
    setReadingOrderError('');
    try {
      const existing = await documentTextRepository.getOrderOverride(novel.id, readingOrderRevision.pageIndex);
      await documentTextRepository.saveOrderOverride(
        createDocumentTextOrderOverride({
          revision: readingOrderRevision,
          orderedBlocks: readingOrderBlocks,
          excludedBlockIds: readingOrderExcludedIds,
          existing,
        }),
      );
      const activeBlocks = await documentTextRepository.getBlocks(readingOrderRevision.id);
      setTextBlocksByPage((previous) => new Map(previous).set(readingOrderRevision.pageIndex, activeBlocks));
      setReadingOrderVersion((version) => version + 1);
      setReadingOrderStatus('idle');
      setReadingOrderOpen(false);
    } catch (error) {
      setReadingOrderStatus('failed');
      setReadingOrderError(error instanceof Error ? error.message : '읽기 순서를 저장하지 못했습니다.');
    }
  }, [novel.id, readingOrderBlocks, readingOrderExcludedIds, readingOrderRevision]);

  const resetReadingOrder = useCallback(async () => {
    if (!readingOrderRevision) return;
    setReadingOrderStatus('saving');
    setReadingOrderError('');
    try {
      const override = await documentTextRepository.getOrderOverride(novel.id, readingOrderRevision.pageIndex);
      if (override) await documentTextRepository.removeOrderOverride(override.id);
      const rawBlocks = await documentTextRepository.getRawBlocks(readingOrderRevision.id);
      setTextBlocksByPage((previous) => new Map(previous).set(readingOrderRevision.pageIndex, rawBlocks));
      setReadingOrderVersion((version) => version + 1);
      setReadingOrderStatus('idle');
      setReadingOrderOpen(false);
    } catch (error) {
      setReadingOrderStatus('failed');
      setReadingOrderError(error instanceof Error ? error.message : '읽기 순서를 초기화하지 못했습니다.');
    }
  }, [novel.id, readingOrderRevision]);

  const jumpToSearchResult = useCallback(
    (resultIndex: number) => {
      if (searchResults.length === 0) return;
      const normalized = (resultIndex + searchResults.length) % searchResults.length;
      setSearchCursor(normalized);
      goToPage(searchResults[normalized].pageIndex);
    },
    [goToPage, searchResults],
  );

  const reloadDocumentAnnotations = useCallback(async () => {
    setDocumentAnnotations(await documentAnnotationRepository.list(novel.id));
  }, [novel.id]);

  const togglePageBookmark = useCallback(async () => {
    const existing = documentAnnotations.find(
      (annotation) => annotation.pageIndex === pageIndex && annotation.type === 'page_bookmark',
    );
    if (existing) await documentAnnotationRepository.remove(existing.id);
    else {
      const timestamp = new Date().toISOString();
      await documentAnnotationRepository.save({
        id: persistentId128('document_annotation', [novel.id, 'page_bookmark', String(pageIndex)]),
        bookId: novel.id,
        pageIndex,
        type: 'page_bookmark',
        anchor: { kind: 'fixed_page', bookId: novel.id, pageIndex, pageHash: pdfPageHash(novel, pageIndex) },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    await reloadDocumentAnnotations();
  }, [documentAnnotations, novel, pageIndex, reloadDocumentAnnotations]);

  const saveTextAnnotation = useCallback(
    async (type: 'text_highlight' | 'text_note') => {
      const selection = pendingTextSelection;
      if (!selection) return;
      const first = selection.ranges[0];
      const last = selection.ranges.at(-1);
      if (!first || !last) return;
      const timestamp = new Date().toISOString();
      const id = persistentId128('document_annotation', [
        novel.id,
        type,
        selection.textRevisionId,
        ...selection.ranges.flatMap((range) => [range.block.id, String(range.startOffset), String(range.endOffset)]),
      ]);
      const existing = documentAnnotations.find((annotation) => annotation.id === id);
      await documentAnnotationRepository.save({
        id,
        bookId: novel.id,
        pageIndex: selection.pageIndex,
        type,
        anchor: {
          kind: 'fixed_text',
          bookId: novel.id,
          pageIndex: selection.pageIndex,
          textRevisionId: selection.textRevisionId,
          blockId: first.block.id,
          startOffset: first.startOffset,
          endOffset: last.endOffset,
          blockRanges: selection.ranges.map((range) => ({
            blockId: range.block.id,
            startOffset: range.startOffset,
            endOffset: range.endOffset,
          })),
          quads: [...selection.quads],
        },
        quote: selection.quote,
        body: type === 'text_note' ? selectionNoteDraft.trim() : undefined,
        color: type === 'text_highlight' ? 'yellow' : 'blue',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      window.getSelection()?.removeAllRanges();
      setPendingTextSelection(undefined);
      setSelectionNoteDraft('');
      await reloadDocumentAnnotations();
    },
    [documentAnnotations, novel.id, pendingTextSelection, reloadDocumentAnnotations, selectionNoteDraft],
  );

  const manuallyReanchorAnnotation = useCallback(async () => {
    const selection = pendingTextSelection;
    const annotation = documentAnnotations.find((item) => item.id === reanchorTargetId);
    const first = selection?.ranges[0];
    const last = selection?.ranges.at(-1);
    if (!selection || !annotation || !first || !last) return;
    const updatedAt = new Date().toISOString();
    const updated = manuallyReanchorFixedTextAnnotation({
      annotation,
      quote: selection.quote,
      updatedAt,
      anchor: {
        kind: 'fixed_text',
        bookId: novel.id,
        pageIndex: selection.pageIndex,
        textRevisionId: selection.textRevisionId,
        blockId: first.block.id,
        startOffset: first.startOffset,
        endOffset: last.endOffset,
        blockRanges: selection.ranges.map((range) => ({
          blockId: range.block.id,
          startOffset: range.startOffset,
          endOffset: range.endOffset,
        })),
        quads: [...selection.quads],
      },
    });
    await documentAnnotationRepository.save(updated);
    window.getSelection()?.removeAllRanges();
    setPendingTextSelection(undefined);
    setReanchorTargetId(undefined);
    setSelectionMode(false);
    await reloadDocumentAnnotations();
  }, [documentAnnotations, novel.id, pendingTextSelection, reanchorTargetId, reloadDocumentAnnotations]);

  const saveRegionAnnotation = useCallback(
    async (type: 'region_highlight' | 'region_note') => {
      const selection = pendingRegionSelection;
      if (!selection) return;
      const timestamp = new Date().toISOString();
      const coordinates = [selection.quad.x, selection.quad.y, selection.quad.width, selection.quad.height].map(
        (value) => value.toFixed(6),
      );
      const id = persistentId128('document_annotation', [novel.id, type, String(selection.pageIndex), ...coordinates]);
      const existing = documentAnnotations.find((annotation) => annotation.id === id);
      await documentAnnotationRepository.save({
        id,
        bookId: novel.id,
        pageIndex: selection.pageIndex,
        type,
        anchor: {
          kind: 'fixed_region',
          bookId: novel.id,
          pageIndex: selection.pageIndex,
          pageHash: pdfPageHash(novel, selection.pageIndex),
          quads: [selection.quad],
        },
        body: type === 'region_note' ? regionNoteDraft.trim() : undefined,
        color: type === 'region_highlight' ? 'yellow' : 'blue',
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      setPendingRegionSelection(undefined);
      setRegionNoteDraft('');
      await reloadDocumentAnnotations();
    },
    [documentAnnotations, novel, pendingRegionSelection, regionNoteDraft, reloadDocumentAnnotations],
  );

  const removeDocumentAnnotation = useCallback(
    async (id: string) => {
      await documentAnnotationRepository.remove(id);
      if (reanchorTargetId === id) {
        setReanchorTargetId(undefined);
        setSelectionMode(false);
      }
      await reloadDocumentAnnotations();
    },
    [reanchorTargetId, reloadDocumentAnnotations],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void onPageSettled(pageIndex), 350);
    return () => window.clearTimeout(timer);
  }, [onPageSettled, pageIndex]);

  useEffect(() => {
    const anchor = listeningPosition?.anchor;
    if (anchor?.kind !== 'fixed_text' || anchor.bookId !== novel.id) return;
    goToPage(anchor.pageIndex);
  }, [goToPage, listeningPosition, novel.id]);

  useEffect(() => {
    if (novel.format !== 'image_archive') return;
    let active = true;
    setComicProfile(DEFAULT_COMIC_READING_PROFILE);
    setComicPageHints(new Map());
    void comicReadingProfileRepository.get(novel.id, { direction: novel.readingDirection ?? 'ltr' }).then((profile) => {
      if (!active) return;
      setComicProfile(profile);
      setViewMode(comicProfileModeToViewMode(profile.mode, profile.seamlessVertical));
      setFit(profile.fit);
    });
    return () => {
      active = false;
    };
  }, [novel.format, novel.id, novel.readingDirection]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = { width: entry.contentRect.width, height: entry.contentRect.height };
      const current = viewportSizeRef.current;
      if (current.width === next.width && current.height === next.height) return;
      pendingFocalAnchorRef.current ??= captureFocalAnchor();
      viewportSizeRef.current = next;
      setViewportSize(next);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [captureFocalAnchor]);

  useLayoutEffect(() => {
    continuousVirtualizer.measure();
  }, [
    archiveEstimateDimensions?.height,
    archiveEstimateDimensions?.width,
    continuousVirtualizer,
    effectiveViewMode,
    fit,
    rotation,
    viewportSize.height,
    viewportSize.width,
    zoom,
  ]);

  useLayoutEffect(() => {
    if (!continuousView) return;
    const pendingPage = pendingContinuousPageRef.current;
    const targetPage = pendingPage ?? pageIndex;
    const virtualIndex = continuousVirtualIndexByPage.get(targetPage) ?? 0;
    pendingContinuousPageRef.current = undefined;
    if (pendingPage !== undefined) {
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTo({ top: 0, left: viewport.scrollLeft });
      continuousVirtualizer.scrollToIndex(virtualIndex, { align: 'start' });
    }
    const frame = window.requestAnimationFrame(() =>
      continuousVirtualizer.scrollToIndex(virtualIndex, {
        align: pendingPage === undefined && !seamlessContinuousView ? 'center' : 'start',
      }),
    );
    return () => window.cancelAnimationFrame(frame);
    // Settle when the layout or active episode changes. Scroll tracking owns later page changes inside the episode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continuousSectionKey, continuousView, effectiveViewMode, seamlessContinuousView]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const frame = window.requestAnimationFrame(() => sidebarVirtualizer.scrollToIndex(pageIndex, { align: 'center' }));
    return () => window.cancelAnimationFrame(frame);
    // Do not pull the thumbnail rail back while the user is browsing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarOpen]);

  useEffect(() => {
    if (!mobileThumbnailOpen) return;
    const frame = window.requestAnimationFrame(() => {
      sidebarVirtualizer.measure();
      sidebarVirtualizer.scrollToIndex(pageIndex, { align: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mobileThumbnailOpen, pageIndex, sidebarVirtualizer]);

  useEffect(() => {
    if (novel.format !== 'pdf') return;
    let active = true;
    let loaded: PDFDocumentProxy | undefined;
    let rangeTransport: BookSourcePdfRangeTransport | undefined;
    setStatus('loading');
    void assets
      .openSource(novel.id)
      .then(async (source) => {
        if (!source) throw new Error('PDF 원본을 찾을 수 없습니다. 원본 파일을 다시 연결해 주세요.');
        rangeTransport = await BookSourcePdfRangeTransport.open(source);
        const task = getDocument({
          range: rangeTransport,
          rangeChunkSize: 64 * 1024,
          disableAutoFetch: true,
          disableStream: true,
        });
        loaded = await task.promise;
        if (!active) return loaded.destroy();
        setPdf(loaded);
        setStatus('ready');
      })
      .catch((error) => {
        if (!active) return;
        setErrorMessage(error instanceof Error ? error.message : 'PDF를 열지 못했습니다.');
        setStatus('failed');
      });
    return () => {
      active = false;
      rangeTransport?.abort();
      if (loaded) void loaded.destroy();
    };
  }, [assets, novel.format, novel.id]);

  useEffect(() => {
    if (novel.format !== 'pdf' || novel.coverAssetId || !pdf || !assets.saveGeneratedCover) return;
    const sourceHash = novel.sourceContentHash ?? novel.rawTextHash;
    const pageHash = pdfPageHash(novel, 0);
    const attemptKey = `${sourceHash}:${pageHash}`;
    if (generatedCoverAttemptRef.current === attemptKey) return;
    generatedCoverAttemptRef.current = attemptKey;
    let active = true;
    void (async () => {
      const cached = pdfPages.get(0);
      const page = cached ?? (await pdf.getPage(1));
      try {
        const input = await renderPdfGeneratedCover({ page, sourceHash, pageHash });
        const cover = await assets.saveGeneratedCover?.(novel.id, input);
        if (active && cover) onGeneratedCover?.(cover);
      } finally {
        if (!cached) page.cleanup();
      }
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [assets, novel, onGeneratedCover, pdf, pdfPages]);

  useEffect(() => {
    if (!pdf) return;
    let active = true;
    const wanted = new Set([...wantedPageIndexes].filter((value) => value >= 0 && value < totalPages));
    void Promise.all(
      [...wanted].map(async (index) => {
        if (pdfPages.has(index)) return;
        const page = await pdf.getPage(index + 1);
        if (active) setPdfPages((previous) => new Map(previous).set(index, page));
      }),
    );
    return () => {
      active = false;
    };
  }, [pdf, pdfPages, totalPages, wantedPageIndexes]);

  useEffect(() => {
    if (novel.format !== 'pdf') return;
    let active = true;
    setTextBlocksByPage(new Map());
    setTextPageStates(new Map());
    setReadyTextPages(0);
    setSearchResults([]);
    setOcrError('');
    void Promise.all([
      documentTextRepository.recoverInterruptedOcr(novel.id),
      documentTextRepository.listReadyRevisions(novel.id),
    ]).then(([interrupted, revisions]) => {
      if (!active) return;
      setReadyTextPages(revisions.length);
      if (interrupted.length > 0) {
        setTextPageStates(
          new Map(interrupted.map((revision) => [revision.pageIndex, 'failed' satisfies PdfTextPageState])),
        );
        setOcrError(`이전에 중단된 OCR ${interrupted.length}페이지를 다시 실행할 수 있습니다.`);
      }
    });
    return () => {
      active = false;
      textIndexControllerRef.current?.abort();
    };
  }, [novel.format, novel.id]);

  useEffect(() => {
    setPendingTextSelection(undefined);
    setSelectionNoteDraft('');
    void reloadDocumentAnnotations();
  }, [annotationSyncRevision, reloadDocumentAnnotations]);

  useEffect(() => {
    setReadingOrderOpen(false);
    setReadingOrderRevision(undefined);
    setReadingOrderBlocks([]);
    setReadingOrderExcludedIds(new Set());
    setReadingOrderError('');
  }, [novel.id, pageIndex]);

  useEffect(() => {
    if (!searchOpen) setReadingOrderOpen(false);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen || novel.format !== 'pdf') return;
    void refreshOcrModelCache();
  }, [novel.format, refreshOcrModelCache, searchOpen]);

  useEffect(
    () => () => {
      ocrControllerRef.current?.abort();
      thumbnailBatchControllerRef.current?.abort();
      if (ocrProviderRef.current) void ocrProviderRef.current.dispose();
    },
    [],
  );

  useEffect(() => {
    if (novel.format !== 'pdf') return;
    displayedPageKey
      .split(',')
      .filter(Boolean)
      .map(Number)
      .forEach((index) => {
        const page = pdfPages.get(index);
        if (page) void ensurePdfNativeText(index, page);
      });
  }, [displayedPageKey, ensurePdfNativeText, novel.format, pdfPages]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!searchOpen || !query) {
      setSearchStatus('idle');
      setSearchResults([]);
      setSearchCursor(0);
      return;
    }
    let active = true;
    setSearchStatus('loading');
    const timer = window.setTimeout(() => {
      void documentTextRepository
        .search(novel.id, query)
        .then((results) => {
          if (!active) return;
          setSearchResults(results);
          setSearchCursor(0);
          setSearchStatus('ready');
          if (results[0]) goToPage(results[0].pageIndex);
        })
        .catch(() => active && setSearchStatus('failed'));
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [goToPage, novel.id, readingOrderVersion, searchOpen, searchQuery, readyTextPages]);

  useEffect(() => {
    setPdfPages((previous) => {
      if (previous.size <= 20) return previous;
      const next = new Map(previous);
      for (const [index, page] of previous) {
        if (wantedPageIndexes.has(index) || Math.abs(index - pageIndex) <= 3) continue;
        page.cleanup();
        next.delete(index);
      }
      return next;
    });
  }, [pageIndex, wantedPageIndexes]);

  useEffect(() => {
    if (novel.format !== 'image_archive') return;
    let active = true;
    const wanted = new Set([...imageWantedPageIndexes].filter((value) => value >= 0 && value < totalPages));
    const missing = [...wanted].filter((index) => !imageUrlsRef.current.has(index));
    if (missing.length === 0) {
      setStatus('ready');
      return;
    }
    setStatus('loading');
    void Promise.all(
      missing.map((index) => {
        const loadKey = `${novel.id}:${index}`;
        const existing = archiveImageLoadsRef.current.get(loadKey);
        if (existing) return existing;
        const pending = (async (): Promise<LoadedArchivePage> => {
          const chapter = sortedChapters[index];
          const paragraphPage = chapter ? await repository.getParagraphPage(chapter.id, 0) : undefined;
          const paragraph = paragraphPage?.paragraphs[0];
          const assetId = paragraph?.assetId;
          const resource = assetId ? await assets.getEmbeddedResource(novel.id, assetId) : undefined;
          if (!resource) throw new Error(`${index + 1}페이지 이미지를 찾을 수 없습니다.`);
          return {
            index,
            blob: resource.blob,
            ...(paragraph?.documentPageType !== undefined || paragraph?.documentPageDouble !== undefined
              ? {
                  hint: {
                    type: paragraph.documentPageType,
                    doublePage: paragraph.documentPageDouble,
                  },
                }
              : {}),
          };
        })();
        archiveImageLoadsRef.current.set(loadKey, pending);
        void pending.then(
          () => {
            if (archiveImageLoadsRef.current.get(loadKey) === pending) archiveImageLoadsRef.current.delete(loadKey);
          },
          () => {
            if (archiveImageLoadsRef.current.get(loadKey) === pending) archiveImageLoadsRef.current.delete(loadKey);
          },
        );
        return pending;
      }),
    )
      .then((loaded) => {
        if (!active) return;
        const hints = loaded.filter((page): page is LoadedArchivePage & { hint: ComicPageLayoutHint } =>
          Boolean(page.hint),
        );
        if (hints.length > 0) {
          setComicPageHints((previous) => {
            const next = new Map(previous);
            let changed = false;
            for (const page of hints) {
              const current = next.get(page.index);
              if (current?.type === page.hint.type && current?.doublePage === page.hint.doublePage) continue;
              next.set(page.index, page.hint);
              changed = true;
            }
            return changed ? next : previous;
          });
        }
        setImageUrls((previous) => {
          const next = new Map(previous);
          let changed = false;
          for (const page of loaded) {
            if (next.has(page.index)) continue;
            next.set(page.index, URL.createObjectURL(page.blob));
            changed = true;
          }
          if (!changed) return previous;
          imageUrlsRef.current = next;
          return next;
        });
        setStatus('ready');
      })
      .catch((error) => {
        if (!active) return;
        setErrorMessage(error instanceof Error ? error.message : '이미지 페이지를 열지 못했습니다.');
        setStatus('failed');
      });
    return () => {
      active = false;
    };
  }, [assets, imageWantedPageIndexes, novel.format, novel.id, repository, sortedChapters, totalPages]);

  useEffect(() => {
    setImageUrls((previous) => {
      if (previous.size <= 20) return previous;
      const next = new Map(previous);
      for (const [index, url] of previous) {
        if (imageWantedPageIndexes.has(index)) continue;
        URL.revokeObjectURL(url);
        next.delete(index);
      }
      imageUrlsRef.current = next;
      return next;
    });
  }, [imageWantedPageIndexes]);

  useEffect(
    () => () => {
      comicCropControllerRef.current?.abort();
      if (viewportScrollFrameRef.current !== undefined) cancelAnimationFrame(viewportScrollFrameRef.current);
      imageUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      imageUrlsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof Element && event.target.closest('[contenteditable="true"]'))
      )
        return;
      const rtlComic = novel.format === 'image_archive' && comicProfile.direction === 'rtl';
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        turnPage(rtlComic ? 1 : -1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        turnPage(rtlComic ? -1 : 1);
      } else if (event.key === 'PageUp') {
        event.preventDefault();
        turnPage(-1);
      } else if (event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        turnPage(1);
      } else if (event.key.toLowerCase() === 'i') {
        event.preventDefault();
        toggleImmersive();
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        void toggleFullscreen();
      } else if (event.key === '+' || event.key === '=')
        preserveFocalPoint(() => setZoom((value) => Math.min(3, value + 0.1)));
      else if (event.key === '-') preserveFocalPoint(() => setZoom((value) => Math.max(0.5, value - 0.1)));
      else if (event.key === 'Escape' && pendingRegionSelection) setPendingRegionSelection(undefined);
      else if (event.key === 'Escape' && pendingTextSelection) setPendingTextSelection(undefined);
      else if (event.key === 'Escape' && reanchorTargetId) {
        setReanchorTargetId(undefined);
        setSelectionMode(false);
      } else if (event.key === 'Escape' && mobileThumbnailOpen) setMobileThumbnailOpen(false);
      else if (event.key === 'Escape' && mobileMenuOpen) setMobileMenuOpen(false);
      else if (event.key === 'Escape' && regionMode) setRegionMode(false);
      else if (event.key === 'Escape' && readingOrderOpen) setReadingOrderOpen(false);
      else if (event.key === 'Escape' && searchOpen) setSearchOpen(false);
      else if (event.key === 'Escape' && annotationOpen) setAnnotationOpen(false);
      else if (event.key === 'Escape' && comicSettingsOpen) setComicSettingsOpen(false);
      else if (event.key === 'Escape' && listeningPreparationOpen) setListeningPreparationOpen(false);
      else if (event.key === 'Escape' && immersive) setImmersive(false);
      else if (event.key === 'Escape' && document.fullscreenElement) void document.exitFullscreen();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    annotationOpen,
    comicProfile.direction,
    comicSettingsOpen,
    listeningPreparationOpen,
    mobileMenuOpen,
    mobileThumbnailOpen,
    novel.format,
    pendingRegionSelection,
    pendingTextSelection,
    reanchorTargetId,
    readingOrderOpen,
    regionMode,
    searchOpen,
    preserveFocalPoint,
    immersive,
    toggleFullscreen,
    toggleImmersive,
    turnPage,
  ]);

  const progressPercent = totalPages > 0 ? ((pageIndex + 1) / totalPages) * 100 : 0;
  const ocrCandidatePages = [...textPageStates]
    .filter(([, state]) => state === 'ocr_candidate' || state === 'failed')
    .map(([index]) => index)
    .sort((left, right) => left - right);
  const currentPageBookmarked = documentAnnotations.some(
    (annotation) => annotation.pageIndex === pageIndex && annotation.type === 'page_bookmark',
  );
  const pageStyle = {
    '--fixed-doc-zoom': zoom,
    '--fixed-doc-rotation': `${rotation}deg`,
    '--fixed-doc-brightness': comicProfile.brightness,
    '--fixed-doc-contrast': comicProfile.contrast,
    '--fixed-doc-saturation': comicProfile.saturation,
    '--fixed-doc-grayscale': comicProfile.grayscale ? 1 : 0,
    '--fixed-doc-invert': comicProfile.invert ? 1 : 0,
    '--fixed-doc-gap': `${novel.format === 'image_archive' ? (comicProfile.gap ?? 8) : 32}px`,
    '--fixed-doc-crop-top': `${comicProfile.crop === 'manual' ? (comicProfile.manualCrop?.top ?? 0) * 100 : 0}%`,
    '--fixed-doc-crop-right': `${comicProfile.crop === 'manual' ? (comicProfile.manualCrop?.right ?? 0) * 100 : 0}%`,
    '--fixed-doc-crop-bottom': `${comicProfile.crop === 'manual' ? (comicProfile.manualCrop?.bottom ?? 0) * 100 : 0}%`,
    '--fixed-doc-crop-left': `${comicProfile.crop === 'manual' ? (comicProfile.manualCrop?.left ?? 0) * 100 : 0}%`,
    '--fixed-doc-crop-scale': comicProfile.crop === 'manual' ? comicCropRefitScale(comicProfile.manualCrop, fit) : 1,
    '--fixed-doc-original-scale': fit === 'original' ? zoom : 1,
    '--fixed-doc-viewport-width': `${viewportSize.width}px`,
    '--fixed-doc-viewport-height': `${viewportSize.height}px`,
  } as CSSProperties;
  const continuousSectionFooterHeight =
    continuousView && currentDocumentSection
      ? nextDocumentSection
        ? CONTINUOUS_SECTION_BOUNDARY_HEIGHT
        : CONTINUOUS_SECTION_NAV_HEIGHT
      : 0;
  const scrollSectionBoundary = useScrollChapterBoundary({
    rootRef: viewportRef,
    contentRef: continuousContentRef,
    chapterId: continuousSectionKey,
    enabled: continuousView && Boolean(currentDocumentSection && nextDocumentSection),
    onNextChapter: () => {
      if (nextDocumentSection) goToPage(nextDocumentSection.startPageIndex);
    },
  });

  const pointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (selectionMode && event.target instanceof Element && event.target.closest('.fixed-doc-text-layer')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      at: performance.now(),
      immersiveEligible: !(
        event.target instanceof Element &&
        event.target.closest(
          'a,button,input,select,textarea,label,[role="button"],[contenteditable="true"],.fixed-doc-text-layer,.fixed-doc-region-select-layer',
        )
      ),
    };
    if (activePointersRef.current.size === 1 && continuousView) scrollSectionBoundary.onPointerDown(event.clientY);
    if (activePointersRef.current.size === 2) {
      const [first, second] = [...activePointersRef.current.values()];
      const midpointX = (first.x + second.x) / 2;
      const midpointY = (first.y + second.y) / 2;
      pinchRef.current = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        zoom,
        active: true,
        anchor: captureFocalAnchor(midpointX, midpointY),
      };
      pointerStartRef.current = undefined;
    }
  };
  const pointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const previous = activePointersRef.current.get(event.pointerId);
    if (!previous) return;
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointersRef.current.size >= 2) {
      event.preventDefault();
      const [first, second] = [...activePointersRef.current.values()];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const pinch = pinchRef.current;
      if (pinch && pinch.distance > 0) {
        const midpointX = (first.x + second.x) / 2;
        const midpointY = (first.y + second.y) / 2;
        const viewportRect = viewportRef.current?.getBoundingClientRect();
        if (pinch.anchor && viewportRect) {
          pendingFocalAnchorRef.current = {
            ...pinch.anchor,
            viewportOffsetX: midpointX - viewportRect.left,
            viewportOffsetY: midpointY - viewportRect.top,
          };
          setFocalRestoreRevision((revision) => revision + 1);
          setZoom(Math.max(0.5, Math.min(3, pinch.zoom * (distance / pinch.distance))));
        } else {
          preserveFocalPoint(
            () => setZoom(Math.max(0.5, Math.min(3, pinch.zoom * (distance / pinch.distance)))),
            midpointX,
            midpointY,
          );
        }
      }
      return;
    }
    if (continuousView && scrollSectionBoundary.onPointerMove(event.clientY)) {
      event.preventDefault();
      return;
    }
    if (zoom > 1.02) {
      viewportRef.current?.scrollBy({ left: previous.x - event.clientX, top: previous.y - event.clientY });
      pointerStartRef.current = undefined;
    }
  };
  const pointerUp = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const wasPinching = Boolean(pinchRef.current?.active);
    activePointersRef.current.delete(event.pointerId);
    if (activePointersRef.current.size < 2) pinchRef.current = undefined;
    const start = pointerStartRef.current;
    pointerStartRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const deltaX = start ? event.clientX - start.x : 0;
    const deltaY = start ? event.clientY - start.y : 0;
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    const horizontalPosition = viewportRect ? (event.clientX - viewportRect.left) / Math.max(1, viewportRect.width) : 0;
    const shouldToggleImmersive = Boolean(
      !cancelled &&
      start?.immersiveEligible &&
      !wasPinching &&
      Math.abs(deltaX) <= 12 &&
      Math.abs(deltaY) <= 12 &&
      performance.now() - start.at <= 500 &&
      horizontalPosition >= 0.33 &&
      horizontalPosition <= 0.67,
    );
    const toggleImmersiveFromViewport = () => {
      suppressViewportClickRef.current = true;
      window.setTimeout(() => {
        suppressViewportClickRef.current = false;
      }, 0);
      toggleImmersive();
    };
    if (continuousView) {
      if (!cancelled && start && !wasPinching && zoom <= 1.02)
        scrollSectionBoundary.onVerticalGesture(start.y - event.clientY);
      scrollSectionBoundary.onPointerEnd();
      if (shouldToggleImmersive) toggleImmersiveFromViewport();
      return;
    }
    if (shouldToggleImmersive) {
      toggleImmersiveFromViewport();
      return;
    }
    if (!start || wasPinching || zoom > 1.02 || cancelled) return;
    if (Math.abs(deltaX) < 55 || Math.abs(deltaX) < Math.abs(deltaY)) return;
    const rtlComic = novel.format === 'image_archive' && comicProfile.direction === 'rtl';
    turnPage(deltaX < 0 ? (rtlComic ? -1 : 1) : rtlComic ? 1 : -1);
  };
  const handleViewportScroll = () => {
    scrollSectionBoundary.onScroll();
    if (!continuousView || viewportScrollFrameRef.current !== undefined) return;
    viewportScrollFrameRef.current = window.requestAnimationFrame(() => {
      viewportScrollFrameRef.current = undefined;
      const viewport = viewportRef.current;
      if (!viewport) return;
      const nearestVirtualIndex = continuousPageNearestViewportCenter(
        continuousVirtualizer.getVirtualItems(),
        viewport.scrollTop,
        viewport.clientHeight,
      );
      const nearest = nearestVirtualIndex === undefined ? undefined : continuousPageIndexes[nearestVirtualIndex];
      if (nearest === undefined) return;
      setPageIndex((current) => {
        if (current === nearest) return current;
        setPageDraft(String(nearest + 1));
        return nearest;
      });
    });
  };
  const rtlComic = novel.format === 'image_archive' && comicProfile.direction === 'rtl';
  const currentSpreadIndex = comicSpreadForPage(comicSpreads, pageIndex);
  const canTurn = (step: -1 | 1) =>
    effectiveViewMode === 'spread' && novel.format === 'image_archive'
      ? currentSpreadIndex + step >= 0 && currentSpreadIndex + step < comicSpreads.length
      : pageIndex + step >= 0 && pageIndex + step < totalPages;
  const leftTurnStep: -1 | 1 = rtlComic ? 1 : -1;
  const rightTurnStep: -1 | 1 = rtlComic ? -1 : 1;

  return (
    <main className={`fixed-doc-screen${immersive ? ' is-immersive' : ''}`}>
      <header className="fixed-doc-header">
        <div className="fixed-doc-title-group">
          <button type="button" className="fixed-doc-icon-button" onClick={onBack} aria-label="라이브러리로 돌아가기">
            <ArrowLeft size={19} />
          </button>
          <div>
            <strong>{novel.title}</strong>
            {currentDocumentSection && (
              <small className="fixed-doc-mobile-section-label">
                {mobileComicSectionLabel(currentDocumentSection.title)}
              </small>
            )}
            <span>
              {bookFormatLabel(novel)} ·{' '}
              {documentSections.length > 0 ? `${documentSections.length.toLocaleString()}개 회차 · ` : ''}
              {totalPages.toLocaleString()}페이지
            </span>
          </div>
          {documentSections.length > 0 && (
            <label className="fixed-doc-section-select">
              <span>회차</span>
              <select
                value={currentDocumentSection?.id ?? documentSections[0]?.id}
                aria-label="웹툰 회차"
                onChange={(event) => {
                  const section = documentSections.find((candidate) => candidate.id === event.target.value);
                  if (section) goToPage(section.startPageIndex);
                }}
              >
                {documentSections.map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.title} · {section.pageCount}페이지
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="fixed-doc-toolbar" aria-label="문서 보기 설정">
          <button
            type="button"
            onClick={() => preserveFocalPoint(() => setSidebarOpen((open) => !open))}
            aria-pressed={sidebarOpen}
            title="페이지 목록"
          >
            {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          {novel.format !== 'image_archive' && (
            <button
              type="button"
              onClick={() =>
                preserveFocalPoint(() => setViewMode((mode) => (mode === 'single' ? 'continuous' : 'single')))
              }
              aria-pressed={viewMode !== 'single'}
              aria-label="연속 보기"
              title="연속 보기"
            >
              <Columns3 size={17} />
            </button>
          )}
          {novel.format === 'image_archive' && (
            <button
              type="button"
              className="fixed-doc-mobile-top-action"
              onClick={() => {
                setComicSettingsOpen((open) => !open);
                setMobileMenuOpen(false);
              }}
              aria-pressed={comicSettingsOpen}
              aria-label="만화 보기 설정"
              title="만화 보기 설정"
            >
              <Settings2 size={17} />
            </button>
          )}
          {novel.format === 'pdf' && (
            <>
              <button
                type="button"
                onClick={() => {
                  setSearchOpen((open) => !open);
                  setAnnotationOpen(false);
                }}
                aria-pressed={searchOpen}
                title="PDF 본문 검색"
              >
                <Search size={17} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectionMode((enabled) => !enabled);
                  setRegionMode(false);
                  setPendingRegionSelection(undefined);
                }}
                aria-pressed={selectionMode}
                title="텍스트 선택·복사"
              >
                <TextCursorInput size={17} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setRegionMode((enabled) => !enabled);
                  setSelectionMode(false);
                  setPendingTextSelection(undefined);
                  window.getSelection()?.removeAllRanges();
                }}
                aria-pressed={regionMode}
                title="영역 하이라이트·메모"
              >
                <Highlighter size={17} />
              </button>
              <button
                type="button"
                onClick={() => void onStartListening?.(pageIndex)}
                disabled={!textBlocksByPage.get(pageIndex)?.length}
                title="현재 페이지부터 듣기"
              >
                <Play size={17} />
              </button>
              {onPrepareListening && (
                <button
                  type="button"
                  onClick={() => {
                    setListeningRangeStart(pageIndex + 1);
                    setListeningRangeEnd(Math.min(totalPages, pageIndex + 10));
                    setListeningPreparationOpen((open) => !open);
                    setSearchOpen(false);
                    setAnnotationOpen(false);
                  }}
                  aria-pressed={listeningPreparationOpen}
                  title="PDF 오프라인 음성 준비"
                >
                  <Download size={17} />
                </button>
              )}
              <button
                type="button"
                onClick={() => void togglePageBookmark()}
                aria-pressed={currentPageBookmarked}
                title="현재 페이지 북마크"
              >
                <Bookmark size={17} fill={currentPageBookmarked ? 'currentColor' : 'none'} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setAnnotationOpen((open) => !open);
                  setSearchOpen(false);
                }}
                aria-pressed={annotationOpen}
                title="PDF 북마크·메모 목록"
              >
                <StickyNote size={17} />
              </button>
            </>
          )}
          <i />
          <button
            type="button"
            onClick={() => preserveFocalPoint(() => setZoom((value) => Math.max(0.5, value - 0.1)))}
            aria-label="축소"
          >
            <Minus size={17} />
          </button>
          <span className="fixed-doc-zoom-label">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => preserveFocalPoint(() => setZoom((value) => Math.min(3, value + 0.1)))}
            aria-label="확대"
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            onClick={() => {
              preserveFocalPoint(() => {
                setFit('page');
                setZoom(1);
              });
              if (novel.format === 'image_archive') updateComicProfile({ fit: 'page' });
            }}
            aria-pressed={fit === 'page'}
            title="페이지 맞춤"
          >
            <Maximize2 size={17} />
          </button>
          <button
            type="button"
            onClick={() => {
              preserveFocalPoint(() => {
                setFit('width');
                setZoom(1);
              });
              if (novel.format === 'image_archive') updateComicProfile({ fit: 'width' });
            }}
            aria-pressed={fit === 'width'}
            title="너비 맞춤"
          >
            <Expand size={17} />
          </button>
          <button
            type="button"
            onClick={() => preserveFocalPoint(() => setRotation((value) => (value + 90) % 360))}
            title="회전"
          >
            <RotateCw size={17} />
          </button>
          <button
            type="button"
            onClick={toggleImmersive}
            aria-pressed={immersive}
            aria-label={immersive ? '몰입 모드 종료' : '몰입 모드 시작'}
            title="몰입 모드"
          >
            <Focus size={17} />
          </button>
          <button
            type="button"
            className={novel.format === 'image_archive' ? 'fixed-doc-mobile-top-action' : undefined}
            onClick={() => void toggleFullscreen()}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? '전체 화면 종료' : '전체 화면 시작'}
            title="전체 화면"
          >
            {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <button
            type="button"
            className="fixed-doc-mobile-menu-button"
            onClick={() => {
              const next = !mobileMenuOpen;
              if (next) {
                setSearchOpen(false);
                setAnnotationOpen(false);
                setComicSettingsOpen(false);
                setListeningPreparationOpen(false);
                setMobileThumbnailOpen(false);
              }
              setMobileMenuOpen(next);
            }}
            aria-expanded={mobileMenuOpen}
            aria-controls="fixed-doc-mobile-menu"
            title="문서 메뉴"
          >
            <MoreHorizontal size={19} />
          </button>
        </div>
        <form
          className="fixed-doc-page-input"
          onSubmit={(event) => {
            event.preventDefault();
            goToPage(Number(pageDraft) - 1);
          }}
        >
          <input
            value={pageDraft}
            inputMode="numeric"
            aria-label="현재 페이지"
            onChange={(event) => setPageDraft(event.target.value)}
          />
          <span>/ {totalPages.toLocaleString()}</span>
        </form>
      </header>

      <div className={`fixed-doc-workspace${sidebarOpen ? '' : ' is-sidebar-closed'}`}>
        {sidebarOpen && (
          <aside
            ref={sidebarRef}
            className={`fixed-doc-sidebar${mobileThumbnailOpen ? ' is-mobile-open' : ''}`}
            aria-label="페이지 목록"
          >
            {mobileThumbnailOpen && (
              <header className="fixed-doc-mobile-sheet-header">
                <strong>페이지 목록</strong>
                <button type="button" onClick={() => setMobileThumbnailOpen(false)} aria-label="페이지 목록 닫기">
                  <X size={17} />
                </button>
              </header>
            )}
            {(novel.format === 'pdf' || novel.format === 'image_archive') && (
              <div className="fixed-doc-thumbnail-actions">
                <span>
                  {thumbnailBatchProgress
                    ? `미리보기 ${thumbnailBatchProgress.current}/${thumbnailBatchProgress.total}`
                    : thumbnailBatchSummary
                      ? thumbnailBatchSummary.cancelled
                        ? '미리보기 준비 취소됨'
                        : thumbnailBatchSummary.failed > 0
                          ? `완료 · 실패 ${thumbnailBatchSummary.failed}`
                          : '미리보기 준비 완료'
                      : '페이지 미리보기'}
                </span>
                {thumbnailBatchProgress ? (
                  <button type="button" onClick={() => thumbnailBatchControllerRef.current?.abort()}>
                    취소
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void prepareAllDocumentThumbnails()}
                    disabled={novel.format === 'pdf' ? !pdf : totalPages === 0}
                  >
                    전체 준비
                  </button>
                )}
              </div>
            )}
            <div className="fixed-doc-sidebar-list" style={{ height: sidebarVirtualizer.getTotalSize() }}>
              {sidebarItems.map((item) => {
                const index = item.index;
                const chapter = sortedChapters[index];
                const pdfPage = pdfPages.get(index);
                return (
                  <button
                    key={chapter.id}
                    ref={sidebarVirtualizer.measureElement}
                    data-index={index}
                    type="button"
                    className={`${index === pageIndex ? 'is-active' : ''}${
                      documentAnnotations.some(
                        (annotation) => annotation.pageIndex === index && annotation.type === 'page_bookmark',
                      )
                        ? ' has-bookmark'
                        : ''
                    }`}
                    style={{ transform: `translateY(${item.start}px)` }}
                    onClick={() => {
                      goToPage(index);
                      setMobileThumbnailOpen(false);
                    }}
                  >
                    <span className="fixed-doc-thumb-placeholder">
                      {novel.format === 'pdf' && pdfPage ? (
                        <PdfThumbnailPreview
                          page={pdfPage}
                          bookId={novel.id}
                          pageIndex={index}
                          pageHash={pdfPageHash(novel, index)}
                        />
                      ) : novel.format === 'image_archive' ? (
                        <ArchiveThumbnailPreview
                          bookId={novel.id}
                          sourceHash={novel.sourceContentHash ?? novel.rawTextHash}
                          chapterId={chapter.id}
                          pageIndex={index}
                          repository={repository}
                          assets={assets}
                          onPageHint={recordComicPageHint}
                        />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <em>
                      {index + 1}페이지
                      {comicPageTypeLabel(comicPageHints.get(index)?.type)
                        ? ` · ${comicPageTypeLabel(comicPageHints.get(index)?.type)}`
                        : ''}
                      {comicPageHints.get(index)?.doublePage ? ' · 양면 원고' : ''}
                    </em>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
        <section
          className={`fixed-doc-viewport is-${fit} is-${effectiveViewMode} is-bg-${comicProfile.background ?? 'charcoal'}`}
          ref={viewportRef}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={(event) => pointerUp(event, true)}
          onLostPointerCapture={pointerUp}
          onClickCapture={(event) => {
            if (!suppressViewportClickRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            suppressViewportClickRef.current = false;
          }}
          onScroll={handleViewportScroll}
          onWheel={(event) => {
            scrollSectionBoundary.onWheel(event);
            if (!event.ctrlKey) return;
            event.preventDefault();
            preserveFocalPoint(
              () => setZoom((value) => Math.max(0.5, Math.min(3, value - event.deltaY * 0.002))),
              event.clientX,
              event.clientY,
            );
          }}
          onDoubleClick={(event) => {
            if (continuousView) {
              event.preventDefault();
              return;
            }
            preserveFocalPoint(() => setZoom((value) => (value > 1.02 ? 1 : 2)), event.clientX, event.clientY);
          }}
          aria-busy={status === 'loading'}
        >
          {status === 'failed' ? (
            <div className="fixed-doc-message">
              <strong>문서를 열지 못했습니다.</strong>
              <span>{errorMessage}</span>
            </div>
          ) : (
            <div
              ref={continuousContentRef}
              className={`fixed-doc-pages${continuousView ? ' is-virtual' : ''}`}
              style={
                continuousView
                  ? {
                      ...pageStyle,
                      height: continuousVirtualizer.getTotalSize() + continuousSectionFooterHeight,
                    }
                  : pageStyle
              }
            >
              {displayedPages.map((index) => (
                <article
                  key={index}
                  ref={continuousView ? continuousVirtualizer.measureElement : undefined}
                  data-index={continuousVirtualIndexByPage.get(index) ?? index}
                  data-page-index={index}
                  className={`${index === pageIndex ? 'is-current' : ''}${effectiveViewMode === 'spread' ? ' is-spread-page' : ''}${effectiveViewMode === 'spread' && comicSpreads[comicSpreadForPage(comicSpreads, pageIndex)]?.widePage === index ? ' is-double-page' : ''}`}
                  style={
                    continuousView
                      ? ({
                          transform: `translateY(${
                            continuousItems.find((item) => item.index === continuousVirtualIndexByPage.get(index))
                              ?.start ?? 0
                          }px)`,
                          ...(seamlessContinuousView
                            ? {
                                height: estimateContinuousPageSize(index),
                                '--fixed-doc-seamless-page-width': `${seamlessContinuousPageWidth(index)}px`,
                              }
                            : {}),
                        } as CSSProperties)
                      : undefined
                  }
                  aria-label={`${index + 1}페이지`}
                  onClick={index !== pageIndex ? () => goToPage(index) : undefined}
                >
                  {novel.format === 'pdf' && pdfPages.get(index) ? (
                    <PdfCanvas
                      page={pdfPages.get(index)}
                      fit={fit}
                      zoom={zoom}
                      rotation={rotation}
                      availableWidth={Math.max(240, viewportSize.width - 72)}
                      availableHeight={Math.max(320, viewportSize.height - 72)}
                      pageIndex={index}
                      textBlocks={textBlocksByPage.get(index)}
                      selectionEnabled={selectionMode}
                      searchQuery={searchOpen ? searchQuery : ''}
                      annotations={documentAnnotations.filter((annotation) => annotation.pageIndex === index)}
                      onTextSelection={setPendingTextSelection}
                      regionSelectionEnabled={regionMode}
                      onRegionSelection={setPendingRegionSelection}
                      activeRange={
                        listeningPosition?.anchor.kind === 'fixed_text'
                          ? {
                              blockId: listeningPosition.anchor.blockId,
                              startOffset: listeningPosition.anchor.startOffset,
                              endOffset: listeningPosition.anchor.endOffset,
                            }
                          : undefined
                      }
                    />
                  ) : novel.format === 'pdf' ? (
                    <div className="fixed-doc-page-loading">{index + 1}페이지 불러오는 중</div>
                  ) : imageUrls.get(index) ? (
                    <img
                      src={imageUrls.get(index)}
                      alt={`${novel.title} ${index + 1}페이지`}
                      draggable={false}
                      onLoad={(event) => recordArchiveImageDimensions(index, event.currentTarget)}
                      style={
                        comicProfile.crop === 'auto' && comicProfile.pageCrops?.[String(index)]
                          ? ({
                              '--fixed-doc-crop-top': `${comicProfile.pageCrops[String(index)].top * 100}%`,
                              '--fixed-doc-crop-right': `${comicProfile.pageCrops[String(index)].right * 100}%`,
                              '--fixed-doc-crop-bottom': `${comicProfile.pageCrops[String(index)].bottom * 100}%`,
                              '--fixed-doc-crop-left': `${comicProfile.pageCrops[String(index)].left * 100}%`,
                              '--fixed-doc-crop-scale': comicCropRefitScale(comicProfile.pageCrops[String(index)], fit),
                            } as CSSProperties)
                          : undefined
                      }
                    />
                  ) : (
                    <div
                      className="fixed-doc-page-loading"
                      style={seamlessContinuousView ? { height: estimateContinuousPageSize(index) } : undefined}
                    >
                      {index + 1}페이지 불러오는 중
                    </div>
                  )}
                </article>
              ))}
              {continuousView && currentDocumentSection && (
                <div
                  className="fixed-doc-section-footer"
                  style={{
                    height: continuousSectionFooterHeight,
                    transform: `translateY(${continuousVirtualizer.getTotalSize()}px)`,
                  }}
                >
                  <nav className="fixed-doc-section-nav" aria-label="만화 회차 이동">
                    <button
                      type="button"
                      disabled={!previousDocumentSection}
                      onClick={() => {
                        if (previousDocumentSection) goToPage(previousDocumentSection.startPageIndex);
                      }}
                    >
                      <ChevronLeft size={16} /> 이전 회차
                    </button>
                    <button
                      type="button"
                      disabled={!nextDocumentSection}
                      onClick={() => {
                        if (nextDocumentSection) goToPage(nextDocumentSection.startPageIndex);
                      }}
                    >
                      다음 회차 <ChevronRight size={16} />
                    </button>
                  </nav>
                  {nextDocumentSection && (
                    <div
                      className={`fixed-doc-next-section-boundary${scrollSectionBoundary.armed ? ' is-armed' : ''}`}
                      aria-live="polite"
                    >
                      <span>다음 회차</span>
                      <strong>{nextDocumentSection.title}</strong>
                      <small>{scrollSectionBoundary.armed ? '한 번 더 아래로 스크롤' : '마지막까지 읽었습니다'}</small>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className="fixed-doc-turn is-previous"
            onClick={() => turnPage(leftTurnStep)}
            disabled={!canTurn(leftTurnStep)}
            aria-label={leftTurnStep === 1 ? '다음 페이지' : '이전 페이지'}
          >
            <ChevronLeft size={28} />
          </button>
          <button
            type="button"
            className="fixed-doc-turn is-next"
            onClick={() => turnPage(rightTurnStep)}
            disabled={!canTurn(rightTurnStep)}
            aria-label={rightTurnStep === 1 ? '다음 페이지' : '이전 페이지'}
          >
            <ChevronRight size={28} />
          </button>
        </section>
      </div>
      {mobileMenuOpen && (
        <aside
          id="fixed-doc-mobile-menu"
          className="fixed-doc-search-panel fixed-doc-mobile-menu"
          aria-label="모바일 문서 메뉴"
        >
          <header>
            <h3>문서 보기</h3>
            <button type="button" onClick={() => setMobileMenuOpen(false)} aria-label="문서 메뉴 닫기">
              <X size={16} />
            </button>
          </header>
          <div className="fixed-doc-mobile-actions">
            <button
              type="button"
              onClick={() => {
                setSidebarOpen(true);
                setMobileThumbnailOpen(true);
                setMobileMenuOpen(false);
              }}
            >
              <PanelLeftOpen size={16} /> 페이지 목록
            </button>
            {novel.format !== 'image_archive' && (
              <button
                type="button"
                onClick={() => {
                  preserveFocalPoint(() => setViewMode((mode) => (mode === 'single' ? 'continuous' : 'single')));
                  setMobileMenuOpen(false);
                }}
              >
                <Columns3 size={16} /> 보기 전환
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                preserveFocalPoint(() => {
                  setFit('page');
                  setZoom(1);
                });
                if (novel.format === 'image_archive') updateComicProfile({ fit: 'page' });
                setMobileMenuOpen(false);
              }}
            >
              <Maximize2 size={16} /> 페이지 맞춤
            </button>
            <button
              type="button"
              onClick={() => {
                preserveFocalPoint(() => {
                  setFit('width');
                  setZoom(1);
                });
                if (novel.format === 'image_archive') updateComicProfile({ fit: 'width' });
                setMobileMenuOpen(false);
              }}
            >
              <Expand size={16} /> 너비 맞춤
            </button>
            <button
              type="button"
              onClick={() => {
                preserveFocalPoint(() => setRotation((value) => (value + 90) % 360));
                setMobileMenuOpen(false);
              }}
            >
              <RotateCw size={16} /> 회전
            </button>
            <button
              type="button"
              onClick={() => {
                toggleImmersive();
                setMobileMenuOpen(false);
              }}
            >
              <Focus size={16} /> 몰입 모드
            </button>
            {novel.format !== 'image_archive' && (
              <button
                type="button"
                onClick={() => {
                  void toggleFullscreen();
                  setMobileMenuOpen(false);
                }}
              >
                {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                {fullscreen ? '전체 화면 종료' : '전체 화면'}
              </button>
            )}
            {novel.format === 'pdf' && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setSearchOpen(true);
                    setAnnotationOpen(false);
                    setMobileMenuOpen(false);
                  }}
                >
                  <Search size={16} /> 본문 검색·OCR
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectionMode(true);
                    setRegionMode(false);
                    setMobileMenuOpen(false);
                  }}
                >
                  <TextCursorInput size={16} /> 텍스트 선택
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRegionMode(true);
                    setSelectionMode(false);
                    setPendingTextSelection(undefined);
                    window.getSelection()?.removeAllRanges();
                    setMobileMenuOpen(false);
                  }}
                >
                  <Highlighter size={16} /> 영역 하이라이트·메모
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void togglePageBookmark();
                    setMobileMenuOpen(false);
                  }}
                >
                  <Bookmark size={16} fill={currentPageBookmarked ? 'currentColor' : 'none'} />
                  {currentPageBookmarked ? '현재 북마크 해제' : '현재 페이지 북마크'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnnotationOpen(true);
                    setSearchOpen(false);
                    setMobileMenuOpen(false);
                  }}
                >
                  <StickyNote size={16} /> 북마크·메모
                </button>
                <button
                  type="button"
                  disabled={!textBlocksByPage.get(pageIndex)?.length}
                  onClick={() => {
                    void onStartListening?.(pageIndex);
                    setMobileMenuOpen(false);
                  }}
                >
                  <Play size={16} /> 현재 페이지부터 듣기
                </button>
                {onPrepareListening && (
                  <button
                    type="button"
                    onClick={() => {
                      setListeningRangeStart(pageIndex + 1);
                      setListeningRangeEnd(Math.min(totalPages, pageIndex + 10));
                      setListeningPreparationOpen(true);
                      setMobileMenuOpen(false);
                    }}
                  >
                    <Download size={16} /> 오프라인 음성 준비
                  </button>
                )}
              </>
            )}
          </div>
        </aside>
      )}
      {pendingTextSelection && (
        <aside className="fixed-doc-selection-toolbar" aria-label="선택한 PDF 텍스트 작업">
          <span title={pendingTextSelection.quote}>{pendingTextSelection.quote}</span>
          {reanchorTargetId ? (
            <button
              type="button"
              onClick={() => void manuallyReanchorAnnotation()}
              disabled={
                documentAnnotations.find((annotation) => annotation.id === reanchorTargetId)?.pageIndex !==
                pendingTextSelection.pageIndex
              }
            >
              <TextCursorInput size={15} />
              {documentAnnotations.find((annotation) => annotation.id === reanchorTargetId)?.pageIndex ===
              pendingTextSelection.pageIndex
                ? '기존 주석에 다시 연결'
                : '원래 페이지에서 선택하세요'}
            </button>
          ) : (
            <>
              <button type="button" onClick={() => void saveTextAnnotation('text_highlight')}>
                <Highlighter size={15} /> 하이라이트
              </button>
              <button
                type="button"
                onClick={() => {
                  const first = pendingTextSelection.ranges[0];
                  if (!first) return;
                  setPendingTextSelection(undefined);
                  window.getSelection()?.removeAllRanges();
                  void onStartListening?.(pendingTextSelection.pageIndex, first.block.id, first.startOffset);
                }}
              >
                <Play size={15} /> 여기부터 듣기
              </button>
              <label>
                <StickyNote size={15} aria-hidden="true" />
                <input
                  value={selectionNoteDraft}
                  onChange={(event) => setSelectionNoteDraft(event.target.value)}
                  placeholder="메모 (선택)"
                  aria-label="선택한 텍스트 메모"
                />
              </label>
              <button type="button" onClick={() => void saveTextAnnotation('text_note')}>
                메모 저장
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setPendingTextSelection(undefined);
              setReanchorTargetId(undefined);
              window.getSelection()?.removeAllRanges();
            }}
            aria-label="선택 작업 닫기"
          >
            <X size={15} />
          </button>
        </aside>
      )}
      {reanchorTargetId && !pendingTextSelection && (
        <aside className="fixed-doc-selection-toolbar" aria-label="PDF 주석 다시 연결">
          <span>기존 주석의 새 위치가 될 텍스트를 선택하세요.</span>
          <button
            type="button"
            onClick={() => {
              setReanchorTargetId(undefined);
              setSelectionMode(false);
              window.getSelection()?.removeAllRanges();
            }}
          >
            다시 연결 취소
          </button>
        </aside>
      )}
      {pendingRegionSelection && (
        <aside className="fixed-doc-selection-toolbar" aria-label="선택한 PDF 영역 작업">
          <span>{pendingRegionSelection.pageIndex + 1}페이지 영역</span>
          <button type="button" onClick={() => void saveRegionAnnotation('region_highlight')}>
            <Highlighter size={15} /> 하이라이트
          </button>
          <label>
            <StickyNote size={15} aria-hidden="true" />
            <input
              value={regionNoteDraft}
              onChange={(event) => setRegionNoteDraft(event.target.value)}
              placeholder="영역 메모 (선택)"
              aria-label="선택한 영역 메모"
            />
          </label>
          <button type="button" onClick={() => void saveRegionAnnotation('region_note')}>
            메모 저장
          </button>
          <button type="button" onClick={() => setPendingRegionSelection(undefined)} aria-label="영역 작업 닫기">
            <X size={15} />
          </button>
        </aside>
      )}
      {listeningPreparationOpen && novel.format === 'pdf' && onPrepareListening && (
        <aside className="fixed-doc-search-panel fixed-doc-listening-panel" aria-label="PDF 오프라인 음성 준비">
          <header>
            <h3>오프라인 음성 준비</h3>
            <button
              type="button"
              onClick={() => setListeningPreparationOpen(false)}
              aria-label="오프라인 음성 준비 닫기"
            >
              <X size={16} />
            </button>
          </header>
          <p>본문 또는 OCR이 준비된 페이지만 저장합니다. 한 번에 최대 50페이지를 처리합니다.</p>
          <div className="fixed-doc-listening-range">
            <label>
              <span>시작</span>
              <input
                type="number"
                min={1}
                max={totalPages}
                value={listeningRangeStart}
                onChange={(event) => setListeningRangeStart(clampPage(Number(event.target.value) - 1, totalPages) + 1)}
              />
            </label>
            <span>–</span>
            <label>
              <span>끝</span>
              <input
                type="number"
                min={1}
                max={totalPages}
                value={listeningRangeEnd}
                onChange={(event) => setListeningRangeEnd(clampPage(Number(event.target.value) - 1, totalPages) + 1)}
              />
            </label>
          </div>
          <div className="fixed-doc-listening-actions">
            {listeningPreparationBusy ? (
              <button type="button" className="is-cancel" onClick={onCancelListeningPreparation}>
                준비 취소
              </button>
            ) : (
              <>
                <button type="button" onClick={() => void onPrepareListening(pageIndex, pageIndex)}>
                  현재 페이지
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void onPrepareListening(
                      Math.min(listeningRangeStart, listeningRangeEnd) - 1,
                      Math.min(
                        totalPages,
                        Math.min(listeningRangeStart, listeningRangeEnd) + 49,
                        Math.max(listeningRangeStart, listeningRangeEnd),
                      ) - 1,
                    )
                  }
                >
                  선택 범위 준비
                </button>
              </>
            )}
          </div>
        </aside>
      )}
      {comicSettingsOpen && novel.format === 'image_archive' && (
        <aside className="fixed-doc-search-panel fixed-doc-comic-panel" aria-label="만화 보기 설정">
          <header>
            <h3>만화 보기</h3>
            <button type="button" onClick={() => setComicSettingsOpen(false)} aria-label="만화 보기 설정 닫기">
              <X size={16} />
            </button>
          </header>
          <div className="fixed-doc-comic-settings">
            <label>
              <span>조판</span>
              <select
                value={viewMode}
                onChange={(event) => {
                  const next = event.target.value as ViewMode;
                  preserveFocalPoint(() => {
                    setViewMode(next);
                    if (next === 'continuous-seamless') setZoom(1);
                  });
                  updateComicProfile({
                    mode: comicViewModeToProfileMode(next),
                    seamlessVertical: next === 'continuous-seamless',
                  });
                }}
              >
                <option value="single">한 페이지</option>
                <option value="spread">양면</option>
                <option value="continuous">세로 연속</option>
                <option value="continuous-seamless">경계 없는 세로 연속</option>
              </select>
            </label>
            {viewMode === 'spread' && viewportSize.width < 720 && (
              <p>좁은 화면에서는 페이지가 잘리지 않도록 한 페이지로 표시합니다.</p>
            )}
            <label>
              <span>화면 맞춤</span>
              <select
                value={comicProfile.fit}
                onChange={(event) => {
                  const next = event.target.value as FitMode;
                  preserveFocalPoint(() => {
                    setFit(next);
                    setZoom(1);
                  });
                  updateComicProfile({ fit: next });
                }}
              >
                <option value="page">페이지 전체</option>
                <option value="width">너비</option>
                <option value="height">높이</option>
                <option value="original">원본 크기</option>
              </select>
            </label>
            <label>
              <span>읽는 방향</span>
              <select
                value={comicProfile.direction}
                onChange={(event) => updateComicProfile({ direction: event.target.value as 'ltr' | 'rtl' })}
              >
                <option value="ltr">왼쪽 → 오른쪽</option>
                <option value="rtl">오른쪽 → 왼쪽 (만화)</option>
              </select>
            </label>
            <label>
              <span>표지</span>
              <select
                value={comicProfile.coverBehavior}
                onChange={(event) =>
                  updateComicProfile({ coverBehavior: event.target.value as ComicReadingProfile['coverBehavior'] })
                }
              >
                <option value="single">첫 페이지 단독</option>
                <option value="paired">첫 페이지부터 양면</option>
              </select>
            </label>
            <label>
              <span>첫 페이지 면</span>
              <select
                value={comicProfile.pageParity}
                onChange={(event) =>
                  updateComicProfile({ pageParity: event.target.value as ComicReadingProfile['pageParity'] })
                }
              >
                <option value="auto">방향에 맞게 자동</option>
                <option value="left">왼쪽</option>
                <option value="right">오른쪽</option>
              </select>
            </label>
            <fieldset>
              <legend>여백 자르기</legend>
              <label>
                <span>방식</span>
                <select
                  value={comicProfile.crop}
                  onChange={(event) => updateComicProfile({ crop: event.target.value as ComicReadingProfile['crop'] })}
                >
                  <option value="off">사용 안 함</option>
                  <option value="manual">공통 여백 직접 지정</option>
                  <option value="auto">페이지별 자동 감지</option>
                </select>
              </label>
              {comicProfile.crop === 'auto' && (
                <div className="fixed-doc-comic-crop-action">
                  {comicCropProgress ? (
                    <>
                      <span role="status" aria-live="polite">
                        {comicCropProgress.current}/{comicCropProgress.total}페이지 · 감지 {comicCropProgress.detected}
                      </span>
                      <button type="button" onClick={() => comicCropControllerRef.current?.abort()}>
                        취소
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => void autoCropPages([pageIndex])}>
                        {comicProfile.pageCrops?.[String(pageIndex)]
                          ? '현재 페이지 다시 감지'
                          : '현재 페이지 여백 감지'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void autoCropPages(Array.from({ length: totalPages }, (_, index) => index))}
                      >
                        전체 {totalPages.toLocaleString()}페이지 감지
                      </button>
                    </>
                  )}
                  {comicCropStatus === 'failed' && (
                    <span>
                      {comicCropFailedPages > 0
                        ? `${comicCropFailedPages}페이지는 경계를 찾지 못했습니다. 기존 결과는 유지됩니다.`
                        : '여백 분석을 완료하지 못했습니다.'}
                    </span>
                  )}
                </div>
              )}
              {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                <label key={side}>
                  <span>{{ top: '위', right: '오른쪽', bottom: '아래', left: '왼쪽' }[side]}</span>
                  <input
                    type="range"
                    min="0"
                    max="20"
                    step="1"
                    value={Math.round((comicProfile.manualCrop?.[side] ?? 0) * 100)}
                    disabled={comicProfile.crop !== 'manual'}
                    onChange={(event) =>
                      updateComicProfile({
                        manualCrop: {
                          ...(comicProfile.manualCrop ?? DEFAULT_COMIC_READING_PROFILE.manualCrop!),
                          [side]: Number(event.target.value) / 100,
                        },
                      })
                    }
                  />
                  <output>{Math.round((comicProfile.manualCrop?.[side] ?? 0) * 100)}%</output>
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>화면 보정</legend>
              {(
                [
                  ['brightness', '밝기', 40, 180],
                  ['contrast', '대비', 40, 200],
                  ['saturation', '채도', 0, 200],
                ] as const
              ).map(([key, label, minimum, maximum]) => (
                <label key={key}>
                  <span>{label}</span>
                  <input
                    type="range"
                    min={minimum}
                    max={maximum}
                    value={Math.round(comicProfile[key] * 100)}
                    onChange={(event) => updateComicProfile({ [key]: Number(event.target.value) / 100 })}
                  />
                  <output>{Math.round(comicProfile[key] * 100)}%</output>
                </label>
              ))}
              <label>
                <span>흑백</span>
                <input
                  type="checkbox"
                  checked={comicProfile.grayscale}
                  onChange={(event) => updateComicProfile({ grayscale: event.target.checked })}
                />
              </label>
              <label>
                <span>색상 반전</span>
                <input
                  type="checkbox"
                  checked={comicProfile.invert}
                  onChange={(event) => updateComicProfile({ invert: event.target.checked })}
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  updateComicProfile({ brightness: 1, contrast: 1, saturation: 1, grayscale: false, invert: false })
                }
              >
                보정 초기화
              </button>
            </fieldset>
          </div>
        </aside>
      )}
      {annotationOpen && novel.format === 'pdf' && (
        <aside className="fixed-doc-search-panel fixed-doc-annotation-panel" aria-label="PDF 북마크와 메모">
          <header>
            <h3>북마크·표시</h3>
            <button type="button" onClick={() => setAnnotationOpen(false)} aria-label="북마크와 메모 닫기">
              <X size={16} />
            </button>
          </header>
          {documentAnnotations.length === 0 ? (
            <p className="fixed-doc-search-empty">저장한 북마크나 표시가 없습니다.</p>
          ) : (
            <div className="fixed-doc-annotation-list">
              {documentAnnotations.map((annotation) => (
                <div
                  key={annotation.id}
                  className={annotation.textAnchorRemap?.status === 'needs_review' ? 'has-reanchor' : undefined}
                >
                  <button
                    type="button"
                    className={
                      `${annotation.pageIndex === pageIndex ? 'is-active' : ''}${annotation.textAnchorRemap?.status === 'needs_review' ? ' is-remap-review' : ''}`.trim() ||
                      undefined
                    }
                    onClick={() => goToPage(annotation.pageIndex)}
                  >
                    <span>
                      {annotation.type === 'page_bookmark'
                        ? '북마크'
                        : annotation.type.includes('note')
                          ? '메모'
                          : '하이라이트'}{' '}
                      · {annotation.pageIndex + 1}페이지
                    </span>
                    <strong>{annotation.body || annotation.quote || `${annotation.pageIndex + 1}페이지`}</strong>
                  </button>
                  {annotation.textAnchorRemap?.status === 'needs_review' && annotation.anchor.kind === 'fixed_text' && (
                    <button
                      type="button"
                      className="is-reanchor"
                      onClick={() => {
                        goToPage(annotation.pageIndex);
                        setReanchorTargetId(annotation.id);
                        setSelectionMode(true);
                        setRegionMode(false);
                        setPendingTextSelection(undefined);
                        setAnnotationOpen(false);
                        window.getSelection()?.removeAllRanges();
                      }}
                      aria-label={`${annotation.pageIndex + 1}페이지 주석 다시 연결`}
                      title="새 텍스트 위치 선택"
                    >
                      <TextCursorInput size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void removeDocumentAnnotation(annotation.id)}
                    aria-label={`${annotation.pageIndex + 1}페이지 표시 삭제`}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>
      )}
      {searchOpen && novel.format === 'pdf' && (
        <aside
          className={`fixed-doc-search-panel${readingOrderOpen ? ' is-reading-order' : ''}`}
          aria-label="PDF 본문 검색"
        >
          <header>
            <label>
              <Search size={15} aria-hidden="true" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="PDF 본문 검색"
                aria-label="PDF 본문 검색어"
              />
            </label>
            <button type="button" onClick={() => setSearchOpen(false)} aria-label="검색 닫기">
              <X size={16} />
            </button>
          </header>
          <div className="fixed-doc-search-coverage">
            <span>
              검색 가능 {readyTextPages.toLocaleString()} / {totalPages.toLocaleString()}페이지
            </span>
            {textIndexProgress ? (
              <button type="button" onClick={() => textIndexControllerRef.current?.abort()}>
                준비 중 {textIndexProgress.current}/{textIndexProgress.total} · 취소
              </button>
            ) : readyTextPages < totalPages ? (
              <button type="button" onClick={() => void indexAllPdfText()}>
                전체 텍스트 준비
              </button>
            ) : null}
          </div>
          <button
            className="fixed-doc-reading-order-entry"
            type="button"
            onClick={() => void openReadingOrderEditor()}
            disabled={readingOrderStatus === 'loading' || readingOrderStatus === 'saving'}
          >
            <ListOrdered size={15} aria-hidden="true" />
            <span>
              <strong>현재 페이지 읽기 순서</strong>
              <small>검색·복사·TTS에 공통 적용</small>
            </span>
          </button>
          {readingOrderOpen && (
            <section className="fixed-doc-reading-order" aria-label="현재 페이지 읽기 순서 교정">
              <header>
                <div>
                  <strong>{pageIndex + 1}페이지 읽기 순서</strong>
                  <span>위에서 아래로 재생됩니다. 머리말·꼬리말은 제외할 수 있습니다.</span>
                </div>
                <button type="button" onClick={() => setReadingOrderOpen(false)} aria-label="읽기 순서 닫기">
                  <X size={15} />
                </button>
              </header>
              {readingOrderStatus === 'loading' ? (
                <p aria-live="polite">텍스트 블록을 불러오는 중…</p>
              ) : readingOrderBlocks.length > 0 ? (
                <div className="fixed-doc-reading-order-list">
                  {readingOrderBlocks.map((block, index) => {
                    const excluded = readingOrderExcludedIds.has(block.id);
                    return (
                      <article key={block.id} className={excluded ? 'is-excluded' : undefined}>
                        <span>{index + 1}</span>
                        <div>
                          <small>{block.role.replace('_', ' ')}</small>
                          <strong>{block.text.replace(/\s+/g, ' ').trim() || '(빈 블록)'}</strong>
                        </div>
                        <nav aria-label={`${index + 1}번 블록 순서 조정`}>
                          <button
                            type="button"
                            onClick={() => moveReadingOrderBlock(index, -1)}
                            disabled={index === 0}
                            aria-label="한 칸 위로"
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveReadingOrderBlock(index, 1)}
                            disabled={index === readingOrderBlocks.length - 1}
                            aria-label="한 칸 아래로"
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            type="button"
                            className={excluded ? 'is-active' : undefined}
                            onClick={() => toggleReadingOrderExcluded(block.id)}
                            aria-label={excluded ? '읽기 순서에 다시 포함' : '검색과 TTS에서 제외'}
                            aria-pressed={excluded}
                          >
                            <EyeOff size={14} />
                          </button>
                        </nav>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p aria-live="polite">{readingOrderError || '교정할 텍스트 블록이 없습니다.'}</p>
              )}
              {readingOrderError && readingOrderBlocks.length > 0 && <p role="alert">{readingOrderError}</p>}
              <footer>
                <button
                  type="button"
                  onClick={() => void resetReadingOrder()}
                  disabled={!readingOrderRevision || readingOrderStatus === 'saving'}
                >
                  자동 순서로 초기화
                </button>
                <button type="button" onClick={() => setReadingOrderOpen(false)}>
                  취소
                </button>
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => void saveReadingOrder()}
                  disabled={!readingOrderRevision || readingOrderStatus === 'saving'}
                >
                  {readingOrderStatus === 'saving' ? '저장 중…' : '적용'}
                </button>
              </footer>
            </section>
          )}
          <div className="fixed-doc-ocr-range">
            <div>
              <label>
                <span>OCR 시작</span>
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={ocrRangeStart}
                  onChange={(event) => setOcrRangeStart(clampPage(Number(event.target.value) - 1, totalPages) + 1)}
                />
              </label>
              <span>–</span>
              <label>
                <span>끝</span>
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={ocrRangeEnd}
                  onChange={(event) => setOcrRangeEnd(clampPage(Number(event.target.value) - 1, totalPages) + 1)}
                />
              </label>
            </div>
            <select
              value={ocrLanguage}
              onChange={(event) => setOcrLanguage(event.target.value)}
              aria-label="범위 OCR 언어"
            >
              <option value="kor+eng">한국어 + 영어</option>
              <option value="jpn+eng">일본어 + 영어</option>
              <option value="eng">영어</option>
            </select>
            <button
              type="button"
              onClick={() => void runOcrRange()}
              disabled={Boolean(textIndexProgress || ocrProgress)}
            >
              낮은 품질 페이지만 범위 OCR
            </button>
            {ocrWorkerLanguage && !ocrProgress && (
              <button type="button" onClick={() => void unloadOcrWorker()}>
                OCR 메모리 해제 · {ocrWorkerLanguage}
              </button>
            )}
          </div>
          <section className="fixed-doc-ocr-models" aria-labelledby="fixed-doc-ocr-models-title">
            <header>
              <div>
                <strong id="fixed-doc-ocr-models-title">OCR 언어 데이터</strong>
                <span>인식할 때 내려받아 이 기기에 보관합니다.</span>
              </div>
              <button
                type="button"
                onClick={() => void refreshOcrModelCache()}
                disabled={ocrModelCacheStatus === 'loading' || Boolean(ocrProgress)}
              >
                새로고침
              </button>
            </header>
            {ocrModelCacheStatus === 'loading' ? (
              <p aria-live="polite">저장 상태 확인 중…</p>
            ) : ocrModelCacheStatus === 'failed' ? (
              <p role="alert">{ocrModelCacheError}</p>
            ) : ocrModelCache.some((entry) => entry.installed) ? (
              <ul>
                {ocrModelCache
                  .filter((entry) => entry.installed)
                  .map((entry) => (
                    <li key={entry.language}>
                      <span>
                        <strong>{OCR_LANGUAGE_LABELS[entry.language]}</strong>
                        <small>{formatStoredBytes(entry.byteLength)}</small>
                      </span>
                      <button
                        type="button"
                        onClick={() => void removeOcrModel(entry.language)}
                        disabled={Boolean(ocrProgress)}
                        aria-label={`${OCR_LANGUAGE_LABELS[entry.language]} OCR 언어 데이터 삭제`}
                      >
                        삭제
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <p>아직 내려받은 언어 데이터가 없습니다.</p>
            )}
            <span className="fixed-doc-ocr-models-supported">
              지원 언어 · {OCR_LANGUAGE_MODELS.map((language) => OCR_LANGUAGE_LABELS[language]).join(' / ')}
            </span>
          </section>
          {(textPageStates.get(pageIndex) === 'ocr_candidate' ||
            textPageStates.get(pageIndex) === 'failed' ||
            ocrProgress ||
            ocrError) && (
            <div className="fixed-doc-ocr-notice">
              {ocrProgress ? (
                <>
                  <span>
                    OCR {ocrProgress.current}/{ocrProgress.total} · {ocrProgress.pageIndex + 1}페이지 ·{' '}
                    {Math.round(ocrProgress.progress * 100)}%
                  </span>
                  <button type="button" onClick={() => ocrControllerRef.current?.abort()}>
                    취소
                  </button>
                </>
              ) : (
                <>
                  <span>{ocrError || '현재 페이지는 native text 품질이 낮아 OCR이 필요합니다.'}</span>
                  <select
                    value={ocrLanguage}
                    onChange={(event) => setOcrLanguage(event.target.value)}
                    aria-label="OCR 언어"
                  >
                    <option value="kor+eng">한국어 + 영어</option>
                    <option value="jpn+eng">일본어 + 영어</option>
                    <option value="eng">영어</option>
                  </select>
                  <button type="button" onClick={() => void runOcrPages([pageIndex])}>
                    모델 내려받고 현재 페이지 인식
                  </button>
                  {ocrCandidatePages.length > 1 && (
                    <button type="button" onClick={() => void runOcrPages(ocrCandidatePages)}>
                      후보 {ocrCandidatePages.length}페이지 인식
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {searchStatus === 'loading' ? (
            <p className="fixed-doc-search-empty">검색 중…</p>
          ) : searchStatus === 'failed' ? (
            <p className="fixed-doc-search-empty">검색하지 못했습니다.</p>
          ) : searchQuery.trim() && searchResults.length === 0 ? (
            <p className="fixed-doc-search-empty">준비된 페이지에서 결과가 없습니다.</p>
          ) : searchResults.length > 0 ? (
            <>
              <nav className="fixed-doc-search-nav" aria-label="검색 결과 이동">
                <button type="button" onClick={() => jumpToSearchResult(searchCursor - 1)}>
                  이전
                </button>
                <span>
                  {searchCursor + 1} / {searchResults.length}
                </span>
                <button type="button" onClick={() => jumpToSearchResult(searchCursor + 1)}>
                  다음
                </button>
              </nav>
              <div className="fixed-doc-search-results">
                {searchResults.map((result, index) => (
                  <button
                    key={`${result.revisionId}:${result.blockId}:${result.startOffset}`}
                    type="button"
                    className={index === searchCursor ? 'is-active' : undefined}
                    onClick={() => jumpToSearchResult(index)}
                  >
                    <span>{result.pageIndex + 1}페이지</span>
                    <strong>{result.text}</strong>
                    {result.source === 'ocr' && <em>OCR</em>}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="fixed-doc-search-empty">검색어를 입력하세요.</p>
          )}
        </aside>
      )}
      <footer className="fixed-doc-footer">
        <span>
          {pageIndex + 1} / {totalPages}
        </span>
        <div>
          <i style={{ width: `${progressPercent}%` }} />
        </div>
        <span>{Math.round(progressPercent)}%</span>
      </footer>
    </main>
  );
}
