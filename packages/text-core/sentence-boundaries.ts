export interface TextRange {
  readonly start: number;
  readonly end: number;
}

function fallbackSentenceRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const boundary = /(?:[.!?…。！？]+["'”’」』》)]*|\n+)/gu;
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end > start) ranges.push({ start, end });
    start = end;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

export function sentenceRanges(text: string, locale = 'ko'): TextRange[] {
  type SegmenterPart = { readonly index: number; readonly segment: string };
  type SegmenterConstructor = new (
    locale?: string,
    options?: { granularity: 'sentence' },
  ) => { segment(value: string): Iterable<SegmenterPart> };
  const Segmenter =
    typeof Intl !== 'undefined' ? (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter : undefined;
  if (!Segmenter) return fallbackSentenceRanges(text);
  try {
    return Array.from(new Segmenter(locale, { granularity: 'sentence' }).segment(text), (part) => ({
      start: part.index,
      end: part.index + part.segment.length,
    }));
  } catch {
    return fallbackSentenceRanges(text);
  }
}
