import type { Chapter, LabeledSegment, Paragraph } from '../../domain/types';
import type { HostedTTSWarmupChapterSource } from '../../providers/hosted-tts-warmup';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { loadTTSWarmupParagraphs } from './tts-warmup-source';

export type TTSWarmupScope = 'current' | 'nearby' | 'book';

export function selectTTSWarmupChapters(input: {
  readonly scope: TTSWarmupScope;
  readonly chapters: readonly Chapter[];
  readonly currentChapter?: Chapter;
  readonly nearbyChapterLimit: number;
}): Chapter[] {
  if (!input.currentChapter) return [];
  if (input.scope === 'current') return [input.currentChapter];
  const sortedChapters = [...input.chapters].sort((left, right) => left.index - right.index);
  if (input.scope === 'book') return sortedChapters;
  const currentIndex = sortedChapters.findIndex((chapter) => chapter.id === input.currentChapter?.id);
  if (currentIndex < 0) return [input.currentChapter];
  return sortedChapters.slice(currentIndex, currentIndex + input.nearbyChapterLimit);
}

export async function loadTTSWarmupChapterSource(input: {
  readonly repository: ReaderRepository;
  readonly chapter: Chapter;
  readonly currentChapterId?: string;
  readonly currentSegments: readonly LabeledSegment[];
  readonly cachedParagraph?: (paragraphId: string) => Paragraph | undefined;
  readonly maxCandidateParagraphs: number;
  readonly signal: AbortSignal;
}): Promise<HostedTTSWarmupChapterSource | undefined> {
  const chapterSegments =
    input.chapter.id === input.currentChapterId &&
    input.currentSegments.some((segment) => segment.chapterId === input.chapter.id)
      ? input.currentSegments.filter((segment) => segment.chapterId === input.chapter.id)
      : await input.repository.listSegments(input.chapter.id);
  if (input.signal.aborted || chapterSegments.length === 0) return undefined;

  const segmentsByParagraph = new Map<string, LabeledSegment[]>();
  for (const segment of chapterSegments) {
    const paragraphSegments = segmentsByParagraph.get(segment.paragraphId) ?? [];
    paragraphSegments.push(segment);
    segmentsByParagraph.set(segment.paragraphId, paragraphSegments);
  }
  const sortedParagraphEntries = [...segmentsByParagraph.entries()].sort(
    ([, left], [, right]) => (left[0]?.segmentIndex ?? 0) - (right[0]?.segmentIndex ?? 0),
  );
  const candidateParagraphIds = (
    Number.isFinite(input.maxCandidateParagraphs)
      ? sortedParagraphEntries.slice(0, Math.max(0, input.maxCandidateParagraphs))
      : sortedParagraphEntries
  ).map(([paragraphId]) => paragraphId);
  const paragraphs = await loadTTSWarmupParagraphs({
    source: input.repository,
    chapterId: input.chapter.id,
    paragraphCount: input.chapter.paragraphCount,
    candidateParagraphIds,
    signal: input.signal,
    cachedParagraph: input.chapter.id === input.currentChapterId ? input.cachedParagraph : undefined,
    preferPageReads: !Number.isFinite(input.maxCandidateParagraphs),
  });

  return {
    chapterId: input.chapter.id,
    chapterTextHash: input.chapter.textHash,
    paragraphs,
    segments: chapterSegments,
  };
}
