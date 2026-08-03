import type { Character, LabeledSegment, SegmentType } from '../domain/types';
import { matchesIntegrityHash } from '../domain/id-hash-contract';
import type { ChapterLabelingResult, LabelChapterSegmentsInput } from './ai';
import { CONTROLLED_TTS_EMOTIONS } from './chapter-labeling-contract';

export type ChapterLabelingValidationSeverity = 'error' | 'warning';

export interface ChapterLabelingValidationIssue {
  readonly severity: ChapterLabelingValidationSeverity;
  readonly code: string;
  readonly message: string;
  readonly segmentId?: string;
  readonly paragraphId?: string;
}

export interface ChapterLabelingValidationSummary {
  readonly errorCount: number;
  readonly warningCount: number;
  readonly issueCodes: string[];
}

export interface ChapterLabelingValidationReport {
  readonly ok: boolean;
  readonly issues: ChapterLabelingValidationIssue[];
  readonly summary: ChapterLabelingValidationSummary;
}

export interface ValidateChapterLabelingInput extends LabelChapterSegmentsInput {
  readonly result: ChapterLabelingResult;
  readonly validationPolicy?: ChapterLabelingValidationPolicy;
}

export type ChapterLabelingValidationPolicy = 'legacy' | 'strict_tts';

const allowedSegmentTypes = new Set<SegmentType>([
  'narration',
  'quoted_dialogue',
  'plain_dialogue',
  'inner_monologue',
  'system_message',
  'sfx',
  'author_note',
  'unknown',
]);
const roleSpeakerIds = new Set(['narrator', 'system', 'unknown']);

function issue(
  issues: ChapterLabelingValidationIssue[],
  severity: ChapterLabelingValidationSeverity,
  code: string,
  message: string,
  segment?: Pick<LabeledSegment, 'id' | 'paragraphId'>,
): void {
  issues.push({
    severity,
    code,
    message,
    segmentId: segment?.id,
    paragraphId: segment?.paragraphId,
  });
}

function allowedSpeakerIds(
  knownCharacters: Character[] | undefined,
  characterGraphCharacters: Character[] | undefined,
  result: ChapterLabelingResult,
  includeResultCharacters: boolean,
): Set<string> {
  return new Set([
    ...roleSpeakerIds,
    ...(knownCharacters ?? []).map((character) => character.id),
    ...(characterGraphCharacters ?? []).map((character) => character.id),
    ...(includeResultCharacters ? result.characters.map((character) => character.id) : []),
  ]);
}

function containsNonWhitespace(value: string): boolean {
  return /\S/u.test(value);
}

function validateAttributionIds(
  issues: ChapterLabelingValidationIssue[],
  segment: LabeledSegment,
  values: readonly string[],
  label: 'candidate' | 'listener',
  allowedIds: Set<string>,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value.trim() || !allowedIds.has(value)) {
      issue(
        issues,
        'error',
        `unknown_${label}_id`,
        `Segment ${label} id is not in known characters or reserved roles: ${value || '(empty)'}`,
        segment,
      );
    }
    if (seen.has(value)) {
      issue(issues, 'error', `duplicate_${label}_id`, `Segment ${label} ids must be unique.`, segment);
    }
    seen.add(value);
  }
}

function validationSummary(issues: ChapterLabelingValidationIssue[]): ChapterLabelingValidationSummary {
  return {
    errorCount: issues.filter((item) => item.severity === 'error').length,
    warningCount: issues.filter((item) => item.severity === 'warning').length,
    issueCodes: [...new Set(issues.map((item) => item.code))],
  };
}

export function validateChapterLabelingResult(input: ValidateChapterLabelingInput): ChapterLabelingValidationReport {
  const issues: ChapterLabelingValidationIssue[] = [];
  const strictTTS = input.validationPolicy === 'strict_tts';
  const paragraphById = new Map(input.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const paragraphOrder = new Map(input.paragraphs.map((paragraph, index) => [paragraph.id, index]));
  const speakers = allowedSpeakerIds(input.knownCharacters, input.characterGraph?.characters, input.result, !strictTTS);
  const characterIds = new Set([
    ...(input.knownCharacters ?? []).map((character) => character.id),
    ...(input.characterGraph?.characters ?? []).map((character) => character.id),
    ...(!strictTTS ? input.result.characters.map((character) => character.id) : []),
  ]);
  const byParagraph = new Map<string, LabeledSegment[]>();
  const segmentIds = new Set<string>();
  const segmentAnchors = new Set<string>();
  const segmentIndexes = new Set<number>();
  let previousSourceOrder: [number, number, number] | undefined;

  input.result.segments.forEach((segment, resultIndex) => {
    const paragraph = paragraphById.get(segment.paragraphId);
    if (segment.novelId !== input.novelId || segment.chapterId !== input.chapter.id) {
      issue(
        issues,
        'error',
        'segment_scope_mismatch',
        'Segment novel/chapter id does not match the labeling input.',
        segment,
      );
    }
    if (!segment.id.trim() || segmentIds.has(segment.id)) {
      issue(issues, 'error', 'duplicate_segment_id', 'Segment ids must be non-empty and unique.', segment);
    }
    segmentIds.add(segment.id);
    const anchor = `${segment.paragraphId}:${segment.startOffset}:${segment.endOffset}`;
    if (segmentAnchors.has(anchor)) {
      issue(issues, 'error', 'duplicate_segment_anchor', 'Segment paragraph/offset anchors must be unique.', segment);
    }
    segmentAnchors.add(anchor);
    if (!paragraph) {
      issue(
        issues,
        'error',
        'unknown_paragraph',
        'Segment references a paragraph that was not sent to the provider.',
        segment,
      );
      return;
    }
    if (!Number.isInteger(segment.segmentIndex) || segment.segmentIndex < 0) {
      issue(issues, 'error', 'invalid_segment_index', 'Segment index must be a non-negative integer.', segment);
    }
    if (segmentIndexes.has(segment.segmentIndex)) {
      issue(issues, 'error', 'duplicate_segment_index', 'Segment indexes must be unique.', segment);
    }
    segmentIndexes.add(segment.segmentIndex);
    if (segment.segmentIndex !== resultIndex) {
      issue(issues, 'error', 'segment_index_sequence', 'Segment indexes must be contiguous in result order.', segment);
    }
    const sourceOrder: [number, number, number] = [
      paragraphOrder.get(segment.paragraphId) ?? Number.MAX_SAFE_INTEGER,
      segment.startOffset,
      segment.endOffset,
    ];
    if (
      previousSourceOrder &&
      (sourceOrder[0] < previousSourceOrder[0] ||
        (sourceOrder[0] === previousSourceOrder[0] && sourceOrder[1] < previousSourceOrder[1]))
    ) {
      issue(
        issues,
        'error',
        'segments_out_of_source_order',
        'Segments must follow paragraph and offset order.',
        segment,
      );
    }
    previousSourceOrder = sourceOrder;
    if (!Number.isInteger(segment.startOffset) || !Number.isInteger(segment.endOffset)) {
      issue(issues, 'error', 'non_integer_offset', 'Segment offsets must be integers.', segment);
    } else if (
      segment.startOffset < 0 ||
      segment.endOffset <= segment.startOffset ||
      segment.endOffset > paragraph.text.length
    ) {
      issue(issues, 'error', 'offset_out_of_range', 'Segment offsets are outside the paragraph text.', segment);
    } else {
      const segmentText = paragraph.text.slice(segment.startOffset, segment.endOffset);
      if (!matchesIntegrityHash(segment.segmentTextHash, segmentText)) {
        issue(
          issues,
          'error',
          'segment_text_hash_mismatch',
          'Segment text hash does not match the anchored source text.',
          segment,
        );
      }
    }
    if (!allowedSegmentTypes.has(segment.type)) {
      issue(issues, 'error', 'invalid_segment_type', `Segment type is not supported: ${segment.type}`, segment);
    }
    if (!speakers.has(segment.speakerId)) {
      issue(
        issues,
        'error',
        'unknown_speaker_id',
        `Segment speaker_id is not in known characters or reserved roles: ${segment.speakerId}`,
        segment,
      );
    }
    validateAttributionIds(issues, segment, segment.candidateSpeakers, 'candidate', speakers);
    validateAttributionIds(issues, segment, segment.listenerIds, 'listener', speakers);
    if (segment.confidence < 0 || segment.confidence > 1 || !Number.isFinite(segment.confidence)) {
      issue(issues, 'error', 'confidence_out_of_range', 'Segment confidence must be between 0 and 1.', segment);
    }
    if (strictTTS && !(CONTROLLED_TTS_EMOTIONS as readonly string[]).includes(segment.emotion)) {
      issue(
        issues,
        'error',
        'invalid_emotion',
        `Strict TTS emotion is not in the controlled taxonomy: ${segment.emotion}`,
        segment,
      );
    }
    if (paragraph) {
      const list = byParagraph.get(segment.paragraphId) ?? [];
      list.push(segment);
      byParagraph.set(segment.paragraphId, list);
    }
  });

  for (const paragraph of input.paragraphs) {
    const segments = byParagraph.get(paragraph.id) ?? [];
    if (segments.length === 0 && containsNonWhitespace(paragraph.text)) {
      issue(
        issues,
        'error',
        'missing_paragraph_result',
        'Every target paragraph with source text must be represented by a segment.',
        { id: '', paragraphId: paragraph.id },
      );
      continue;
    }
    const sorted = [...segments].sort(
      (a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset || a.segmentIndex - b.segmentIndex,
    );
    let cursor = 0;
    for (const segment of sorted) {
      if (segment.startOffset < cursor) {
        issue(issues, 'error', 'overlapping_segments', 'Segments in a paragraph must not overlap.', segment);
      } else if (
        segment.startOffset > cursor &&
        containsNonWhitespace(paragraph.text.slice(cursor, segment.startOffset))
      ) {
        issue(issues, 'error', 'unlabeled_gap', 'Paragraph has unlabeled non-whitespace text.', segment);
      }
      cursor = Math.max(cursor, segment.endOffset);
    }
    if (cursor < paragraph.text.length && sorted.length > 0 && containsNonWhitespace(paragraph.text.slice(cursor))) {
      issue(issues, 'error', 'unlabeled_gap', 'Paragraph has trailing unlabeled non-whitespace text.', {
        id: '',
        paragraphId: paragraph.id,
      });
    }
  }

  if (input.result.uncertainties) {
    for (const uncertainty of input.result.uncertainties) {
      const paragraph = paragraphById.get(uncertainty.paragraphId);
      const anchor = { id: '', paragraphId: uncertainty.paragraphId };
      if (
        !paragraph ||
        !Number.isInteger(uncertainty.startOffset) ||
        !Number.isInteger(uncertainty.endOffset) ||
        uncertainty.startOffset < 0 ||
        uncertainty.endOffset <= uncertainty.startOffset ||
        uncertainty.endOffset > paragraph.text.length
      ) {
        issue(issues, 'error', 'invalid_uncertainty_span', 'Uncertainty span is outside target source text.', anchor);
      }
      if (!uncertainty.reasonCode.trim()) {
        issue(issues, 'error', 'invalid_uncertainty_reason', 'Uncertainty reason code must not be empty.', anchor);
      }
      const seenCandidates = new Set<string>();
      for (const candidateId of uncertainty.candidateIds) {
        if (!candidateId.trim() || !characterIds.has(candidateId)) {
          issue(
            issues,
            'error',
            'unknown_uncertainty_candidate_id',
            `Uncertainty candidate is not a canonical character id: ${candidateId || '(empty)'}`,
            anchor,
          );
        }
        if (seenCandidates.has(candidateId)) {
          issue(
            issues,
            'error',
            'duplicate_uncertainty_candidate_id',
            'Uncertainty candidates must be unique.',
            anchor,
          );
        }
        seenCandidates.add(candidateId);
      }
    }
  }

  if (strictTTS && input.result.episodeContextSummary) {
    const context = input.result.episodeContextSummary;
    const seenActive = new Set<string>();
    for (const characterId of context.activeCharacterIds) {
      if (!characterId.trim() || !characterIds.has(characterId)) {
        issue(
          issues,
          'error',
          'unknown_context_character_id',
          `Episode Context active character is not a canonical character id: ${characterId || '(empty)'}`,
        );
      }
      if (seenActive.has(characterId)) {
        issue(issues, 'error', 'duplicate_context_character_id', 'Episode Context active characters must be unique.');
      }
      seenActive.add(characterId);
    }
    const seenEdges = new Set<string>();
    for (const edge of context.interlocutorEdges ?? []) {
      const key = `${edge.sourceCharacterId}:${edge.targetCharacterId}`;
      if (
        !characterIds.has(edge.sourceCharacterId) ||
        !characterIds.has(edge.targetCharacterId) ||
        edge.sourceCharacterId === edge.targetCharacterId
      ) {
        issue(
          issues,
          'error',
          'invalid_context_interlocutor',
          `Episode Context interlocutor edge is not between two canonical characters: ${key}`,
        );
      }
      if (seenEdges.has(key)) {
        issue(issues, 'error', 'duplicate_context_interlocutor', 'Episode Context interlocutor edges must be unique.');
      }
      if (
        edge.confidence !== undefined &&
        (!Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1)
      ) {
        issue(
          issues,
          'error',
          'invalid_context_interlocutor_confidence',
          'Interlocutor confidence must be between 0 and 1.',
        );
      }
      seenEdges.add(key);
    }
  }

  const summary = validationSummary(issues);
  return {
    ok: summary.errorCount === 0,
    issues,
    summary,
  };
}

export function chapterLabelingValidationErrorMessage(report: ChapterLabelingValidationReport): string {
  const errors = report.issues.filter((item) => item.severity === 'error');
  const rendered = errors.slice(0, 5).map((item) => {
    const anchor = [item.paragraphId, item.segmentId].filter(Boolean).join('/');
    return `${item.code}${anchor ? ` at ${anchor}` : ''}: ${item.message}`;
  });
  const suffix = errors.length > rendered.length ? `; +${errors.length - rendered.length} more` : '';
  return `Chapter labeling validation failed (${report.summary.errorCount} errors): ${rendered.join('; ')}${suffix}`;
}
