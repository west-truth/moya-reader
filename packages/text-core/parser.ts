import { assembleChapterRanges, mapNormalizedRangeToLegacyChapterOffsets } from './parser/chapter-range-assembler';
import * as content from './parser/content-contract';
import type { ChapterSplitPreview, DecodedNovelText, ParseNovelOptions } from './parser/contracts';
import { decodeNovelTextWithEncoding } from './parser/encoding';
import { normalizeNovelText } from './normalization';
import { countParagraphsInRange, iterateParagraphsInRange } from './parser/paragraph-builder';
import type { Chapter, EncodingMode, Paragraph, ParsedNovel, ParsedNovelImport } from '@noveldesk/contracts';

export type * from './parser/contracts';
export {
  assembleChapterRanges,
  assertNormalizedSourceCoverage,
  mapNormalizedRangeToLegacyChapterOffsets,
} from './parser/chapter-range-assembler';
export { chapterId, coverSeed, hash, normalizeSourceHash, novelId } from './parser/content-contract';
export { decodeNovelText, decodeNovelTextWithEncoding } from './parser/encoding';
export { isLikelyChapterHeading, parseChapterHeading } from './parser/heading-detector';
export { resolveChapterHeadings } from './parser/heading-sequence-resolver';
export { normalizeNovelText, trimNormalizedTextRange, type NormalizedTextRange } from './normalization';
export {
  countParagraphsInRange,
  countParagraphsInRangeCooperatively,
  iterateParagraphsInRange,
  type CooperativeParagraphCountOptions,
} from './parser/paragraph-builder';

export async function previewNovelChapterSplit(
  fileName: string,
  buffer: ArrayBuffer,
  encoding: EncodingMode,
  options: ParseNovelOptions = {},
): Promise<ChapterSplitPreview> {
  const decoded = decodeNovelTextWithEncoding(buffer, encoding);
  return previewDecodedNovelChapterSplit(fileName, decoded, options);
}

export function previewDecodedNovelChapterSplit(
  fileName: string,
  decoded: DecodedNovelText,
  options: ParseNovelOptions = {},
): ChapterSplitPreview {
  let normalizedText = normalizeNovelText(decoded.text);
  decoded.text = '';
  const novelTitle = titleFromFileName(fileName);
  const chapterParts = assembleChapterRanges(normalizedText, novelTitle, options);
  let totalParagraphs = 0;
  const chapters = chapterParts.map((part, index) => {
    const paragraphCount = countParagraphsInRange(
      normalizedText,
      part.normalizedBodyStartOffset,
      part.normalizedBodyEndOffset,
    );
    totalParagraphs += paragraphCount;
    return {
      index: index + 1,
      title: part.title,
      characterCount: part.normalizedBodyEndOffset - part.normalizedBodyStartOffset,
      paragraphCount,
    };
  });
  const preview = {
    title: novelTitle,
    sourceEncoding: decoded.encoding,
    totalChapters: chapters.length,
    totalCharacters: normalizedText.length,
    totalParagraphs,
    chapters,
  };
  normalizedText = '';
  return preview;
}

function titleFromFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^.]+$/, '').trim();
  return withoutExt || '제목 없는 책';
}

export function bookFormatFromFileName(fileName: string): 'txt' | 'markdown' {
  return /\.(?:md|markdown)$/i.test(fileName.trim()) ? 'markdown' : 'txt';
}

export async function parseNovelFile(
  fileName: string,
  buffer: ArrayBuffer,
  encoding: EncodingMode,
  options: ParseNovelOptions = {},
): Promise<ParsedNovel> {
  const decoded = decodeNovelTextWithEncoding(buffer, encoding);
  const rawText = decoded.text;
  const normalizedText = normalizeNovelText(rawText);
  const rawTextHash = content.hash(buffer);
  const normalizedTextHash = content.hash(normalizedText);
  const novelId = content.novelId(fileName, normalizedTextHash);
  const now = new Date().toISOString();
  const novelTitle = titleFromFileName(fileName);

  const chapterParts = assembleChapterRanges(normalizedText, novelTitle, options);
  const chapters: Chapter[] = [];
  const paragraphs: Paragraph[] = [];

  for (const [index, part] of chapterParts.entries()) {
    const chapterId = content.chapterId(novelId, index + 1, part.title);
    const body = normalizedText.slice(part.normalizedBodyStartOffset, part.normalizedBodyEndOffset);
    const chapterParagraphs = Array.from(
      iterateParagraphsInRange(
        novelId,
        chapterId,
        normalizedText,
        part.normalizedBodyStartOffset,
        part.normalizedBodyEndOffset,
      ),
    );
    chapters.push({
      id: chapterId,
      novelId,
      index: index + 1,
      title: part.title,
      normalizedText: body,
      textHash: content.hash(body),
      ...mapNormalizedRangeToLegacyChapterOffsets(part),
      characterCount: body.length,
      paragraphCount: chapterParagraphs.length,
      createdAt: now,
      updatedAt: now,
    });
    paragraphs.push(...chapterParagraphs);
  }

  return {
    novel: {
      id: novelId,
      format: bookFormatFromFileName(fileName),
      title: novelTitle,
      sourceFileName: fileName,
      sourceEncoding: decoded.encoding,
      rawText,
      normalizedText,
      rawTextHash,
      normalizedTextHash,
      createdAt: now,
      updatedAt: now,
      totalChapters: chapters.length,
      totalCharacters: normalizedText.length,
      totalParagraphs: paragraphs.length,
      coverSeed: content.coverSeed(fileName),
      lastReadChapterId: chapters[0]?.id,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters,
    paragraphs,
  };
}

export async function parseNovelFileForImport(
  fileName: string,
  buffer: ArrayBuffer,
  encoding: EncodingMode,
  options: ParseNovelOptions = {},
): Promise<ParsedNovelImport> {
  const rawTextHash = content.hash(buffer);
  const decoded = decodeNovelTextWithEncoding(buffer, encoding);
  return parseDecodedNovelTextForImport(fileName, decoded, rawTextHash, options);
}

export async function parseDecodedNovelTextForImport(
  fileName: string,
  decoded: DecodedNovelText,
  rawTextHash: string,
  options: ParseNovelOptions = {},
): Promise<ParsedNovelImport> {
  const sourceEncoding = decoded.encoding;
  let normalizedText = normalizeNovelText(decoded.text);
  // Import-ready results persist metadata and page text only, so release the decoded raw string early.
  decoded.text = '';
  const normalizedTextHash = content.hash(normalizedText);
  const novelId = content.novelId(fileName, normalizedTextHash);
  const now = new Date().toISOString();
  const novelTitle = titleFromFileName(fileName);
  const totalCharacters = normalizedText.length;
  const chapterParts = assembleChapterRanges(normalizedText, novelTitle, options);
  const importChapters: Array<{
    chapter: Chapter;
    normalizedBodyStartOffset: number;
    normalizedBodyEndOffset: number;
  }> = [];
  let totalParagraphs = 0;

  for (const [index, part] of chapterParts.entries()) {
    const chapterId = content.chapterId(novelId, index + 1, part.title);
    const paragraphCount = countParagraphsInRange(
      normalizedText,
      part.normalizedBodyStartOffset,
      part.normalizedBodyEndOffset,
    );
    const characterCount = part.normalizedBodyEndOffset - part.normalizedBodyStartOffset;
    totalParagraphs += paragraphCount;
    importChapters.push({
      chapter: {
        id: chapterId,
        novelId,
        index: index + 1,
        title: part.title,
        normalizedText: '',
        textHash: content.hash(normalizedText.slice(part.normalizedBodyStartOffset, part.normalizedBodyEndOffset)),
        ...mapNormalizedRangeToLegacyChapterOffsets(part),
        characterCount,
        paragraphCount,
        createdAt: now,
        updatedAt: now,
      },
      normalizedBodyStartOffset: part.normalizedBodyStartOffset,
      normalizedBodyEndOffset: part.normalizedBodyEndOffset,
    });
  }

  let consumed = false;
  const chapters = importChapters.map(({ chapter }) => chapter);

  return {
    novel: {
      id: novelId,
      format: bookFormatFromFileName(fileName),
      title: novelTitle,
      sourceFileName: fileName,
      sourceEncoding,
      rawText: '',
      normalizedText: '',
      rawTextHash: content.normalizeSourceHash(rawTextHash),
      normalizedTextHash,
      createdAt: now,
      updatedAt: now,
      totalChapters: chapters.length,
      totalCharacters,
      totalParagraphs,
      coverSeed: content.coverSeed(fileName),
      lastReadChapterId: chapters[0]?.id,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    },
    chapters,
    *consumeChapterParagraphs() {
      if (consumed) return;
      consumed = true;
      const sourceText = normalizedText;
      try {
        for (const item of importChapters) {
          yield {
            chapter: item.chapter,
            paragraphs: iterateParagraphsInRange(
              novelId,
              item.chapter.id,
              sourceText,
              item.normalizedBodyStartOffset,
              item.normalizedBodyEndOffset,
            ),
          };
        }
      } finally {
        normalizedText = '';
      }
    },
  };
}

export async function parseNovelTextForSample(title: string, text: string): Promise<ParsedNovel> {
  const bytes = new TextEncoder().encode(text);
  const parsed = await parseNovelFile(`${title}.txt`, bytes.buffer, 'utf-8');
  return {
    ...parsed,
    novel: {
      ...parsed.novel,
      title,
      sourceFileName: `${title}.txt`,
      analysisStatus: 'mock_ready',
    },
  };
}
