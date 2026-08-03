import {
  assembleChapterRanges,
  mapNormalizedRangeToLegacyChapterOffsets,
} from '../../domain/parser/chapter-range-assembler';
import * as content from '../../domain/parser/content-contract';
import type { DecodedNovelText } from '../../domain/parser/contracts';
import { normalizeNovelText } from '../../domain/parser/normalization';
import { countParagraphsInRangeCooperatively, iterateParagraphsInRange } from '../../domain/parser/paragraph-builder';
import type { Chapter, ChapterSplitMode, ParsedNovelImport } from '../../domain/types';
import { hashTextRangeCooperatively } from './cooperative-text-hash';

export type CooperativeImportParsePhase =
  'normalizing_text' | 'hashing_normalized_text' | 'detecting_chapters' | 'building_chapters';

export interface CooperativeImportParseProgress {
  phase: CooperativeImportParsePhase;
  chaptersProcessed: number;
  totalChapters: number;
  totalParagraphs: number;
}

export interface CooperativeImportParseOptions {
  chapterSplitMode?: ChapterSplitMode;
  clientBookId?: string;
  chaptersPerYield?: number;
  shouldCancel?: () => boolean;
  onProgress?: (progress: CooperativeImportParseProgress) => void;
  yieldControl?: () => Promise<void>;
}

export const DEFAULT_IMPORT_PARSE_CHAPTERS_PER_YIELD = 16;

function importAbortError(): Error {
  return new DOMException('Import cancelled', 'AbortError') as Error;
}

function throwIfCancelled(options: CooperativeImportParseOptions): void {
  if (options.shouldCancel?.()) throw importAbortError();
}

function titleFromFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^.]+$/, '').trim();
  return withoutExt || '제목 없는 책';
}

function bookFormatFromFileName(fileName: string): 'txt' | 'markdown' {
  return /\.(?:md|markdown)$/i.test(fileName.trim()) ? 'markdown' : 'txt';
}

function normalizedChaptersPerYield(value: number | undefined): number {
  const parsed = Math.floor(value ?? DEFAULT_IMPORT_PARSE_CHAPTERS_PER_YIELD);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : DEFAULT_IMPORT_PARSE_CHAPTERS_PER_YIELD;
}

async function defaultYieldControl(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function reportProgress(
  options: CooperativeImportParseOptions,
  progress: CooperativeImportParseProgress,
): Promise<void> {
  throwIfCancelled(options);
  options.onProgress?.(progress);
  await (options.yieldControl ?? defaultYieldControl)();
  throwIfCancelled(options);
}

export async function parseDecodedNovelTextForImportCooperatively(
  fileName: string,
  decoded: DecodedNovelText,
  rawTextHash: string,
  options: CooperativeImportParseOptions = {},
): Promise<ParsedNovelImport> {
  const sourceEncoding = decoded.encoding;
  await reportProgress(options, {
    phase: 'normalizing_text',
    chaptersProcessed: 0,
    totalChapters: 0,
    totalParagraphs: 0,
  });

  let normalizedText = normalizeNovelText(decoded.text);
  decoded.text = '';
  await reportProgress(options, {
    phase: 'hashing_normalized_text',
    chaptersProcessed: 0,
    totalChapters: 0,
    totalParagraphs: 0,
  });

  const normalizedTextHash = await hashTextRangeCooperatively(normalizedText, 0, normalizedText.length, {
    checkpoint: () =>
      reportProgress(options, {
        phase: 'hashing_normalized_text',
        chaptersProcessed: 0,
        totalChapters: 0,
        totalParagraphs: 0,
      }),
  });
  const novelId = options.clientBookId ?? content.novelId(fileName, normalizedTextHash);
  const now = new Date().toISOString();
  const novelTitle = titleFromFileName(fileName);
  const totalCharacters = normalizedText.length;
  await reportProgress(options, {
    phase: 'detecting_chapters',
    chaptersProcessed: 0,
    totalChapters: 0,
    totalParagraphs: 0,
  });

  const chapterParts = assembleChapterRanges(normalizedText, novelTitle, {
    chapterSplitMode: options.chapterSplitMode ?? 'auto',
  });
  const importChapters: Array<{
    chapter: Chapter;
    normalizedBodyStartOffset: number;
    normalizedBodyEndOffset: number;
  }> = [];
  const chaptersPerYield = normalizedChaptersPerYield(options.chaptersPerYield);
  let totalParagraphs = 0;

  await reportProgress(options, {
    phase: 'building_chapters',
    chaptersProcessed: 0,
    totalChapters: chapterParts.length,
    totalParagraphs,
  });

  for (const [index, part] of chapterParts.entries()) {
    throwIfCancelled(options);
    const chapterId = content.chapterId(novelId, index + 1, part.title);
    const checkpoint = () =>
      reportProgress(options, {
        phase: 'building_chapters' as const,
        chaptersProcessed: index,
        totalChapters: chapterParts.length,
        totalParagraphs,
      });
    const paragraphCount = await countParagraphsInRangeCooperatively(
      normalizedText,
      part.normalizedBodyStartOffset,
      part.normalizedBodyEndOffset,
      { checkpoint },
    );
    const textHash = await hashTextRangeCooperatively(
      normalizedText,
      part.normalizedBodyStartOffset,
      part.normalizedBodyEndOffset,
      { checkpoint },
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
        textHash,
        ...mapNormalizedRangeToLegacyChapterOffsets(part),
        characterCount,
        paragraphCount,
        createdAt: now,
        updatedAt: now,
      },
      normalizedBodyStartOffset: part.normalizedBodyStartOffset,
      normalizedBodyEndOffset: part.normalizedBodyEndOffset,
    });

    const chaptersProcessed = index + 1;
    if (
      chaptersProcessed === 1 ||
      chaptersProcessed === chapterParts.length ||
      chaptersProcessed % chaptersPerYield === 0
    ) {
      await reportProgress(options, {
        phase: 'building_chapters',
        chaptersProcessed,
        totalChapters: chapterParts.length,
        totalParagraphs,
      });
    }
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
