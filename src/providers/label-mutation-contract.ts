import type { LabeledSegment, SegmentType, UserCorrection } from '../domain/types';
import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { CONTROLLED_TTS_SEGMENT_TYPES } from './chapter-labeling-v2-contract';

export interface AnalysisFencesV2 {
  readonly contentRevisionId: string;
  readonly chapterTextHash?: string;
  readonly graphRevisionId?: string;
  readonly graphFingerprint?: string;
  readonly correctionRevisionId: string;
  readonly segmentCollectionRevision: string;
  readonly contextRevisionId?: string;
  readonly workflowGeneration?: number;
}

export interface LabelMutationProsodyIntent {
  readonly pace?: string;
  readonly intensity?: string;
  readonly delivery?: string;
}

export interface CharacterReferenceRuleV1 {
  readonly surface: string;
  readonly characterId: string;
  readonly fromChapterIndex: number;
  readonly toChapterIndex?: number;
}

export type LabelMutationIntent =
  | { readonly kind: 'segment_only' }
  | { readonly kind: 'relabel_from_window'; readonly windowId: string }
  | { readonly kind: 'reference_mapping'; readonly rule: CharacterReferenceRuleV1 };

export interface LabelMutationPatch {
  readonly segmentType?: SegmentType;
  readonly speakerId?: string;
  readonly listenerIds?: readonly string[];
  readonly emotion?: string;
  readonly prosodyIntent?: LabelMutationProsodyIntent | null;
}

export interface ApplyLabelCorrectionEditV2 {
  readonly segmentId: string;
  readonly expectedSegmentHash: string;
  readonly patch: LabelMutationPatch;
  readonly intent: LabelMutationIntent;
}

export interface ApplyLabelCorrectionsCommandV2 {
  readonly operationId: string;
  readonly bookId: string;
  readonly chapterId: string;
  readonly createdAt: string;
  readonly expected: AnalysisFencesV2;
  readonly edits: readonly ApplyLabelCorrectionEditV2[];
  readonly sourceReviewArtifactId?: string;
}

export interface LabelMutationInvalidationV2 {
  readonly contextFromWindowId?: string;
  readonly relabelPlanId?: string;
  readonly obsoleteReviewArtifactIds: readonly string[];
  readonly staleTTSRenderItemIds: readonly string[];
}

export interface ApplyLabelCorrectionsResultV2 {
  readonly operationId: string;
  readonly revisions: {
    readonly segmentCollectionRevision: string;
    readonly correctionRevisionId: string;
  };
  readonly updatedSegmentIds: readonly string[];
  readonly createdCorrectionIds: readonly string[];
  readonly invalidation: LabelMutationInvalidationV2;
  readonly syncEventIds: readonly string[];
}

export interface LabelMutationOperationReceiptV2 extends ApplyLabelCorrectionsResultV2 {
  readonly commandHash: string;
  readonly appliedAt: string;
}

export interface LabelMutationPlanV2 {
  readonly command: ApplyLabelCorrectionsCommandV2;
  readonly commandHash: string;
  readonly segments: readonly LabeledSegment[];
  readonly corrections: readonly UserCorrection[];
  readonly changedFieldsBySegment: Readonly<Record<string, readonly LabelMutationField[]>>;
  readonly requiresContextInvalidation: boolean;
  readonly contextFromWindowId?: string;
  readonly relabelPlanId?: string;
  readonly staleTTSSegmentIds: readonly string[];
}

export type LabelMutationField = 'segmentType' | 'speakerId' | 'listenerIds' | 'emotion' | 'prosodyIntent';

export class LabelMutationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabelMutationInputError';
  }
}

export class LabelMutationConflictError extends Error {
  constructor(
    message: string,
    readonly reason: 'operation_reused' | 'segment_missing' | 'segment_changed' | 'fence_changed',
  ) {
    super(message);
    this.name = 'LabelMutationConflictError';
  }
}

const MAX_EDITS = 50;

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new LabelMutationInputError(`${label} is required`);
  return normalized;
}

function normalizeStringArray(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeProsody(value: LabelMutationProsodyIntent | null): LabelMutationProsodyIntent | null {
  if (value === null) return null;
  const normalized = {
    pace: value.pace?.trim() || undefined,
    intensity: value.intensity?.trim() || undefined,
    delivery: value.delivery?.trim() || undefined,
  };
  return normalized.pace || normalized.intensity || normalized.delivery ? normalized : null;
}

export function normalizeLabelMutationIntent(intent: LabelMutationIntent): LabelMutationIntent {
  if (intent.kind === 'segment_only') return intent;
  if (intent.kind === 'relabel_from_window') {
    return { kind: intent.kind, windowId: requiredString(intent.windowId, 'intent.windowId') };
  }
  const surface = requiredString(intent.rule.surface, 'intent.rule.surface');
  const characterId = requiredString(intent.rule.characterId, 'intent.rule.characterId');
  if (!Number.isSafeInteger(intent.rule.fromChapterIndex) || intent.rule.fromChapterIndex < 0) {
    throw new LabelMutationInputError('intent.rule.fromChapterIndex must be a non-negative integer');
  }
  if (
    intent.rule.toChapterIndex !== undefined &&
    (!Number.isSafeInteger(intent.rule.toChapterIndex) || intent.rule.toChapterIndex < intent.rule.fromChapterIndex)
  ) {
    throw new LabelMutationInputError('intent.rule.toChapterIndex must not precede fromChapterIndex');
  }
  return {
    kind: intent.kind,
    rule: {
      surface,
      characterId,
      fromChapterIndex: intent.rule.fromChapterIndex,
      toChapterIndex: intent.rule.toChapterIndex,
    },
  };
}

export function normalizeApplyLabelCorrectionsCommandV2(
  input: ApplyLabelCorrectionsCommandV2,
): ApplyLabelCorrectionsCommandV2 {
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new LabelMutationInputError('createdAt must be ISO-8601');
  if (input.edits.length === 0 || input.edits.length > MAX_EDITS) {
    throw new LabelMutationInputError(`edits must contain between 1 and ${MAX_EDITS} items`);
  }
  const seen = new Set<string>();
  const edits = input.edits.map((edit) => {
    const segmentId = requiredString(edit.segmentId, 'edit.segmentId');
    if (seen.has(segmentId)) throw new LabelMutationInputError(`duplicate segment edit: ${segmentId}`);
    seen.add(segmentId);
    if (edit.patch.segmentType !== undefined && !CONTROLLED_TTS_SEGMENT_TYPES.includes(edit.patch.segmentType)) {
      throw new LabelMutationInputError(`edit.patch.segmentType is invalid: ${edit.patch.segmentType}`);
    }
    const patch: LabelMutationPatch = {
      ...(edit.patch.speakerId !== undefined
        ? { speakerId: requiredString(edit.patch.speakerId, 'edit.patch.speakerId') }
        : {}),
      ...(edit.patch.segmentType !== undefined
        ? { segmentType: requiredString(edit.patch.segmentType, 'edit.patch.segmentType') as SegmentType }
        : {}),
      ...(edit.patch.listenerIds !== undefined ? { listenerIds: normalizeStringArray(edit.patch.listenerIds) } : {}),
      ...(edit.patch.emotion !== undefined
        ? { emotion: requiredString(edit.patch.emotion, 'edit.patch.emotion') }
        : {}),
      ...(edit.patch.prosodyIntent !== undefined ? { prosodyIntent: normalizeProsody(edit.patch.prosodyIntent) } : {}),
    };
    if (Object.keys(patch).length === 0) throw new LabelMutationInputError(`edit patch is empty: ${segmentId}`);
    return {
      segmentId,
      expectedSegmentHash: requiredString(edit.expectedSegmentHash, 'edit.expectedSegmentHash'),
      patch,
      intent: normalizeLabelMutationIntent(edit.intent),
    };
  });
  const expected = {
    ...input.expected,
    contentRevisionId: requiredString(input.expected.contentRevisionId, 'expected.contentRevisionId'),
    correctionRevisionId: requiredString(input.expected.correctionRevisionId, 'expected.correctionRevisionId'),
    segmentCollectionRevision: requiredString(
      input.expected.segmentCollectionRevision,
      'expected.segmentCollectionRevision',
    ),
  };
  return {
    operationId: requiredString(input.operationId, 'operationId'),
    bookId: requiredString(input.bookId, 'bookId'),
    chapterId: requiredString(input.chapterId, 'chapterId'),
    createdAt: new Date(input.createdAt).toISOString(),
    expected,
    edits,
    sourceReviewArtifactId: input.sourceReviewArtifactId?.trim() || undefined,
  };
}

export function labelMutationCommandHash(command: ApplyLabelCorrectionsCommandV2): string {
  return structuredIntegrityHash(normalizeApplyLabelCorrectionsCommandV2(command));
}

export function labelMutationSegmentHash(segment: LabeledSegment): string {
  return structuredIntegrityHash({
    id: segment.id,
    novelId: segment.novelId,
    chapterId: segment.chapterId,
    paragraphId: segment.paragraphId,
    segmentIndex: segment.segmentIndex,
    startOffset: segment.startOffset,
    endOffset: segment.endOffset,
    segmentTextHash: segment.segmentTextHash,
    type: segment.type,
    speakerId: segment.speakerId,
    candidateSpeakers: [...segment.candidateSpeakers].sort(),
    listenerIds: [...segment.listenerIds].sort(),
    emotion: segment.emotion,
    prosodyIntent: segment.prosodyIntent ?? null,
    voiceProfileId: segment.voiceProfileId ?? null,
    isUserCorrected: segment.isUserCorrected,
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function correctionType(field: LabelMutationField): UserCorrection['correctionType'] {
  if (field === 'segmentType') return 'segment_type';
  if (field === 'speakerId') return 'speaker';
  if (field === 'listenerIds') return 'listener';
  if (field === 'prosodyIntent') return 'prosody';
  return 'emotion';
}

function correctionScope(intent: LabelMutationIntent): UserCorrection['applyScope'] {
  return intent.kind === 'segment_only' ? 'segment' : 'future_pattern';
}

function correctionForField(
  command: ApplyLabelCorrectionsCommandV2,
  edit: ApplyLabelCorrectionEditV2,
  segment: LabeledSegment,
  field: LabelMutationField,
  before: unknown,
  after: unknown,
): UserCorrection {
  return {
    id: persistentId128('label_mutation_correction', [command.operationId, segment.id, field]),
    novelId: command.bookId,
    chapterId: command.chapterId,
    paragraphId: segment.paragraphId,
    segmentId: segment.id,
    correctionType: correctionType(field),
    beforeJson: JSON.stringify({ [field]: before ?? null }),
    afterJson: JSON.stringify({ [field]: after ?? null }),
    applyScope: correctionScope(edit.intent),
    operationId: command.operationId,
    intentKind: edit.intent.kind,
    intentJson: JSON.stringify(edit.intent),
    provenanceKind: 'user_label_mutation',
    sourceReviewArtifactId: command.sourceReviewArtifactId,
    createdAt: command.createdAt,
  };
}

export function buildLabelMutationPlanV2(
  input: ApplyLabelCorrectionsCommandV2,
  currentSegments: readonly LabeledSegment[],
): LabelMutationPlanV2 {
  const command = normalizeApplyLabelCorrectionsCommandV2(input);
  const segmentById = new Map(currentSegments.map((segment) => [segment.id, segment]));
  const nextById = new Map(currentSegments.map((segment) => [segment.id, segment]));
  const corrections: UserCorrection[] = [];
  const changedFieldsBySegment: Record<string, LabelMutationField[]> = {};
  const staleTTSSegmentIds = new Set<string>();
  let requiresContextInvalidation = false;
  let contextFromWindowId: string | undefined;
  let relabelPlanId: string | undefined;

  for (const edit of command.edits) {
    const segment = segmentById.get(edit.segmentId);
    if (!segment) throw new LabelMutationConflictError(`segment is missing: ${edit.segmentId}`, 'segment_missing');
    if (segment.novelId !== command.bookId || segment.chapterId !== command.chapterId) {
      throw new LabelMutationInputError(`segment is outside command scope: ${edit.segmentId}`);
    }
    if (labelMutationSegmentHash(segment) !== edit.expectedSegmentHash) {
      throw new LabelMutationConflictError(`segment changed: ${edit.segmentId}`, 'segment_changed');
    }
    const changed: LabelMutationField[] = [];
    let next: LabeledSegment = { ...segment };
    if (edit.patch.segmentType !== undefined && edit.patch.segmentType !== segment.type) {
      changed.push('segmentType');
      next = { ...next, type: edit.patch.segmentType };
      corrections.push(correctionForField(command, edit, segment, 'segmentType', segment.type, edit.patch.segmentType));
      requiresContextInvalidation = true;
      staleTTSSegmentIds.add(segment.id);
    }
    if (edit.patch.speakerId !== undefined && edit.patch.speakerId !== segment.speakerId) {
      changed.push('speakerId');
      next = {
        ...next,
        speakerId: edit.patch.speakerId,
        candidateSpeakers: edit.patch.speakerId === 'unknown' ? segment.candidateSpeakers : [edit.patch.speakerId],
        confidence: edit.patch.speakerId === 'unknown' ? segment.confidence : 1,
        voiceProfileId: undefined,
      };
      corrections.push(
        correctionForField(command, edit, segment, 'speakerId', segment.speakerId, edit.patch.speakerId),
      );
      requiresContextInvalidation = true;
      staleTTSSegmentIds.add(segment.id);
    }
    if (edit.patch.listenerIds !== undefined && !sameJson(edit.patch.listenerIds, segment.listenerIds)) {
      changed.push('listenerIds');
      next = { ...next, listenerIds: [...edit.patch.listenerIds] };
      corrections.push(
        correctionForField(command, edit, segment, 'listenerIds', segment.listenerIds, edit.patch.listenerIds),
      );
      requiresContextInvalidation = true;
    }
    if (edit.patch.emotion !== undefined && edit.patch.emotion !== segment.emotion) {
      changed.push('emotion');
      next = { ...next, emotion: edit.patch.emotion };
      corrections.push(correctionForField(command, edit, segment, 'emotion', segment.emotion, edit.patch.emotion));
      staleTTSSegmentIds.add(segment.id);
    }
    if (edit.patch.prosodyIntent !== undefined && !sameJson(edit.patch.prosodyIntent, segment.prosodyIntent)) {
      changed.push('prosodyIntent');
      next = { ...next, prosodyIntent: edit.patch.prosodyIntent ?? undefined };
      corrections.push(
        correctionForField(command, edit, segment, 'prosodyIntent', segment.prosodyIntent, edit.patch.prosodyIntent),
      );
      staleTTSSegmentIds.add(segment.id);
    }
    if (changed.length === 0) throw new LabelMutationInputError(`edit does not change segment: ${edit.segmentId}`);
    nextById.set(segment.id, { ...next, isUserCorrected: true });
    changedFieldsBySegment[segment.id] = changed;
    if (edit.intent.kind === 'relabel_from_window') {
      contextFromWindowId = contextFromWindowId ?? edit.intent.windowId;
      relabelPlanId =
        relabelPlanId ?? persistentId128('label_reanalysis_plan', [command.operationId, edit.intent.windowId]);
    } else if (edit.intent.kind === 'reference_mapping') {
      relabelPlanId = relabelPlanId ?? persistentId128('label_reanalysis_plan', [command.operationId, 'reference']);
    }
  }

  return {
    command,
    commandHash: structuredIntegrityHash(command),
    segments: currentSegments.map((segment) => nextById.get(segment.id) ?? segment),
    corrections,
    changedFieldsBySegment,
    requiresContextInvalidation,
    contextFromWindowId,
    relabelPlanId,
    staleTTSSegmentIds: [...staleTTSSegmentIds].sort(),
  };
}
