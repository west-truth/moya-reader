import { persistentId128 } from '@noveldesk/text-core/hash';
import type { LabeledSegment, UserCorrection } from '../domain/types';
import type { ChapterLabelingResult } from './ai';
import {
  normalizeLabelMutationIntent,
  type LabelMutationField,
  type LabelMutationIntent,
} from './label-mutation-contract';

export type AnalysisReviewEditIntentMap = Readonly<Record<string, LabelMutationIntent>>;

export interface AnalysisReviewCorrectionPlanV2 {
  readonly operationId: string;
  readonly segments: readonly LabeledSegment[];
  readonly corrections: readonly UserCorrection[];
  readonly changedFieldsBySegment: Readonly<Record<string, readonly LabelMutationField[]>>;
  readonly contextFromWindowId?: string;
  readonly relabelPlanId?: string;
  readonly staleTTSSegmentIds: readonly string[];
}

interface AnalysisReviewCorrectionPlanInput {
  readonly operationId: string;
  readonly reviewArtifactId: string;
  readonly bookId: string;
  readonly chapterId: string;
  readonly windowId: string;
  readonly createdAt: string;
  readonly original: ChapterLabelingResult;
  readonly approved: ChapterLabelingResult;
  readonly editIntents?: AnalysisReviewEditIntentMap;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function anchorKey(segment: LabeledSegment): string {
  return `${segment.paragraphId}:${segment.startOffset}:${segment.endOffset}`;
}

export function materializeLabelingSegmentProsody(result: ChapterLabelingResult): LabeledSegment[] {
  return result.segments.map((segment) => ({
    ...segment,
    prosodyIntent: result.segmentAnnotations?.[segment.id]?.prosodyIntent
      ? { ...result.segmentAnnotations[segment.id].prosodyIntent }
      : segment.prosodyIntent,
  }));
}

export function normalizeAnalysisReviewEditIntents(
  intents: AnalysisReviewEditIntentMap | undefined,
  segmentIds: readonly string[],
): Record<string, LabelMutationIntent> {
  const allowed = new Set(segmentIds);
  return Object.fromEntries(
    Object.entries(intents ?? {})
      .filter(([segmentId]) => allowed.has(segmentId))
      .map(([segmentId, intent]) => [segmentId, normalizeLabelMutationIntent(intent)]),
  );
}

function correctionType(field: LabelMutationField): UserCorrection['correctionType'] {
  if (field === 'segmentType') return 'segment_type';
  if (field === 'speakerId') return 'speaker';
  if (field === 'listenerIds') return 'listener';
  if (field === 'prosodyIntent') return 'prosody';
  return 'emotion';
}

function correctionForField(
  input: AnalysisReviewCorrectionPlanInput,
  segment: LabeledSegment,
  intent: LabelMutationIntent,
  field: LabelMutationField,
  before: unknown,
  after: unknown,
): UserCorrection {
  return {
    id: persistentId128('analysis_review_correction', [input.operationId, segment.id, field]),
    novelId: input.bookId,
    chapterId: input.chapterId,
    paragraphId: segment.paragraphId,
    segmentId: segment.id,
    correctionType: correctionType(field),
    beforeJson: JSON.stringify({ [field]: before ?? null }),
    afterJson: JSON.stringify({ [field]: after ?? null }),
    applyScope: intent.kind === 'segment_only' ? 'segment' : 'future_pattern',
    operationId: input.operationId,
    intentKind: intent.kind,
    intentJson: JSON.stringify(intent),
    provenanceKind: 'user_label_mutation',
    sourceReviewArtifactId: input.reviewArtifactId,
    createdAt: input.createdAt,
  };
}

export function buildAnalysisReviewCorrectionPlanV2(
  input: AnalysisReviewCorrectionPlanInput,
): AnalysisReviewCorrectionPlanV2 {
  const originals = materializeLabelingSegmentProsody(input.original);
  const approved = materializeLabelingSegmentProsody(input.approved);
  const originalById = new Map(originals.map((segment) => [segment.id, segment]));
  const originalByAnchor = new Map<string, LabeledSegment>();
  const duplicateAnchors = new Set<string>();
  for (const segment of originals) {
    const key = anchorKey(segment);
    if (originalByAnchor.has(key)) duplicateAnchors.add(key);
    else originalByAnchor.set(key, segment);
  }
  duplicateAnchors.forEach((key) => originalByAnchor.delete(key));

  const intents = normalizeAnalysisReviewEditIntents(
    input.editIntents,
    approved.map((segment) => segment.id),
  );
  const corrections: UserCorrection[] = [];
  const changedFieldsBySegment: Record<string, LabelMutationField[]> = {};
  const staleTTS = new Set<string>();
  let contextFromWindowId: string | undefined;
  let relabelPlanId: string | undefined;

  const segments = approved.map((segment) => {
    const original = originalById.get(segment.id) ?? originalByAnchor.get(anchorKey(segment));
    const intent = intents[segment.id] ?? ({ kind: 'segment_only' } as const);
    const fields: Array<[LabelMutationField, unknown, unknown]> = [];
    if (!original || original.type !== segment.type) fields.push(['segmentType', original?.type, segment.type]);
    if (original && original.speakerId !== segment.speakerId) {
      fields.push(['speakerId', original.speakerId, segment.speakerId]);
    }
    if (original && !sameJson(original.listenerIds, segment.listenerIds)) {
      fields.push(['listenerIds', original.listenerIds, segment.listenerIds]);
    }
    if (original && original.emotion !== segment.emotion) fields.push(['emotion', original.emotion, segment.emotion]);
    if (original && !sameJson(original.prosodyIntent, segment.prosodyIntent)) {
      fields.push(['prosodyIntent', original.prosodyIntent, segment.prosodyIntent]);
    }
    if (fields.length === 0) return segment;

    changedFieldsBySegment[segment.id] = fields.map(([field]) => field);
    for (const [field, before, after] of fields) {
      corrections.push(correctionForField(input, segment, intent, field, before, after));
      if (field !== 'listenerIds') staleTTS.add(segment.id);
    }
    if (intent.kind === 'relabel_from_window') {
      contextFromWindowId = contextFromWindowId ?? intent.windowId;
      relabelPlanId = relabelPlanId ?? persistentId128('label_reanalysis_plan', [input.operationId, intent.windowId]);
    } else if (intent.kind === 'reference_mapping') {
      relabelPlanId = relabelPlanId ?? persistentId128('label_reanalysis_plan', [input.operationId, 'reference']);
    } else if (fields.some(([field]) => field === 'speakerId' || field === 'listenerIds' || field === 'segmentType')) {
      contextFromWindowId = contextFromWindowId ?? input.windowId;
    }
    return { ...segment, isUserCorrected: true };
  });

  return {
    operationId: input.operationId,
    segments,
    corrections,
    changedFieldsBySegment,
    contextFromWindowId,
    relabelPlanId,
    staleTTSSegmentIds: [...staleTTS].sort(),
  };
}
