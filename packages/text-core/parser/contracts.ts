import type { ChapterSplitMode, EncodingMode } from '@noveldesk/contracts';

export type ResolvedEncoding = Exclude<EncodingMode, 'auto'>;

export interface ParseNovelOptions {
  chapterSplitMode?: ChapterSplitMode;
}

export interface DecodedNovelText {
  text: string;
  encoding: ResolvedEncoding;
}

export interface ChapterSplitPreviewChapter {
  index: number;
  title: string;
  characterCount: number;
  paragraphCount: number;
}

export interface ChapterSplitPreview {
  title: string;
  sourceEncoding: ResolvedEncoding;
  totalChapters: number;
  totalCharacters: number;
  totalParagraphs: number;
  chapters: ChapterSplitPreviewChapter[];
}

export interface ChapterHeadingInfo {
  title: string;
  family: string;
  number?: number;
  requiresSequence: boolean;
}

export interface HeadingMatch extends ChapterHeadingInfo {
  lineIndex: number;
  lineText: string;
  hasBlankBefore: boolean;
  hasBlankAfter: boolean;
  lineStart: number;
  contentStart: number;
}

export interface ChapterRange {
  title: string;
  normalizedStartOffset: number;
  normalizedEndOffset: number;
  normalizedBodyStartOffset: number;
  normalizedBodyEndOffset: number;
}
