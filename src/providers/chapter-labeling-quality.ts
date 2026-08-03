import type { Chapter, LabeledSegment, Paragraph } from '../domain/types';
import type { ChapterLabelingResult } from './ai';

export type ChapterLabelingQualitySeverity = 'error' | 'warning';

export interface ChapterLabelingQualityIssue {
  readonly severity: ChapterLabelingQualitySeverity;
  readonly code: string;
  readonly message: string;
  readonly paragraphId?: string;
  readonly value?: number;
  readonly threshold?: number;
}

export interface ChapterLabelingQualitySummary {
  readonly errorCount: number;
  readonly warningCount: number;
  readonly issueCodes: string[];
}

export interface ChapterLabelingQualityMetrics {
  readonly paragraphCount: number;
  readonly segmentCount: number;
  readonly labeledParagraphCount: number;
  readonly dialogueLikeParagraphCount: number;
  readonly labeledDialogueLikeParagraphCount: number;
  readonly dialogueLikeCoverageRatio: number;
  readonly coveredCharacters: number;
  readonly targetNonWhitespaceCharacters: number;
  readonly coveredTargetNonWhitespaceCharacters: number;
  readonly targetCoverageRatio: number;
  readonly dialogueSegmentCount: number;
  readonly unknownDialogueSegmentCount: number;
  readonly unknownDialogueSegmentRatio: number;
  readonly uniqueEmotionCount: number;
}

export interface ChapterLabelingQualityReport {
  readonly ok: boolean;
  readonly issues: ChapterLabelingQualityIssue[];
  readonly summary: ChapterLabelingQualitySummary;
  readonly metrics: ChapterLabelingQualityMetrics;
}

export interface ValidateChapterLabelingQualityInput {
  readonly chapter: Chapter;
  readonly paragraphs: Paragraph[];
  readonly result: ChapterLabelingResult;
  readonly minDialogueParagraphsForCoverage?: number;
  readonly minDialogueCoverageRatio?: number;
  readonly minTargetCoverageRatio?: number;
  /** @deprecated Use minTargetCoverageRatio. */
  readonly minChapterCoverageRatio?: number;
  readonly minSegmentsForLongChapter?: number;
  readonly minDialogueSegmentsForSpeakerCoverage?: number;
  readonly maxUnknownDialogueRatio?: number;
}

const NORMALIZED_DIALOGUE_QUOTE_PATTERN =
  /["\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u3008\u3009\u300a\u300b]/u;
const NORMALIZED_DIALOGUE_PUNCTUATION_PATTERN = /[!?\uff01\uff1f\u2026]+[)"\u201d\u2019\u300d\u300f\u3009\u300b]*\s*$/u;
const NORMALIZED_SHORT_SPEECH_PATTERN =
  /^[^\n]{1,90}(?:\u2026|\.{2,}|\u3002{2,})+["\u201d\u2019\u300d\u300f\u3009\u300b]?\s*$/u;
const DIALOGUE_SEGMENT_TYPES = new Set<LabeledSegment['type']>([
  'quoted_dialogue',
  'plain_dialogue',
  'inner_monologue',
  'unknown',
]);

function roundRatio(value: number): number {
  return Number(value.toFixed(3));
}

function isDialogueLikeParagraph(paragraph: Paragraph): boolean {
  const text = paragraph.text.trim();
  if (!text) return false;
  if (NORMALIZED_DIALOGUE_QUOTE_PATTERN.test(text)) return true;
  if (NORMALIZED_DIALOGUE_PUNCTUATION_PATTERN.test(text)) return true;
  return text.length <= 90 && NORMALIZED_SHORT_SPEECH_PATTERN.test(text);
}

function segmentOverlapsParagraph(segment: LabeledSegment, paragraph: Paragraph): boolean {
  if (segment.paragraphId !== paragraph.id) return false;
  const start = Math.max(0, segment.startOffset);
  const end = Math.min(paragraph.text.length, segment.endOffset);
  return end > start;
}

function targetCoverage(
  paragraphs: readonly Paragraph[],
  segments: readonly LabeledSegment[],
): { target: number; covered: number } {
  const segmentsByParagraph = new Map<string, LabeledSegment[]>();
  for (const segment of segments) {
    const list = segmentsByParagraph.get(segment.paragraphId) ?? [];
    list.push(segment);
    segmentsByParagraph.set(segment.paragraphId, list);
  }
  let target = 0;
  let covered = 0;
  for (const paragraph of paragraphs) {
    const coverage = new Uint8Array(paragraph.text.length);
    for (const segment of segmentsByParagraph.get(paragraph.id) ?? []) {
      const start = Math.max(0, Math.min(paragraph.text.length, segment.startOffset));
      const end = Math.max(start, Math.min(paragraph.text.length, segment.endOffset));
      coverage.fill(1, start, end);
    }
    for (let index = 0; index < paragraph.text.length; index += 1) {
      if (!/\S/u.test(paragraph.text[index])) continue;
      target += 1;
      if (coverage[index] === 1) covered += 1;
    }
  }
  return { target, covered };
}

export function validateChapterLabelingQuality(
  input: ValidateChapterLabelingQualityInput,
): ChapterLabelingQualityReport {
  const minDialogueParagraphsForCoverage = input.minDialogueParagraphsForCoverage ?? 8;
  const minDialogueCoverageRatio = input.minDialogueCoverageRatio ?? 0.55;
  const minTargetCoverageRatio = input.minTargetCoverageRatio ?? input.minChapterCoverageRatio ?? 1;
  const minSegmentsForLongChapter = input.minSegmentsForLongChapter ?? 20;
  const minDialogueSegmentsForSpeakerCoverage = input.minDialogueSegmentsForSpeakerCoverage ?? 8;
  const maxUnknownDialogueRatio = input.maxUnknownDialogueRatio ?? 0.5;

  const dialogueLikeParagraphs = input.paragraphs.filter(isDialogueLikeParagraph);
  const labeledParagraphIds = new Set(input.result.segments.map((segment) => segment.paragraphId));
  const labeledDialogueLikeParagraphIds = new Set<string>();

  for (const paragraph of dialogueLikeParagraphs) {
    const hasDialogueSegment = input.result.segments.some(
      (segment) => DIALOGUE_SEGMENT_TYPES.has(segment.type) && segmentOverlapsParagraph(segment, paragraph),
    );
    if (hasDialogueSegment) labeledDialogueLikeParagraphIds.add(paragraph.id);
  }

  const coverage = targetCoverage(input.paragraphs, input.result.segments);
  const dialogueSegmentCount = input.result.segments.filter((segment) =>
    DIALOGUE_SEGMENT_TYPES.has(segment.type),
  ).length;
  const unknownDialogueSegmentCount = input.result.segments.filter(
    (segment) => DIALOGUE_SEGMENT_TYPES.has(segment.type) && segment.speakerId === 'unknown',
  ).length;
  const unknownDialogueSegmentRatio = dialogueSegmentCount > 0 ? unknownDialogueSegmentCount / dialogueSegmentCount : 0;
  const uniqueEmotionCount = new Set(
    input.result.segments.map((segment) => segment.emotion.trim().toLowerCase()).filter(Boolean),
  ).size;
  const dialogueLikeCoverageRatio =
    dialogueLikeParagraphs.length > 0 ? labeledDialogueLikeParagraphIds.size / dialogueLikeParagraphs.length : 1;
  const targetCoverageRatio = coverage.target > 0 ? coverage.covered / coverage.target : 1;

  const metrics: ChapterLabelingQualityMetrics = {
    paragraphCount: input.paragraphs.length,
    segmentCount: input.result.segments.length,
    labeledParagraphCount: labeledParagraphIds.size,
    dialogueLikeParagraphCount: dialogueLikeParagraphs.length,
    labeledDialogueLikeParagraphCount: labeledDialogueLikeParagraphIds.size,
    dialogueLikeCoverageRatio: roundRatio(dialogueLikeCoverageRatio),
    coveredCharacters: coverage.covered,
    targetNonWhitespaceCharacters: coverage.target,
    coveredTargetNonWhitespaceCharacters: coverage.covered,
    targetCoverageRatio: roundRatio(targetCoverageRatio),
    dialogueSegmentCount,
    unknownDialogueSegmentCount,
    unknownDialogueSegmentRatio: roundRatio(unknownDialogueSegmentRatio),
    uniqueEmotionCount,
  };

  const issues: ChapterLabelingQualityIssue[] = [];
  if (input.paragraphs.length > 0 && input.result.segments.length === 0) {
    issues.push({
      severity: 'error',
      code: 'empty_segments',
      message: 'Chapter labeling returned no segments.',
      value: 0,
      threshold: 1,
    });
  }

  const shouldCheckDialogueCoverage = dialogueLikeParagraphs.length >= minDialogueParagraphsForCoverage;
  if (shouldCheckDialogueCoverage && dialogueLikeCoverageRatio < minDialogueCoverageRatio) {
    issues.push({
      severity: 'error',
      code: 'dialogue_like_coverage_low',
      message: 'Too many likely dialogue paragraphs were skipped or labeled as non-dialogue.',
      value: metrics.dialogueLikeCoverageRatio,
      threshold: minDialogueCoverageRatio,
    });
  }

  if (targetCoverageRatio < minTargetCoverageRatio) {
    issues.push({
      severity: 'error',
      code: 'target_coverage_low',
      message: 'Chapter labeling leaves non-whitespace text uncovered in the target window.',
      value: metrics.targetCoverageRatio,
      threshold: minTargetCoverageRatio,
    });
  }

  if (
    input.paragraphs.length >= 80 &&
    dialogueLikeParagraphs.length >= minDialogueParagraphsForCoverage &&
    input.result.segments.length < minSegmentsForLongChapter
  ) {
    issues.push({
      severity: 'warning',
      code: 'long_chapter_segment_count_low',
      message: 'Long chapter produced an unusually small number of labeled segments.',
      value: input.result.segments.length,
      threshold: minSegmentsForLongChapter,
    });
  }

  if (
    dialogueSegmentCount >= minDialogueSegmentsForSpeakerCoverage &&
    unknownDialogueSegmentRatio > maxUnknownDialogueRatio
  ) {
    issues.push({
      severity: 'error',
      code: 'unknown_speaker_ratio_high',
      message: 'Too many dialogue segments still have unknown speakers.',
      value: metrics.unknownDialogueSegmentRatio,
      threshold: maxUnknownDialogueRatio,
    });
  }

  if (dialogueSegmentCount >= 10 && uniqueEmotionCount <= 1) {
    issues.push({
      severity: 'warning',
      code: 'emotion_diversity_low',
      message: 'Many dialogue segments share a single emotion label.',
      value: uniqueEmotionCount,
      threshold: 2,
    });
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  return {
    ok: errorCount === 0,
    issues,
    summary: {
      errorCount,
      warningCount,
      issueCodes: [...new Set(issues.map((issue) => issue.code))],
    },
    metrics,
  };
}

export function chapterLabelingQualityErrorMessage(report: ChapterLabelingQualityReport): string {
  if (report.ok) return 'Chapter labeling quality passed.';
  const codes = report.summary.issueCodes.length > 0 ? report.summary.issueCodes.join(', ') : 'unknown';
  return `Chapter labeling quality failed: ${codes}`;
}
