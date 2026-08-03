import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { labeledSegmentId, segmentTextIntegrityHash } from '../domain/identity/ai-identities';
import type { LabeledSegment, Paragraph } from '../domain/types';
import type {
  ChapterLabelingRepairIssue,
  ChapterLabelingResult,
  ChapterLabelingSegmentAnnotation,
  RepairChapterLabelsInput,
} from './ai';
import {
  chapterLabelingV2SegmentSchema,
  parseChapterLabelingV2Segment,
  type ChapterLabelingParagraphResultV2,
  type ChapterLabelingV2Segment,
} from './chapter-labeling-v2-contract';

export const CHAPTER_LABEL_REPAIR_V2_SCHEMA_VERSION = 'chapter-label-repair-patch-v2' as const;

export type LabelRepairPatchOperationV2 =
  | {
      readonly op: 'replace_segment';
      readonly segmentId: string;
      readonly expectedAnchorHash: string;
      readonly value: ChapterLabelingV2Segment;
    }
  | {
      readonly op: 'split_segment';
      readonly segmentId: string;
      readonly expectedAnchorHash: string;
      readonly values: ChapterLabelingV2Segment[];
    }
  | {
      readonly op: 'merge_segments';
      readonly segmentIds: string[];
      readonly expectedAnchorHashes: string[];
      readonly value: ChapterLabelingV2Segment;
    }
  | {
      readonly op: 'replace_paragraph_result';
      readonly paragraphId: string;
      readonly expectedParagraphHash: string;
      readonly value: ChapterLabelingParagraphResultV2;
    }
  | {
      readonly op: 'patch_context_delta';
      readonly expectedContextHash: string;
      readonly value: {
        readonly scene: string;
        readonly activeCharacterIds: string[];
        readonly unresolved: string[];
        readonly summaryForNextChapter?: string;
      };
    };

export interface LabelRepairPatchV2 {
  readonly schemaVersion: typeof CHAPTER_LABEL_REPAIR_V2_SCHEMA_VERSION;
  readonly baseArtifactId: string;
  readonly baseArtifactHash: string;
  readonly issueIds: string[];
  readonly operations: LabelRepairPatchOperationV2[];
}

const operationSchema = {
  type: 'OBJECT',
  properties: {
    op: {
      type: 'STRING',
      enum: ['replace_segment', 'split_segment', 'merge_segments', 'replace_paragraph_result', 'patch_context_delta'],
    },
    segment_id: { type: 'STRING' },
    segment_ids: { type: 'ARRAY', items: { type: 'STRING' } },
    expected_anchor_hash: { type: 'STRING' },
    expected_anchor_hashes: { type: 'ARRAY', items: { type: 'STRING' } },
    paragraph_id: { type: 'STRING' },
    expected_paragraph_hash: { type: 'STRING' },
    expected_context_hash: { type: 'STRING' },
    value: chapterLabelingV2SegmentSchema,
    values: { type: 'ARRAY', items: chapterLabelingV2SegmentSchema },
    paragraph_value: {
      type: 'OBJECT',
      properties: {
        paragraph_id: { type: 'STRING' },
        segments: { type: 'ARRAY', items: chapterLabelingV2SegmentSchema },
        coverage_complete: { type: 'BOOLEAN' },
      },
      required: ['paragraph_id', 'segments', 'coverage_complete'],
    },
    context_value: {
      type: 'OBJECT',
      properties: {
        scene: { type: 'STRING' },
        active_character_ids: { type: 'ARRAY', items: { type: 'STRING' } },
        unresolved: { type: 'ARRAY', items: { type: 'STRING' } },
        summary_for_next_chapter: { type: 'STRING' },
      },
      required: ['scene', 'active_character_ids', 'unresolved'],
    },
  },
  required: ['op'],
} as const;

export const chapterLabelRepairPatchV2Schema = {
  type: 'OBJECT',
  properties: {
    schema_version: { type: 'STRING', enum: [CHAPTER_LABEL_REPAIR_V2_SCHEMA_VERSION] },
    base_artifact_id: { type: 'STRING' },
    base_artifact_hash: { type: 'STRING' },
    issue_ids: { type: 'ARRAY', items: { type: 'STRING' } },
    operations: { type: 'ARRAY', items: operationSchema },
  },
  required: ['schema_version', 'base_artifact_id', 'base_artifact_hash', 'issue_ids', 'operations'],
} as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return [...value];
}

function paragraphResult(value: unknown): ChapterLabelingParagraphResultV2 {
  const body = record(value, 'paragraph_value');
  if (!Array.isArray(body.segments)) throw new Error('paragraph_value.segments must be an array');
  if (body.coverage_complete !== true) throw new Error('paragraph_value.coverage_complete must be true');
  return {
    paragraph_id: stringValue(body.paragraph_id, 'paragraph_value.paragraph_id'),
    segments: body.segments.map(parseChapterLabelingV2Segment),
    coverage_complete: true,
  };
}

function parseOperation(value: unknown): LabelRepairPatchOperationV2 {
  const body = record(value, 'repair operation');
  const op = stringValue(body.op, 'repair operation.op');
  if (op === 'replace_segment') {
    return {
      op,
      segmentId: stringValue(body.segment_id, 'replace_segment.segment_id'),
      expectedAnchorHash: stringValue(body.expected_anchor_hash, 'replace_segment.expected_anchor_hash'),
      value: parseChapterLabelingV2Segment(body.value),
    };
  }
  if (op === 'split_segment') {
    if (!Array.isArray(body.values) || body.values.length < 2) {
      throw new Error('split_segment.values must contain at least two segments');
    }
    return {
      op,
      segmentId: stringValue(body.segment_id, 'split_segment.segment_id'),
      expectedAnchorHash: stringValue(body.expected_anchor_hash, 'split_segment.expected_anchor_hash'),
      values: body.values.map(parseChapterLabelingV2Segment),
    };
  }
  if (op === 'merge_segments') {
    const segmentIds = stringArray(body.segment_ids, 'merge_segments.segment_ids');
    const expectedAnchorHashes = stringArray(body.expected_anchor_hashes, 'merge_segments.expected_anchor_hashes');
    if (segmentIds.length < 2 || segmentIds.length !== expectedAnchorHashes.length) {
      throw new Error('merge_segments ids and hashes must have the same length of at least two');
    }
    return {
      op,
      segmentIds,
      expectedAnchorHashes,
      value: parseChapterLabelingV2Segment(body.value),
    };
  }
  if (op === 'replace_paragraph_result') {
    return {
      op,
      paragraphId: stringValue(body.paragraph_id, 'replace_paragraph_result.paragraph_id'),
      expectedParagraphHash: stringValue(
        body.expected_paragraph_hash,
        'replace_paragraph_result.expected_paragraph_hash',
      ),
      value: paragraphResult(body.paragraph_value),
    };
  }
  if (op === 'patch_context_delta') {
    const context = record(body.context_value, 'patch_context_delta.context_value');
    return {
      op,
      expectedContextHash: stringValue(body.expected_context_hash, 'patch_context_delta.expected_context_hash'),
      value: {
        scene: stringValue(context.scene, 'context_value.scene'),
        activeCharacterIds: stringArray(context.active_character_ids, 'context_value.active_character_ids'),
        unresolved: stringArray(context.unresolved, 'context_value.unresolved'),
        summaryForNextChapter:
          typeof context.summary_for_next_chapter === 'string' && context.summary_for_next_chapter.trim()
            ? context.summary_for_next_chapter
            : undefined,
      },
    };
  }
  throw new Error(`repair operation is unsupported: ${op}`);
}

export function parseLabelRepairPatchV2(value: unknown): LabelRepairPatchV2 {
  const body = record(value, 'label repair patch');
  if (body.schema_version !== CHAPTER_LABEL_REPAIR_V2_SCHEMA_VERSION) {
    throw new Error(`schema_version must be ${CHAPTER_LABEL_REPAIR_V2_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(body.operations)) throw new Error('repair operations must be an array');
  return {
    schemaVersion: CHAPTER_LABEL_REPAIR_V2_SCHEMA_VERSION,
    baseArtifactId: stringValue(body.base_artifact_id, 'base_artifact_id'),
    baseArtifactHash: stringValue(body.base_artifact_hash, 'base_artifact_hash'),
    issueIds: stringArray(body.issue_ids, 'issue_ids'),
    operations: body.operations.map(parseOperation),
  };
}

export function parseLabelRepairPatchV2Json(text: string): LabelRepairPatchV2 {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('provider response did not contain JSON object');
  return parseLabelRepairPatchV2(JSON.parse(trimmed.slice(start, end + 1)));
}

export function chapterLabelRepairIssueId(issue: ChapterLabelingRepairIssue): string {
  return structuredIntegrityHash({
    severity: issue.severity,
    code: issue.code,
    segmentId: issue.segmentId,
    paragraphId: issue.paragraphId,
    message: issue.message,
  });
}

export function chapterLabelSegmentAnchorHash(segment: LabeledSegment): string {
  return structuredIntegrityHash({
    segmentId: segment.id,
    paragraphId: segment.paragraphId,
    startOffset: segment.startOffset,
    endOffset: segment.endOffset,
    segmentTextHash: segment.segmentTextHash,
  });
}

function segmentFromPatch(
  input: RepairChapterLabelsInput,
  paragraph: Paragraph,
  value: ChapterLabelingV2Segment,
  preserved?: LabeledSegment,
): { segment: LabeledSegment; annotation: ChapterLabelingSegmentAnnotation } {
  if (
    !Number.isInteger(value.start_offset) ||
    !Number.isInteger(value.end_offset) ||
    value.start_offset < 0 ||
    value.end_offset <= value.start_offset ||
    value.end_offset > paragraph.text.length
  ) {
    throw new Error(`repair segment offsets are invalid: ${paragraph.id}`);
  }
  const textHash = segmentTextIntegrityHash(paragraph.text.slice(value.start_offset, value.end_offset));
  const sameAnchor =
    preserved?.paragraphId === paragraph.id &&
    preserved.startOffset === value.start_offset &&
    preserved.endOffset === value.end_offset &&
    preserved.segmentTextHash === textHash;
  const id = sameAnchor
    ? preserved.id
    : labeledSegmentId({
        novelId: input.novelId,
        chapterId: input.chapter.id,
        paragraphId: paragraph.id,
        startOffset: value.start_offset,
        endOffset: value.end_offset,
        segmentTextHash: textHash,
      });
  return {
    segment: {
      id,
      novelId: input.novelId,
      chapterId: input.chapter.id,
      paragraphId: paragraph.id,
      segmentIndex: 0,
      startOffset: value.start_offset,
      endOffset: value.end_offset,
      segmentTextHash: textHash,
      type: value.type,
      speakerId: value.speaker_id,
      candidateSpeakers: [...value.candidate_speakers],
      listenerIds: [...value.listener_ids],
      emotion: value.emotion,
      confidence: value.confidence,
      evidence: value.evidence_codes.join(','),
      voiceProfileId: sameAnchor ? preserved.voiceProfileId : undefined,
      isUserCorrected: false,
    },
    annotation: {
      evidenceCodes: [...value.evidence_codes],
      prosodyIntent: value.prosody_intent ? { ...value.prosody_intent } : undefined,
    },
  };
}

function issueScope(input: RepairChapterLabelsInput): { segmentIds: Set<string>; paragraphIds: Set<string> } {
  const segmentIds = new Set(input.validationIssues.flatMap((issue) => (issue.segmentId ? [issue.segmentId] : [])));
  const paragraphIds = new Set(
    input.validationIssues.flatMap((issue) => (issue.paragraphId ? [issue.paragraphId] : [])),
  );
  for (const segment of input.existingResult.segments) {
    if (segmentIds.has(segment.id)) paragraphIds.add(segment.paragraphId);
  }
  if (segmentIds.size === 0 && paragraphIds.size === 0) {
    for (const segment of input.existingResult.segments) {
      if (segment.speakerId === 'unknown' || segment.confidence < 0.65) {
        segmentIds.add(segment.id);
        paragraphIds.add(segment.paragraphId);
      }
    }
  }
  return { segmentIds, paragraphIds };
}

function contextRepairAllowed(input: RepairChapterLabelsInput): boolean {
  return input.validationIssues.some(
    (issue) => !issue.segmentId && !issue.paragraphId && /(?:episode|context)/i.test(issue.code),
  );
}

function sortedSegments(paragraphs: readonly Paragraph[], segments: readonly LabeledSegment[]): LabeledSegment[] {
  const paragraphOrder = new Map(paragraphs.map((paragraph, index) => [paragraph.id, index]));
  return [...segments]
    .sort(
      (a, b) =>
        (paragraphOrder.get(a.paragraphId) ?? Number.MAX_SAFE_INTEGER) -
          (paragraphOrder.get(b.paragraphId) ?? Number.MAX_SAFE_INTEGER) ||
        a.startOffset - b.startOffset ||
        a.endOffset - b.endOffset ||
        a.id.localeCompare(b.id),
    )
    .map((segment, segmentIndex) => ({ ...segment, segmentIndex }));
}

export function applyLabelRepairPatchV2(
  input: RepairChapterLabelsInput,
  patch: LabelRepairPatchV2,
): ChapterLabelingResult {
  const expectedBaseArtifactId = input.baseArtifactId ?? 'inline';
  const expectedBaseArtifactHash = input.baseArtifactHash ?? structuredIntegrityHash(input.existingResult);
  const expectedIssueIds = input.issueIds ?? input.validationIssues.map(chapterLabelRepairIssueId);
  if (patch.baseArtifactId !== expectedBaseArtifactId || patch.baseArtifactHash !== expectedBaseArtifactHash) {
    throw new Error('repair patch base artifact does not match the pinned candidate');
  }
  if (
    [...patch.issueIds].sort().join('\n') !== [...expectedIssueIds].sort().join('\n') ||
    new Set(patch.issueIds).size !== patch.issueIds.length
  ) {
    throw new Error('repair patch issue ids do not match the pinned repair issues');
  }
  if (patch.operations.length > Math.max(16, expectedIssueIds.length * 4)) {
    throw new Error('repair patch contains too many operations');
  }

  const scope = issueScope(input);
  const paragraphById = new Map(input.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const segments = new Map(input.existingResult.segments.map((segment) => [segment.id, { ...segment }]));
  const annotations: Record<string, ChapterLabelingSegmentAnnotation> = {
    ...(input.existingResult.segmentAnnotations ?? {}),
  };
  const outsideScope = new Map(
    input.existingResult.segments
      .filter((segment) => !scope.segmentIds.has(segment.id) && !scope.paragraphIds.has(segment.paragraphId))
      .map((segment) => [segment.id, JSON.stringify(segment)]),
  );
  let episodeContextSummary = input.existingResult.episodeContextSummary;

  const requireMutable = (segmentId: string): LabeledSegment => {
    const segment = segments.get(segmentId);
    if (!segment) throw new Error(`repair patch references unknown segment: ${segmentId}`);
    if (!scope.segmentIds.has(segmentId) && !scope.paragraphIds.has(segment.paragraphId)) {
      throw new Error(`repair patch changes a segment outside issue scope: ${segmentId}`);
    }
    if (segment.isUserCorrected) throw new Error(`repair patch cannot change user-corrected segment: ${segmentId}`);
    return segment;
  };

  for (const operation of patch.operations) {
    if (operation.op === 'patch_context_delta') {
      if (!contextRepairAllowed(input)) {
        throw new Error('repair patch changes context outside issue scope');
      }
      if (operation.expectedContextHash !== structuredIntegrityHash(episodeContextSummary ?? null)) {
        throw new Error('repair patch context hash is stale');
      }
      episodeContextSummary = { chapterId: input.chapter.id, ...operation.value };
      continue;
    }
    if (operation.op === 'replace_paragraph_result') {
      const paragraph = paragraphById.get(operation.paragraphId);
      if (!paragraph || operation.value.paragraph_id !== operation.paragraphId) {
        throw new Error(`repair patch paragraph is invalid: ${operation.paragraphId}`);
      }
      if (!scope.paragraphIds.has(paragraph.id)) {
        throw new Error(`repair patch changes a paragraph outside issue scope: ${paragraph.id}`);
      }
      if (operation.expectedParagraphHash !== paragraph.textHash) throw new Error('repair paragraph hash is stale');
      const previous = [...segments.values()].filter((segment) => segment.paragraphId === paragraph.id);
      if (previous.some((segment) => segment.isUserCorrected)) {
        throw new Error(`repair patch cannot replace user-corrected paragraph: ${paragraph.id}`);
      }
      for (const segment of previous) {
        segments.delete(segment.id);
        delete annotations[segment.id];
      }
      for (const value of operation.value.segments) {
        const next = segmentFromPatch(input, paragraph, value);
        segments.set(next.segment.id, next.segment);
        annotations[next.segment.id] = next.annotation;
      }
      continue;
    }

    const targetIds = operation.op === 'merge_segments' ? operation.segmentIds : [operation.segmentId];
    const targets = targetIds.map(requireMutable);
    const expectedHashes =
      operation.op === 'merge_segments' ? operation.expectedAnchorHashes : [operation.expectedAnchorHash];
    targets.forEach((segment, index) => {
      if (chapterLabelSegmentAnchorHash(segment) !== expectedHashes[index]) {
        throw new Error(`repair segment anchor hash is stale: ${segment.id}`);
      }
    });
    const paragraphId = targets[0].paragraphId;
    if (targets.some((segment) => segment.paragraphId !== paragraphId)) {
      throw new Error('repair operation cannot cross paragraph boundaries');
    }
    const paragraph = paragraphById.get(paragraphId);
    if (!paragraph) throw new Error(`repair paragraph is missing: ${paragraphId}`);
    for (const target of targets) {
      segments.delete(target.id);
      delete annotations[target.id];
    }
    const values = operation.op === 'split_segment' ? operation.values : [operation.value];
    for (const value of values) {
      const preserved = operation.op === 'replace_segment' ? targets[0] : undefined;
      const next = segmentFromPatch(input, paragraph, value, preserved);
      segments.set(next.segment.id, next.segment);
      annotations[next.segment.id] = next.annotation;
    }
  }

  for (const [segmentId, serialized] of outsideScope) {
    const current = segments.get(segmentId);
    if (!current || JSON.stringify(current) !== serialized) {
      throw new Error(`repair patch changed a segment outside issue scope: ${segmentId}`);
    }
  }
  return {
    ...input.existingResult,
    segments: sortedSegments(input.paragraphs, [...segments.values()]),
    episodeContextSummary,
    segmentAnnotations: annotations,
  };
}

export function repairPatchPromptScope(input: RepairChapterLabelsInput): {
  readonly issueIds: string[];
  readonly paragraphs: Paragraph[];
  readonly segments: LabeledSegment[];
} {
  const scope = issueScope(input);
  const paragraphIds = new Set(scope.paragraphIds);
  for (const segment of input.existingResult.segments) {
    if (scope.segmentIds.has(segment.id)) paragraphIds.add(segment.paragraphId);
  }
  if (paragraphIds.size === 0) {
    for (const paragraph of input.paragraphs) paragraphIds.add(paragraph.id);
  }
  return {
    issueIds: input.issueIds ?? input.validationIssues.map(chapterLabelRepairIssueId),
    paragraphs: input.paragraphs.filter((paragraph) => paragraphIds.has(paragraph.id)),
    segments: input.existingResult.segments.filter((segment) => paragraphIds.has(segment.paragraphId)),
  };
}
