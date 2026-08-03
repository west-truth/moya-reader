import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import {
  temporalRelationEdgeVisible,
  type CharacterTemporalReaderModeV1,
  type TemporalSceneContextV1,
} from './reader-state-snapshot';
import type { TemporalRelationEdgeV1 } from './temporal-relation';

export const TEMPORAL_INVALIDATION_PLAN_VERSION = 'temporal-invalidation-plan-v1' as const;

export interface TemporalSceneDependencyV1 extends TemporalSceneContextV1 {
  readonly chapterId: string;
  readonly candidateEntityIds: readonly string[];
  readonly snapshotId?: string;
  readonly dialogueBurstIds?: readonly string[];
}

export interface TemporalInvalidationPlanV1 {
  readonly version: typeof TEMPORAL_INVALIDATION_PLAN_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly reason: 'relation_added' | 'relation_removed' | 'relation_interval_changed' | 'relation_evidence_changed';
  readonly sceneIds: readonly string[];
  readonly chapterIds: readonly string[];
  readonly snapshotIds: readonly string[];
  readonly dialogueBurstIds: readonly string[];
  readonly staleArtifactKinds: readonly ['temporal_snapshot', 'speaker_labels', 'tts_projection'];
  readonly fingerprint: string;
}

function relevant(edge: TemporalRelationEdgeV1 | undefined, scene: TemporalSceneDependencyV1): boolean {
  if (!edge) return false;
  const candidates = new Set(scene.candidateEntityIds);
  return candidates.has(edge.subjectSpeakerEntityId) && candidates.has(edge.objectSpeakerEntityId);
}

function visibleProjection(
  edge: TemporalRelationEdgeV1 | undefined,
  scene: TemporalSceneDependencyV1,
): string | undefined {
  if (!edge || !relevant(edge, scene) || !temporalRelationEdgeVisible(edge, scene)) return undefined;
  return structuredIntegrityHash({
    subject: edge.subjectSpeakerEntityId,
    relation: edge.relationType,
    object: edge.objectSpeakerEntityId,
    direction: edge.direction,
    confidenceKind: edge.confidenceKind,
    confidence: edge.confidence,
    evidenceEventIds: edge.evidenceEventIds,
  });
}

function invalidationReason(
  before: TemporalRelationEdgeV1 | undefined,
  after: TemporalRelationEdgeV1 | undefined,
): TemporalInvalidationPlanV1['reason'] {
  if (!before) return 'relation_added';
  if (!after || after.status === 'rejected' || after.status === 'superseded') return 'relation_removed';
  const intervalBefore = [
    before.readerVisibleFromOrder,
    before.readerVisibleToOrder,
    before.effectiveFromNarrativeOrder,
    before.effectiveToNarrativeOrder,
    before.validFromStoryTime,
    before.validToStoryTime,
  ];
  const intervalAfter = [
    after.readerVisibleFromOrder,
    after.readerVisibleToOrder,
    after.effectiveFromNarrativeOrder,
    after.effectiveToNarrativeOrder,
    after.validFromStoryTime,
    after.validToStoryTime,
  ];
  return structuredIntegrityHash(intervalBefore) === structuredIntegrityHash(intervalAfter)
    ? 'relation_evidence_changed'
    : 'relation_interval_changed';
}

export function buildTemporalInvalidationPlan(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly before?: TemporalRelationEdgeV1;
  readonly after?: TemporalRelationEdgeV1;
  readonly scenes: readonly TemporalSceneDependencyV1[];
}): TemporalInvalidationPlanV1 {
  const affected = input.scenes.filter(
    (scene) => visibleProjection(input.before, scene) !== visibleProjection(input.after, scene),
  );
  const reason = invalidationReason(input.before, input.after);
  const core = {
    version: TEMPORAL_INVALIDATION_PLAN_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    reason,
    sceneIds: [...new Set(affected.map((scene) => scene.sceneId))].sort(),
    chapterIds: [...new Set(affected.map((scene) => scene.chapterId))].sort(),
    snapshotIds: [...new Set(affected.flatMap((scene) => (scene.snapshotId ? [scene.snapshotId] : [])))].sort(),
    dialogueBurstIds: [...new Set(affected.flatMap((scene) => scene.dialogueBurstIds ?? []))].sort(),
    staleArtifactKinds: ['temporal_snapshot', 'speaker_labels', 'tts_projection'] as const,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('temporal_invalidation_plan', [
      input.contentRevisionId,
      input.before?.id ?? 'none',
      input.after?.id ?? 'none',
      fingerprint,
    ]),
    fingerprint,
  };
}

export function temporalSceneDependency(input: {
  readonly sceneId: string;
  readonly chapterId: string;
  readonly narrativeOrder: number;
  readonly candidateEntityIds: readonly string[];
  readonly readerMode?: CharacterTemporalReaderModeV1;
  readonly timelineId?: string;
  readonly storyTimeBucket?: string;
  readonly isFlashback?: boolean;
  readonly snapshotId?: string;
  readonly dialogueBurstIds?: readonly string[];
}): TemporalSceneDependencyV1 {
  return {
    ...input,
    candidateEntityIds: [...new Set(input.candidateEntityIds)].sort(),
    dialogueBurstIds: [...new Set(input.dialogueBurstIds ?? [])].sort(),
    readerMode: input.readerMode ?? 'reader_safe',
  };
}
