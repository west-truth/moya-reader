import type { Paragraph } from '../domain/types';
import type { PlayableTtsSegment, PlayableTtsSegmentRange } from './tts-playback';

interface TextRange {
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

function sourceRangesForSpokenRange(playable: PlayableTtsSegment, spokenRange: TextRange): PlayableTtsSegmentRange[] {
  const spans = (playable.spokenTextSpans ?? []).filter(
    (span) => span.spokenEnd > spokenRange.start && span.spokenStart < spokenRange.end,
  );
  if (spans.length === 0) return [];
  const sourceStart = Math.min(...spans.map((span) => span.sourceStart));
  const sourceEnd = Math.max(...spans.map((span) => span.sourceEnd));
  return playable.sourceRanges.flatMap((range) => {
    const startOffset = Math.max(range.startOffset, sourceStart);
    const endOffset = Math.min(range.endOffset, sourceEnd);
    return endOffset > startOffset ? [{ ...range, startOffset, endOffset }] : [];
  });
}

function legacySourceSentenceItems(paragraph: Paragraph, playable: PlayableTtsSegment): PlayableTtsSegment[] {
  const items: PlayableTtsSegment[] = [];
  for (const range of playable.sourceRanges) {
    if (range.paragraphId !== paragraph.id) continue;
    const source = paragraph.text.slice(range.startOffset, range.endOffset);
    for (const local of sentenceRanges(source)) {
      const startOffset = range.startOffset + local.start;
      const endOffset = Math.min(range.startOffset + local.end, range.endOffset);
      const text = paragraph.text.slice(startOffset, endOffset).trim();
      if (!text) continue;
      const sourceRange = { ...range, startOffset, endOffset };
      items.push({
        ...playable,
        text,
        sourceText: text,
        sourceSegmentIds: sourceRange.segmentId ? [sourceRange.segmentId] : [],
        sourceRanges: [sourceRange],
      });
    }
  }
  return items.length ? items : [playable];
}

export function splitPlayableTtsSegment(paragraph: Paragraph, playable: PlayableTtsSegment): PlayableTtsSegment[] {
  if (playable.sourceRanges.length > 0 && !playable.spokenTextSpans?.length) {
    return legacySourceSentenceItems(paragraph, playable);
  }
  const items = sentenceRanges(playable.text)
    .map<PlayableTtsSegment | undefined>((range) => {
      const text = playable.text.slice(range.start, range.end).trim();
      if (!text) return undefined;
      const sourceRanges = sourceRangesForSpokenRange(playable, range);
      if (playable.sourceRanges.length > 0 && sourceRanges.length === 0) return undefined;
      const sourceText = sourceRanges
        .map((sourceRange) => paragraph.text.slice(sourceRange.startOffset, sourceRange.endOffset))
        .join('\n')
        .trim();
      return {
        ...playable,
        text,
        sourceText: sourceText || playable.sourceText,
        sourceSegmentIds: [...new Set(sourceRanges.map((sourceRange) => sourceRange.segmentId).filter(Boolean))],
        sourceRanges,
      };
    })
    .filter((item): item is PlayableTtsSegment => item !== undefined);
  return items.length ? items : [playable];
}

export function planTTSParagraphSentences(
  paragraph: Paragraph,
  playableSegments: readonly PlayableTtsSegment[],
): PlayableTtsSegment[] {
  return playableSegments.flatMap((playable) => splitPlayableTtsSegment(paragraph, playable));
}
