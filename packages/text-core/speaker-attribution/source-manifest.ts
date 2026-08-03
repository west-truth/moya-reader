import { persistentId128, structuredIntegrityHash, textIntegrityHash } from '../hash';
import {
  SPEAKER_SOURCE_MANIFEST_VERSION,
  type SpeakerSourceChapterInput,
  type SpeakerSourceManifestV1,
  type SpeakerSourcePreflightIssueV1,
} from './contracts';

function validRange(start: number, end: number, limit: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= limit;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function buildSpeakerSourceManifest(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly activeContentRevisionId: string;
  readonly sourceHash: string;
  readonly normalizedText: string;
  readonly normalizedTextHash: string;
  readonly expectedChapterCount?: number;
  readonly chapters: readonly SpeakerSourceChapterInput[];
}): SpeakerSourceManifestV1 {
  const issues: SpeakerSourcePreflightIssueV1[] = [];
  const chapters = [...input.chapters].sort(
    (left, right) => left.sourceStartOffset - right.sourceStartOffset || left.chapterIndex - right.chapterIndex,
  );
  if (input.contentRevisionId !== input.activeContentRevisionId) {
    issues.push({
      code: 'content_revision_stale',
      severity: 'error',
      detail: 'The requested content revision is not the active revision.',
    });
  }
  if (textIntegrityHash(input.normalizedText) !== input.normalizedTextHash) {
    issues.push({
      code: 'normalized_source_hash_mismatch',
      severity: 'error',
      detail: 'The normalized source hash does not match the supplied source text.',
    });
  }

  const ids = new Set<string>();
  const indexes = new Set<number>();
  let nextOffset = 0;
  for (const chapter of chapters) {
    if (ids.has(chapter.chapterId)) {
      issues.push({
        code: 'chapter_id_duplicate',
        severity: 'error',
        chapterId: chapter.chapterId,
        detail: 'Chapter IDs must be unique.',
      });
    }
    ids.add(chapter.chapterId);
    if (indexes.has(chapter.chapterIndex)) {
      issues.push({
        code: 'chapter_index_duplicate',
        severity: 'error',
        chapterId: chapter.chapterId,
        detail: 'Chapter indexes must be unique.',
      });
    }
    indexes.add(chapter.chapterIndex);
    if (
      !validRange(chapter.sourceStartOffset, chapter.sourceEndOffset, input.normalizedText.length) ||
      chapter.bodyStartOffset < chapter.sourceStartOffset ||
      chapter.bodyEndOffset > chapter.sourceEndOffset ||
      chapter.bodyEndOffset < chapter.bodyStartOffset
    ) {
      issues.push({
        code: 'chapter_range_invalid',
        severity: 'error',
        chapterId: chapter.chapterId,
        detail: 'Chapter source/body offsets are outside the normalized source.',
      });
    }
    if (chapter.sourceStartOffset !== nextOffset) {
      issues.push({
        code: 'chapter_range_gap_or_overlap',
        severity: 'error',
        chapterId: chapter.chapterId,
        detail: 'Chapter source ranges are not continuous.',
      });
    }
    nextOffset = chapter.sourceEndOffset;
    if (textIntegrityHash(chapter.text) !== chapter.textHash) {
      issues.push({
        code: 'chapter_body_hash_mismatch',
        severity: 'error',
        chapterId: chapter.chapterId,
        detail: 'Chapter body text does not match its hash.',
      });
    }
    if (input.normalizedText.slice(chapter.bodyStartOffset, chapter.bodyEndOffset) !== chapter.text) {
      issues.push({
        code: 'chapter_body_source_mismatch',
        severity: 'error',
        chapterId: chapter.chapterId,
        detail: 'Chapter body text does not match the normalized source range.',
      });
    }
    if (!chapter.text.trim() || chapter.paragraphCount < 1) {
      issues.push({
        code: 'empty_chapter',
        severity: 'review',
        chapterId: chapter.chapterId,
        detail: 'The accepted chapter has no labelable body paragraphs.',
      });
    }
  }
  if (nextOffset !== input.normalizedText.length) {
    issues.push({
      code: 'chapter_range_gap_or_overlap',
      severity: 'error',
      detail: 'Chapter ranges do not cover the complete normalized source.',
    });
  }

  const sortedIndexes = [...indexes].sort((left, right) => left - right);
  if (sortedIndexes.some((value, index) => index > 0 && value !== sortedIndexes[index - 1]! + 1)) {
    issues.push({
      code: 'chapter_index_gap',
      severity: 'review',
      detail: 'The accepted chapter sequence contains an index gap.',
    });
  }
  if (input.expectedChapterCount !== undefined && input.expectedChapterCount !== chapters.length) {
    issues.push({
      code: 'expected_chapter_count_mismatch',
      severity: 'review',
      detail: `Expected ${input.expectedChapterCount} chapters but the accepted structure has ${chapters.length}.`,
    });
  }
  const bodyLengths = chapters.map((chapter) => chapter.text.length).filter((length) => length > 0);
  const typicalLength = median(bodyLengths);
  const oversizedLimit = Math.max(200_000, typicalLength * 4);
  for (const chapter of chapters) {
    if (bodyLengths.length >= 3 && chapter.text.length > oversizedLimit) {
      issues.push({
        code: 'suspicious_oversized_chapter',
        severity: 'review',
        chapterId: chapter.chapterId,
        detail: 'The chapter is unusually large relative to the accepted structure.',
      });
    }
  }

  const chapterAnchors = chapters.map((chapter) => ({
    chapterId: chapter.chapterId,
    chapterIndex: chapter.chapterIndex,
    startOffset: chapter.sourceStartOffset,
    endOffset: chapter.sourceEndOffset,
    bodyStartOffset: chapter.bodyStartOffset,
    bodyEndOffset: chapter.bodyEndOffset,
    textHash: chapter.textHash,
  }));
  const core = {
    version: SPEAKER_SOURCE_MANIFEST_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    sourceHash: input.sourceHash,
    normalizedTextHash: input.normalizedTextHash,
    expectedChapterCount: input.expectedChapterCount,
    acceptedChapterCount: chapters.length,
    chapterAnchors,
    issues,
    status: issues.some((issue) => issue.severity === 'error')
      ? ('stale' as const)
      : issues.length > 0
        ? ('review_required' as const)
        : ('ready' as const),
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('speaker_source_manifest', [input.bookId, input.contentRevisionId, fingerprint]),
    fingerprint,
  };
}
