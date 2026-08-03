import type { DocumentAnnotation, DocumentTextBlock, DocumentTextRevision } from '../../../domain/types';
import { buildFixedTextSelection } from './fixed-text-selection';

export interface FixedTextAnnotationRemapResult {
  readonly annotation: DocumentAnnotation;
  readonly changed: boolean;
}

function needsReview(
  annotation: DocumentAnnotation,
  target: DocumentTextRevision,
  now: string,
): FixedTextAnnotationRemapResult {
  if (annotation.anchor.kind !== 'fixed_text') return { annotation, changed: false };
  if (
    annotation.textAnchorRemap?.status === 'needs_review' &&
    annotation.textAnchorRemap.targetTextRevisionId === target.id
  ) {
    return { annotation, changed: false };
  }
  return {
    annotation: {
      ...annotation,
      textAnchorRemap: {
        status: 'needs_review',
        fromTextRevisionId: annotation.anchor.textRevisionId,
        targetTextRevisionId: target.id,
        updatedAt: now,
      },
      updatedAt: now,
    },
    changed: true,
  };
}

function uniqueQuoteOffset(text: string, quote: string): number | undefined {
  const first = text.indexOf(quote);
  if (first < 0 || text.indexOf(quote, first + 1) >= 0) return undefined;
  return first;
}

export function remapFixedTextAnnotation(input: {
  readonly annotation: DocumentAnnotation;
  readonly targetRevision: DocumentTextRevision;
  readonly targetBlocks: readonly DocumentTextBlock[];
  readonly now?: string;
}): FixedTextAnnotationRemapResult {
  const { annotation, targetRevision } = input;
  if (annotation.anchor.kind !== 'fixed_text' || annotation.pageIndex !== targetRevision.pageIndex) {
    return { annotation, changed: false };
  }
  if (annotation.anchor.textRevisionId === targetRevision.id) return { annotation, changed: false };
  const now = input.now ?? new Date().toISOString();
  const quote = annotation.quote;
  if (!quote) return needsReview(annotation, targetRevision, now);
  const blocks = [...input.targetBlocks].sort((left, right) => left.order - right.order);
  const spans: Array<{ block: DocumentTextBlock; start: number; end: number }> = [];
  let documentText = '';
  for (const block of blocks) {
    if (documentText) documentText += '\n';
    const start = documentText.length;
    documentText += block.text;
    spans.push({ block, start, end: documentText.length });
  }
  const matchStart = uniqueQuoteOffset(documentText, quote);
  if (matchStart === undefined) return needsReview(annotation, targetRevision, now);
  const matchEnd = matchStart + quote.length;
  const matched = spans.filter((span) => matchEnd > span.start && matchStart < span.end);
  const first = matched[0];
  const last = matched.at(-1);
  if (!first || !last) return needsReview(annotation, targetRevision, now);
  const selection = buildFixedTextSelection({
    blocks,
    startBlockId: first.block.id,
    startOffset: Math.max(0, matchStart - first.start),
    endBlockId: last.block.id,
    endOffset: Math.min(last.block.text.length, matchEnd - last.start),
  });
  const firstRange = selection?.ranges[0];
  const lastRange = selection?.ranges.at(-1);
  if (!selection || !firstRange || !lastRange) return needsReview(annotation, targetRevision, now);
  return {
    annotation: {
      ...annotation,
      anchor: {
        ...annotation.anchor,
        textRevisionId: targetRevision.id,
        blockId: firstRange.block.id,
        startOffset: firstRange.startOffset,
        endOffset: lastRange.endOffset,
        blockRanges: selection.ranges.map((range) => ({
          blockId: range.block.id,
          startOffset: range.startOffset,
          endOffset: range.endOffset,
        })),
        quads: [...selection.quads],
      },
      textAnchorRemap: {
        status: 'remapped',
        fromTextRevisionId: annotation.anchor.textRevisionId,
        targetTextRevisionId: targetRevision.id,
        updatedAt: now,
      },
      updatedAt: now,
    },
    changed: true,
  };
}
