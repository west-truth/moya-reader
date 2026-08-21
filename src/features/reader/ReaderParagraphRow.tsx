import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Character, LabeledSegment, Paragraph } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { decorateReaderText } from '../../reader/text-decorations';
import type { ReaderDecorationStore } from './reader-decoration-store';
import type { ReaderMode } from './reader-screen-contract';

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function segmentTypeLabel(segment: Pick<LabeledSegment, 'type'>): string {
  if (segment.type === 'narration') return '서술';
  if (segment.type === 'quoted_dialogue' || segment.type === 'plain_dialogue') return '대사';
  if (segment.type === 'inner_monologue') return '독백';
  if (segment.type === 'sfx') return '효과음';
  return '기타';
}

function speakerLabel(segment: LabeledSegment, characters: readonly Character[]): string {
  if (segment.speakerId === 'narrator') return '내레이터';
  if (segment.speakerId === 'system') return '시스템';
  if (segment.speakerId === 'unknown') return '화자 미확정';
  return characters.find((character) => character.id === segment.speakerId)?.canonicalName ?? segment.speakerId;
}

export interface ReaderParagraphRowProps {
  readonly paragraph: Paragraph;
  readonly virtualIndex: number;
  readonly start: number;
  readonly isSpeaking: boolean;
  readonly mode: ReaderMode;
  readonly searchQuery: string;
  readonly decorationStore: ReaderDecorationStore;
  readonly measureElement: (element: Element | null) => void;
  readonly onSelectCorrectionSegment: (segmentId: string) => void;
  readonly assetRepository?: BookAssetRepository;
  readonly onDocumentLink?: (href: string, footnote: boolean) => void;
  readonly staticLayout?: boolean;
  readonly sourceOffset?: number;
}

function EpubImage({
  repository,
  bookId,
  assetId,
  alt,
}: {
  repository?: BookAssetRepository;
  bookId: string;
  assetId?: string;
  alt: string;
}) {
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setSource(undefined);
    setFailed(false);
    if (!repository || !assetId) {
      setFailed(true);
      return;
    }
    void repository
      .getEmbeddedResource(bookId, assetId)
      .then((resource) => {
        if (!active || !resource) {
          if (active) setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(resource.blob);
        setSource(objectUrl);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, bookId, repository]);
  if (failed) return <div className="reader-image-placeholder">{alt || '이미지를 표시할 수 없습니다.'}</div>;
  if (!source) return <div className="reader-image-placeholder is-loading" aria-label="이미지 불러오는 중" />;
  return <img className="reader-epub-image" src={source} alt={alt} onError={() => setFailed(true)} />;
}

function InlineEpubText({
  paragraph,
  onLink,
}: {
  paragraph: Paragraph;
  onLink: (href: string, footnote: boolean) => void;
}): ReactNode {
  const marks = paragraph.inlineMarks ?? [];
  const semantics = paragraph.inlineSemantics ?? [];
  if (marks.length === 0 && semantics.length === 0) return paragraph.text;
  const boundaries = new Set([0, paragraph.text.length]);
  marks.forEach((mark) => {
    boundaries.add(Math.max(0, Math.min(paragraph.text.length, mark.start)));
    boundaries.add(Math.max(0, Math.min(paragraph.text.length, mark.end)));
  });
  semantics.forEach((semantic) => {
    boundaries.add(Math.max(0, Math.min(paragraph.text.length, semantic.start)));
    boundaries.add(Math.max(0, Math.min(paragraph.text.length, semantic.end)));
  });
  const points = [...boundaries].sort((left, right) => left - right);
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1];
    const text = paragraph.text.slice(start, end);
    const active = marks.filter((mark) => mark.start <= start && mark.end >= end);
    const activeSemantics = semantics.filter((semantic) => semantic.start <= start && semantic.end >= end);
    let node: ReactNode = text;
    const ruby = activeSemantics.find((semantic) => semantic.kind === 'ruby' && semantic.value);
    if (ruby?.value) {
      node = (
        <ruby>
          {node}
          <rt>{ruby.value}</rt>
        </ruby>
      );
    }
    if (active.some((mark) => mark.kind === 'strong')) node = <strong>{node}</strong>;
    if (active.some((mark) => mark.kind === 'emphasis')) node = <em>{node}</em>;
    const language = activeSemantics.find((semantic) => semantic.kind === 'language' && semantic.value)?.value;
    if (language) node = <span lang={language}>{node}</span>;
    const link = active.find((mark) => mark.kind === 'link' && mark.href);
    const footnote = activeSemantics.some((semantic) => semantic.kind === 'footnote_reference');
    if (link?.href) {
      node = (
        <a
          href={link.href}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onLink(link.href!, footnote);
          }}
        >
          {node}
        </a>
      );
    }
    return <span key={`${start}:${end}`}>{node}</span>;
  });
}

function ReaderParagraphRowComponent({
  paragraph,
  virtualIndex,
  start,
  isSpeaking,
  mode,
  searchQuery,
  decorationStore,
  measureElement,
  onSelectCorrectionSegment,
  assetRepository,
  onDocumentLink = () => undefined,
  staticLayout = false,
  sourceOffset = 0,
}: ReaderParagraphRowProps) {
  const subscribe = useCallback(
    (listener: () => void) => decorationStore.subscribe(paragraph.id, listener),
    [decorationStore, paragraph.id],
  );
  const getSnapshot = useCallback(() => decorationStore.getSnapshot(paragraph.id), [decorationStore, paragraph.id]);
  const decoration = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const showMeta = mode === 'analysis' || mode === 'correction';
  const needsReview = decoration.segments.some((segment) => decoration.reviewSegmentIds.has(segment.id));
  const decoratedText = decorateReaderText(
    paragraph.text,
    [...decoration.highlights],
    searchQuery,
    decoration.activeRanges.map((range) => ({ start: range.start - sourceOffset, end: range.end - sourceOffset })),
  );
  const hasInlineHighlight = decoratedText.some((part) => part.highlightColor);
  const paragraphHighlight = hasInlineHighlight ? undefined : decoration.highlights[0];
  const useDocumentInline =
    Boolean(paragraph.inlineMarks?.length || paragraph.inlineSemantics?.length) && !searchQuery && !hasInlineHighlight;
  const textContent = useMemo(
    () =>
      useDocumentInline ? (
        <InlineEpubText paragraph={paragraph} onLink={onDocumentLink} />
      ) : (
        decoratedText.map((part, index) => {
          const highlightClass = part.highlightColor
            ? classNames(
                'reader-inline-highlight',
                `inline-highlight-${part.highlightColor}`,
                part.ttsActive && 'reader-tts-active',
              )
            : part.ttsActive
              ? 'reader-tts-active'
              : undefined;
          return part.searchHit ? (
            <mark key={index} className={highlightClass}>
              {part.text}
            </mark>
          ) : (
            <span key={index} className={highlightClass}>
              {part.text}
            </span>
          );
        })
      ),
    [decoratedText, onDocumentLink, paragraph, useDocumentInline],
  );

  const documentContent = (() => {
    if (paragraph.documentKind === 'image') {
      return (
        <EpubImage
          repository={assetRepository}
          bookId={paragraph.novelId}
          assetId={paragraph.assetId}
          alt={paragraph.text}
        />
      );
    }
    if (paragraph.documentKind === 'heading') return <h2>{textContent}</h2>;
    if (paragraph.documentKind === 'blockquote') return <blockquote>{textContent}</blockquote>;
    if (paragraph.documentKind === 'list_item') return <p className="reader-list-item">{textContent}</p>;
    if (paragraph.documentKind === 'separator') return <hr />;
    return <p>{textContent}</p>;
  })();

  return (
    <div
      ref={measureElement}
      data-index={virtualIndex}
      className={classNames('reader-virtual-row', staticLayout && 'is-static')}
      style={staticLayout ? undefined : { transform: `translateY(${start}px)` }}
    >
      <div
        data-paragraph-id={paragraph.id}
        className={classNames(
          'reader-paragraph',
          isSpeaking && 'is-speaking',
          paragraphHighlight && 'has-highlight',
          paragraphHighlight && `highlight-${paragraphHighlight.color}`,
          needsReview && showMeta && 'low-confidence',
          showMeta && 'with-meta',
          sourceOffset > 0 && 'is-continuation',
        )}
        onClick={() => {
          if (mode !== 'correction' || decoration.segments.length === 0) return;
          const segment =
            decoration.segments.find((item) => decoration.reviewSegmentIds.has(item.id)) ?? decoration.segments[0];
          onSelectCorrectionSegment(segment.id);
        }}
      >
        {showMeta && decoration.segments.length > 0 && (
          <div className="segment-meta">
            {decoration.segments.map((segment) =>
              mode === 'correction' ? (
                <button
                  key={segment.id}
                  type="button"
                  className={classNames(
                    decoration.correctionTargetId === segment.id && 'active',
                    decoration.reviewSegmentIds.has(segment.id) && 'needs-review',
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectCorrectionSegment(segment.id);
                  }}
                >
                  {segmentTypeLabel(segment)} · {speakerLabel(segment, decoration.characters)} ·{' '}
                  {Math.round(segment.confidence * 100)}%
                </button>
              ) : (
                <span key={segment.id}>
                  {segmentTypeLabel(segment)} · {speakerLabel(segment, decoration.characters)} ·{' '}
                  {Math.round(segment.confidence * 100)}%
                </span>
              ),
            )}
          </div>
        )}
        {documentContent}
      </div>
    </div>
  );
}

export const ReaderParagraphRow = memo(ReaderParagraphRowComponent);
