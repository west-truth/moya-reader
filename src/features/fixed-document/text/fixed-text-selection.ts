import type { DocumentTextBlock, TextQuad } from '../../../domain/types';

export interface FixedTextSelectionRange {
  readonly block: DocumentTextBlock;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface FixedTextSelectionValue {
  readonly ranges: readonly FixedTextSelectionRange[];
  readonly quote: string;
  readonly quads: readonly TextQuad[];
}

function clampOffset(value: number, length: number): number {
  return Math.max(0, Math.min(length, Math.floor(value)));
}

function selectionQuad(range: FixedTextSelectionRange): TextQuad | undefined {
  if (range.block.quads.length === 0) return undefined;
  const left = Math.min(...range.block.quads.map((quad) => quad.x));
  const top = Math.min(...range.block.quads.map((quad) => quad.y));
  const right = Math.max(...range.block.quads.map((quad) => quad.x + quad.width));
  const bottom = Math.max(...range.block.quads.map((quad) => quad.y + quad.height));
  const length = Math.max(1, range.block.text.length);
  const startRatio = range.startOffset / length;
  const endRatio = range.endOffset / length;
  const width = Math.max(0.002, (right - left) * (endRatio - startRatio));
  return {
    x: range.block.direction === 'rtl' ? right - (right - left) * endRatio : left + (right - left) * startRatio,
    y: top,
    width,
    height: bottom - top,
  };
}

export function buildFixedTextSelection(input: {
  readonly blocks: readonly DocumentTextBlock[];
  readonly startBlockId: string;
  readonly startOffset: number;
  readonly endBlockId: string;
  readonly endOffset: number;
}): FixedTextSelectionValue | undefined {
  let startIndex = input.blocks.findIndex((block) => block.id === input.startBlockId);
  let endIndex = input.blocks.findIndex((block) => block.id === input.endBlockId);
  if (startIndex < 0 || endIndex < 0) return undefined;
  let startOffset = input.startOffset;
  let endOffset = input.endOffset;
  if (startIndex > endIndex) {
    [startIndex, endIndex] = [endIndex, startIndex];
    [startOffset, endOffset] = [endOffset, startOffset];
  }
  const ranges = input.blocks.slice(startIndex, endIndex + 1).map((block, relativeIndex, selected) => {
    const first = relativeIndex === 0;
    const last = relativeIndex === selected.length - 1;
    const start = first ? clampOffset(startOffset, block.text.length) : 0;
    const end = last ? clampOffset(endOffset, block.text.length) : block.text.length;
    return {
      block,
      startOffset: first && last ? Math.min(start, end) : start,
      endOffset: first && last ? Math.max(start, end) : Math.max(start, end),
    } satisfies FixedTextSelectionRange;
  });
  const nonEmpty = ranges.filter((range) => range.endOffset > range.startOffset);
  if (nonEmpty.length === 0) return undefined;
  return {
    ranges: nonEmpty,
    quote: nonEmpty.map((range) => range.block.text.slice(range.startOffset, range.endOffset)).join('\n'),
    quads: nonEmpty.map(selectionQuad).filter((quad): quad is TextQuad => Boolean(quad)),
  };
}
