import type { ChapterRange, ParseNovelOptions } from './contracts';
import { resolveChapterHeadings } from './heading-sequence-resolver';
import { trimNormalizedTextRange } from '../normalization';

function splitWithoutHeadingRanges(text: string, fallbackTitle: string): ChapterRange[] {
  const body = trimNormalizedTextRange(text, 0, text.length);
  const chapters = [
    {
      title: fallbackTitle,
      normalizedStartOffset: 0,
      normalizedEndOffset: text.length,
      normalizedBodyStartOffset: body.start,
      normalizedBodyEndOffset: body.end,
    },
  ];
  assertNormalizedSourceCoverage(text.length, chapters);
  return chapters;
}

export function assembleChapterRanges(
  text: string,
  fallbackTitle: string,
  options: ParseNovelOptions = {},
): ChapterRange[] {
  const headings = resolveChapterHeadings(text, { mode: options.chapterSplitMode ?? 'auto' });
  if (headings.length === 0) return splitWithoutHeadingRanges(text, fallbackTitle);

  const chapters: ChapterRange[] = [];
  const prefix = trimNormalizedTextRange(text, 0, headings[0].lineStart);
  const prefixLength = prefix.end - prefix.start;
  if (prefixLength > 0) {
    chapters.push({
      title: prefixLength > 160 ? '프롤로그' : '머리말',
      normalizedStartOffset: 0,
      normalizedEndOffset: headings[0].lineStart,
      normalizedBodyStartOffset: prefix.start,
      normalizedBodyEndOffset: prefix.end,
    });
  }

  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const next = headings[index + 1];
    const end = next?.lineStart ?? text.length;
    const body = trimNormalizedTextRange(text, current.contentStart, end);
    chapters.push({
      title: current.title || `${index + 1}화`,
      normalizedStartOffset: chapters.length === 0 ? 0 : current.lineStart,
      normalizedEndOffset: end,
      normalizedBodyStartOffset: body.start,
      normalizedBodyEndOffset: body.end,
    });
  }

  const hasSubstantiveBody = chapters.some(
    (chapter) => chapter.normalizedBodyStartOffset < chapter.normalizedBodyEndOffset,
  );
  if (!hasSubstantiveBody) return splitWithoutHeadingRanges(text, fallbackTitle);

  assertNormalizedSourceCoverage(text.length, chapters);
  return chapters;
}

export function assertNormalizedSourceCoverage(sourceLength: number, chapters: ChapterRange[]): void {
  let nextOffset = 0;
  for (const chapter of chapters) {
    const bodyIsInsideChapter =
      chapter.normalizedBodyStartOffset >= chapter.normalizedStartOffset &&
      chapter.normalizedBodyEndOffset >= chapter.normalizedBodyStartOffset &&
      chapter.normalizedBodyEndOffset <= chapter.normalizedEndOffset;
    if (chapter.normalizedStartOffset !== nextOffset || !bodyIsInsideChapter) {
      throw new Error('Parser produced overlapping or incomplete normalized source ranges.');
    }
    nextOffset = chapter.normalizedEndOffset;
  }

  if (nextOffset !== sourceLength) {
    throw new Error('Parser did not cover the complete normalized source.');
  }
}

export function mapNormalizedRangeToLegacyChapterOffsets(chapter: ChapterRange): {
  rawStartOffset: number;
  rawEndOffset: number;
} {
  // Compatibility: these fields historically contain UTF-16 offsets into normalizedText, not raw source offsets.
  return {
    rawStartOffset: chapter.normalizedStartOffset,
    rawEndOffset: chapter.normalizedEndOffset,
  };
}
