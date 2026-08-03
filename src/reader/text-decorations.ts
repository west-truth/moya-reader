import type { ReaderHighlight } from '../domain/types';

export interface ReaderTextDecorationHighlight {
  quote: string;
  color: ReaderHighlight['color'];
}

export interface ReaderTextDecorationSegment {
  text: string;
  searchHit: boolean;
  highlightColor?: ReaderHighlight['color'];
  ttsActive?: boolean;
}

export interface ReaderTextDecorationRange {
  start: number;
  end: number;
}

interface HighlightRange {
  start: number;
  end: number;
  color: ReaderHighlight['color'];
}

function overlapsExistingRange(ranges: HighlightRange[], start: number, end: number): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function findNonOverlappingQuoteStart(text: string, quote: string, ranges: HighlightRange[]): number {
  let start = text.indexOf(quote);
  while (start >= 0) {
    const end = start + quote.length;
    if (!overlapsExistingRange(ranges, start, end)) return start;
    start = text.indexOf(quote, start + quote.length);
  }
  return -1;
}

export function readerInlineHighlightRanges(
  text: string,
  highlights: ReaderTextDecorationHighlight[],
): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  for (const highlight of highlights) {
    if (!highlight.quote) continue;
    const start = findNonOverlappingQuoteStart(text, highlight.quote, ranges);
    if (start < 0) continue;
    ranges.push({ start, end: start + highlight.quote.length, color: highlight.color });
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function splitSearchSegments(
  text: string,
  searchQuery: string,
  options: { highlightColor?: ReaderHighlight['color']; ttsActive?: boolean } = {},
): ReaderTextDecorationSegment[] {
  const query = searchQuery.trim();
  if (!query) return [{ text, searchHit: false, highlightColor: options.highlightColor, ttsActive: options.ttsActive }];

  const lower = text.toLocaleLowerCase();
  const target = query.toLocaleLowerCase();
  const segments: ReaderTextDecorationSegment[] = [];
  let cursor = 0;
  let index = lower.indexOf(target, cursor);
  while (index >= 0) {
    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index), searchHit: false, highlightColor: options.highlightColor, ttsActive: options.ttsActive });
    }
    segments.push({ text: text.slice(index, index + query.length), searchHit: true, highlightColor: options.highlightColor, ttsActive: options.ttsActive });
    cursor = index + query.length;
    index = lower.indexOf(target, cursor);
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), searchHit: false, highlightColor: options.highlightColor, ttsActive: options.ttsActive });
  }
  return segments;
}

function normalizedDecorationRanges(text: string, ranges: ReaderTextDecorationRange[]): ReaderTextDecorationRange[] {
  return ranges
    .map((range) => ({
      start: Math.max(0, Math.min(text.length, Math.floor(range.start))),
      end: Math.max(0, Math.min(text.length, Math.ceil(range.end))),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function highlightColorAt(ranges: HighlightRange[], offset: number): ReaderHighlight['color'] | undefined {
  return ranges.find((range) => offset >= range.start && offset < range.end)?.color;
}

function activeAt(ranges: ReaderTextDecorationRange[], offset: number): boolean | undefined {
  return ranges.some((range) => offset >= range.start && offset < range.end) || undefined;
}

export function decorateReaderText(
  text: string,
  highlights: ReaderTextDecorationHighlight[],
  searchQuery: string,
  ttsActiveRanges: ReaderTextDecorationRange[] = [],
): ReaderTextDecorationSegment[] {
  const highlightRanges = readerInlineHighlightRanges(text, highlights);
  const activeRanges = normalizedDecorationRanges(text, ttsActiveRanges);
  if (!highlightRanges.length && !activeRanges.length) return splitSearchSegments(text, searchQuery);

  const boundaries = new Set([0, text.length]);
  for (const range of [...highlightRanges, ...activeRanges]) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  const orderedBoundaries = [...boundaries].sort((left, right) => left - right);
  const segments: ReaderTextDecorationSegment[] = [];
  for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
    const start = orderedBoundaries[index];
    const end = orderedBoundaries[index + 1];
    if (end <= start) continue;
    segments.push(...splitSearchSegments(text.slice(start, end), searchQuery, {
      highlightColor: highlightColorAt(highlightRanges, start),
      ttsActive: activeAt(activeRanges, start),
    }));
  }
  return segments;
}
