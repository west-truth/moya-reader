import { integrityHash } from '../id-hash-contract';
import type { Paragraph } from '@noveldesk/contracts';
import { parsedParagraphId } from '../identity/parser';
import { trimNormalizedTextRange } from '../normalization';

interface ParagraphTextRange {
  text: string;
  start: number;
  end: number;
}

function hasTrimmedTextInRange(text: string, start: number, end: number): boolean {
  const range = trimNormalizedTextRange(text, start, end);
  return range.start < range.end;
}

function countBlankLineParagraphsInRange(text: string, start: number, end: number): number {
  let count = 0;
  let segmentStart = start;
  const delimiter = /\n{2,}/g;
  delimiter.lastIndex = start;

  for (let match = delimiter.exec(text); match && match.index < end; match = delimiter.exec(text)) {
    if (hasTrimmedTextInRange(text, segmentStart, Math.min(match.index, end))) count += 1;
    segmentStart = Math.min(match.index + match[0].length, end);
  }

  if (hasTrimmedTextInRange(text, segmentStart, end)) count += 1;
  return count;
}

function countLineParagraphsInRange(text: string, start: number, end: number): number {
  let count = 0;
  let lineStart = start;

  while (lineStart <= end) {
    const next = text.indexOf('\n', lineStart);
    const lineEnd = next >= 0 && next < end ? next : end;
    if (hasTrimmedTextInRange(text, lineStart, lineEnd)) count += 1;
    if (next < 0 || next >= end) break;
    lineStart = next + 1;
  }

  return count;
}

function hasAtLeastThreeBlankLineBlocksInRange(text: string, start: number, end: number): boolean {
  let count = 0;
  let segmentStart = start;
  const delimiter = /\n{2,}/g;
  delimiter.lastIndex = start;

  for (let match = delimiter.exec(text); match && match.index < end; match = delimiter.exec(text)) {
    if (hasTrimmedTextInRange(text, segmentStart, Math.min(match.index, end))) count += 1;
    if (count >= 3) return true;
    segmentStart = Math.min(match.index + match[0].length, end);
  }

  if (hasTrimmedTextInRange(text, segmentStart, end)) count += 1;
  return count >= 3;
}

export function countParagraphsInRange(text: string, start: number, end: number): number {
  return hasAtLeastThreeBlankLineBlocksInRange(text, start, end)
    ? countBlankLineParagraphsInRange(text, start, end)
    : countLineParagraphsInRange(text, start, end);
}

export interface CooperativeParagraphCountOptions {
  chunkCharacters?: number;
  checkpoint?: () => Promise<void>;
}

export async function countParagraphsInRangeCooperatively(
  text: string,
  start: number,
  end: number,
  options: CooperativeParagraphCountOptions = {},
): Promise<number> {
  const chunkCharacters = Math.max(1, Math.floor(options.chunkCharacters ?? 256 * 1024));
  let lineStart = start;
  let lineCount = 0;
  let blockCount = 0;
  let blockHasText = false;
  let checkpointAt = Math.min(end, start + chunkCharacters);

  while (lineStart <= end) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline >= 0 && newline < end ? newline : end;
    const lineHasText = hasTrimmedTextInRange(text, lineStart, lineEnd);
    if (lineHasText) {
      lineCount += 1;
      blockHasText = true;
    } else if (blockHasText) {
      blockCount += 1;
      blockHasText = false;
    }

    const scannedThrough = newline >= 0 && newline < end ? newline + 1 : end;
    if (scannedThrough >= checkpointAt && scannedThrough < end) {
      await options.checkpoint?.();
      checkpointAt = Math.min(end, scannedThrough + chunkCharacters);
    }
    if (newline < 0 || newline >= end) break;
    lineStart = newline + 1;
  }

  if (blockHasText) blockCount += 1;
  return blockCount >= 3 ? blockCount : lineCount;
}

function* iterateBlankLineParagraphTextRanges(text: string, start: number, end: number): Generator<ParagraphTextRange> {
  let segmentStart = start;
  const delimiter = /\n{2,}/g;
  delimiter.lastIndex = start;

  for (let match = delimiter.exec(text); match && match.index < end; match = delimiter.exec(text)) {
    const range = trimNormalizedTextRange(text, segmentStart, Math.min(match.index, end));
    if (range.start < range.end) {
      yield { text: text.slice(range.start, range.end), start: range.start, end: range.end };
    }
    segmentStart = Math.min(match.index + match[0].length, end);
  }

  const tail = trimNormalizedTextRange(text, segmentStart, end);
  if (tail.start < tail.end) {
    yield { text: text.slice(tail.start, tail.end), start: tail.start, end: tail.end };
  }
}

function* iterateLineParagraphTextRanges(text: string, start: number, end: number): Generator<ParagraphTextRange> {
  let lineStart = start;

  while (lineStart <= end) {
    const next = text.indexOf('\n', lineStart);
    const lineEnd = next >= 0 && next < end ? next : end;
    const range = trimNormalizedTextRange(text, lineStart, lineEnd);
    if (range.start < range.end) {
      yield { text: text.slice(range.start, range.end), start: range.start, end: range.end };
    }
    if (next < 0 || next >= end) break;
    lineStart = next + 1;
  }
}

function iterateParagraphTextRanges(text: string, start: number, end: number): Iterable<ParagraphTextRange> {
  return hasAtLeastThreeBlankLineBlocksInRange(text, start, end)
    ? iterateBlankLineParagraphTextRanges(text, start, end)
    : iterateLineParagraphTextRanges(text, start, end);
}

export function* iterateParagraphsInRange(
  novelId: string,
  chapterId: string,
  sourceText: string,
  normalizedBodyStartOffset: number,
  normalizedBodyEndOffset: number,
): Generator<Paragraph> {
  let index = 0;
  for (const piece of iterateParagraphTextRanges(sourceText, normalizedBodyStartOffset, normalizedBodyEndOffset)) {
    yield {
      id: parsedParagraphId(novelId, chapterId, index, piece.text),
      novelId,
      chapterId,
      index: index + 1,
      text: piece.text,
      startOffsetInChapter: piece.start - normalizedBodyStartOffset,
      endOffsetInChapter: piece.end - normalizedBodyStartOffset,
      textHash: integrityHash(piece.text),
    };
    index += 1;
  }
}
