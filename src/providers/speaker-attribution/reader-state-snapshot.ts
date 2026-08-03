import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { AddressUseEventV1 } from './address-event';
import type { CandidateMemoryViewV2 } from './candidate-memory';
import type { SourceMentionInventoryV1 } from './mention-inventory';
import { activeAddressUseEvents, activeTemporalRelationEdges } from './temporal-relation-state';
import type { TemporalRelationEdgeV1 } from './temporal-relation';

export const CHARACTER_TEMPORAL_SNAPSHOT_VERSION = 'character-temporal-snapshot-v1' as const;
export const TEMPORAL_SNAPSHOT_COMPILER_VERSION = 'temporal-snapshot-compiler-v1' as const;

export type CharacterTemporalReaderModeV1 = 'reader_safe' | 'omniscient_consistent' | 'streaming';

export const TEMPORAL_SNAPSHOT_CONFLICT = {
  futureRelationExcluded: 1,
  provisionalRelationExcluded: 2,
  storyTimeUnsafe: 3,
  timelineMismatch: 4,
  candidateEdgeLimit: 5,
  ambiguousAlias: 6,
} as const;

export interface TemporalSceneContextV1 {
  readonly sceneId: string;
  readonly narrativeOrder: number;
  readonly timelineId?: string;
  readonly storyTimeBucket?: string;
  readonly isFlashback?: boolean;
  readonly readerMode: CharacterTemporalReaderModeV1;
}

export interface CharacterTemporalSnapshotV1 {
  readonly version: typeof CHARACTER_TEMPORAL_SNAPSHOT_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly narrativeOrder: number;
  readonly timelineId?: string;
  readonly storyTimeBucket?: string;
  readonly readerMode: CharacterTemporalReaderModeV1;
  readonly candidateDictionary: readonly (readonly [ordinal: number, entityId: string, displayName: string])[];
  readonly surfaceDictionary: readonly (readonly [ordinal: number, surface: string])[];
  readonly relationDictionary: readonly (readonly [ordinal: number, relationType: string])[];
  readonly addressDictionary: readonly (readonly [ordinal: number, address: string])[];
  readonly activeSpeakerEntityIds: readonly string[];
  readonly aliasOrdinals: readonly (readonly [surfaceOrdinal: number, candidateOrdinal: number])[];
  readonly relationEdges: readonly (readonly [
    subjectOrdinal: number,
    relationOrdinal: number,
    objectOrdinal: number,
    qualityCode: number,
  ])[];
  readonly addressHints: readonly (readonly [
    userOrdinal: number,
    targetOrdinal: number,
    addressOrdinal: number,
    qualityCode: number,
  ])[];
  readonly conflictCodes: readonly number[];
  readonly excludedCounts: Readonly<{
    future: number;
    provisional: number;
    storyTime: number;
    timeline: number;
    candidateLimit: number;
  }>;
  readonly sourceRevision: string;
  readonly graphRevision: string;
  readonly correctionCursor: string;
  readonly mentionInventoryHash: string;
  readonly candidateMemoryHash: string;
  readonly addressEventRevision: string;
  readonly temporalRelationRevision: string;
  readonly dependencyIds: readonly string[];
  readonly compilerVersion: typeof TEMPORAL_SNAPSHOT_COMPILER_VERSION;
  readonly fingerprint: string;
}

function inside(value: number, start?: number, end?: number): boolean {
  return (start === undefined || value >= start) && (end === undefined || value <= end);
}

export function temporalRelationEdgeVisible(edge: TemporalRelationEdgeV1, context: TemporalSceneContextV1): boolean {
  if (edge.status !== 'confirmed') return false;
  if (edge.timelineId && context.timelineId && edge.timelineId !== context.timelineId) return false;
  if (context.isFlashback && !context.storyTimeBucket) return false;
  if (
    context.storyTimeBucket &&
    edge.validFromStoryTime &&
    edge.validToStoryTime &&
    ![edge.validFromStoryTime, edge.validToStoryTime].includes(context.storyTimeBucket)
  ) {
    return false;
  }
  if (context.readerMode !== 'omniscient_consistent') {
    if (edge.readerVisibleFromOrder === undefined) return false;
    if (!inside(context.narrativeOrder, edge.readerVisibleFromOrder, edge.readerVisibleToOrder)) return false;
  }
  return context.readerMode === 'omniscient_consistent'
    ? true
    : inside(context.narrativeOrder, edge.effectiveFromNarrativeOrder, edge.effectiveToNarrativeOrder);
}

function relationQuality(edge: TemporalRelationEdgeV1): number {
  if (edge.confidenceKind === 'human_verified') return 3;
  if (edge.confidenceKind === 'calibrated' || edge.confidence >= 0.9) return 2;
  return 1;
}

function eventQuality(event: AddressUseEventV1): number {
  if (event.confidenceKind === 'human_verified') return 3;
  if (event.relationStatus === 'confirmed' && event.confidence >= 0.85) return 2;
  return 1;
}

function revisionHash(rows: readonly { readonly id: string; readonly fingerprint: string }[]): string {
  return structuredIntegrityHash(rows.map((row) => [row.id, row.fingerprint]));
}

export function buildCharacterTemporalSnapshot(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly narrativeOrder: number;
  readonly timelineId?: string;
  readonly storyTimeBucket?: string;
  readonly isFlashback?: boolean;
  readonly readerMode: CharacterTemporalReaderModeV1;
  readonly candidateMemory: CandidateMemoryViewV2;
  readonly candidateEntityIds?: readonly string[];
  readonly mentionInventory: SourceMentionInventoryV1;
  readonly addressEvents: readonly AddressUseEventV1[];
  readonly temporalRelationEdges: readonly TemporalRelationEdgeV1[];
  readonly sourceRevision: string;
  readonly graphRevision: string;
  readonly correctionCursor?: string;
  readonly maxEdgesPerCandidate?: number;
}): CharacterTemporalSnapshotV1 {
  const selectedEntityIds = new Set(
    input.candidateEntityIds ?? input.candidateMemory.entities.map((row) => row.entityId),
  );
  const entities = input.candidateMemory.entities
    .filter((entity) => selectedEntityIds.has(entity.entityId))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  const candidateDictionary = entities.map(
    (entity, index) => [index + 4, entity.entityId, entity.displayName] as const,
  );
  const ordinalByEntityId = new Map(candidateDictionary.map(([ordinal, entityId]) => [entityId, ordinal]));
  const context: TemporalSceneContextV1 = {
    sceneId: input.sceneId,
    narrativeOrder: input.narrativeOrder,
    timelineId: input.timelineId,
    storyTimeBucket: input.storyTimeBucket,
    isFlashback: input.isFlashback,
    readerMode: input.readerMode,
  };

  const excluded = { future: 0, provisional: 0, storyTime: 0, timeline: 0, candidateLimit: 0 };
  const relevantEdges = activeTemporalRelationEdges(input.temporalRelationEdges).filter(
    (edge) => ordinalByEntityId.has(edge.subjectSpeakerEntityId) && ordinalByEntityId.has(edge.objectSpeakerEntityId),
  );
  const visibleEdges: TemporalRelationEdgeV1[] = [];
  for (const edge of relevantEdges) {
    if (edge.status !== 'confirmed') {
      excluded.provisional += 1;
      continue;
    }
    if (edge.timelineId && input.timelineId && edge.timelineId !== input.timelineId) {
      excluded.timeline += 1;
      continue;
    }
    if (input.isFlashback && !input.storyTimeBucket) {
      excluded.storyTime += 1;
      continue;
    }
    if (!temporalRelationEdgeVisible(edge, context)) {
      excluded.future += 1;
      continue;
    }
    visibleEdges.push(edge);
  }

  const maxEdgesPerCandidate = Math.max(2, Math.min(4, input.maxEdgesPerCandidate ?? 4));
  const edgeCounts = new Map<string, number>();
  const cappedEdges: TemporalRelationEdgeV1[] = [];
  for (const edge of visibleEdges.sort(
    (left, right) =>
      relationQuality(right) - relationQuality(left) ||
      right.confidence - left.confidence ||
      right.evidenceEventIds.length - left.evidenceEventIds.length ||
      left.id.localeCompare(right.id),
  )) {
    const subjectCount = edgeCounts.get(edge.subjectSpeakerEntityId) ?? 0;
    const objectCount = edgeCounts.get(edge.objectSpeakerEntityId) ?? 0;
    if (subjectCount >= maxEdgesPerCandidate || objectCount >= maxEdgesPerCandidate) {
      excluded.candidateLimit += 1;
      continue;
    }
    cappedEdges.push(edge);
    edgeCounts.set(edge.subjectSpeakerEntityId, subjectCount + 1);
    edgeCounts.set(edge.objectSpeakerEntityId, objectCount + 1);
  }

  const relationTypes = [...new Set(cappedEdges.map((edge) => edge.relationType))].sort();
  const relationDictionary = relationTypes.map((relationType, ordinal) => [ordinal, relationType] as const);
  const relationOrdinalByType = new Map(relationDictionary.map(([ordinal, relationType]) => [relationType, ordinal]));
  const relationEdges = cappedEdges
    .map(
      (edge) =>
        [
          ordinalByEntityId.get(edge.subjectSpeakerEntityId)!,
          relationOrdinalByType.get(edge.relationType)!,
          ordinalByEntityId.get(edge.objectSpeakerEntityId)!,
          relationQuality(edge),
        ] as const,
    )
    .sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);

  const sceneMentions = input.mentionInventory.mentions.filter((mention) => mention.sceneId === input.sceneId);
  const surfaces = [...new Set(sceneMentions.map((mention) => mention.normalizedSurface).filter(Boolean))].sort();
  const surfaceDictionary = surfaces.map((surface, ordinal) => [ordinal, surface] as const);
  const surfaceOrdinalByValue = new Map(surfaceDictionary.map(([ordinal, surface]) => [surface, ordinal]));
  const aliasOrdinals: Array<readonly [number, number]> = [];
  let ambiguousAlias = false;
  for (const surface of surfaces) {
    const matches = entities.filter((entity) => entity.normalizedSurfaces.includes(surface));
    if (matches.length === 1) {
      aliasOrdinals.push([surfaceOrdinalByValue.get(surface)!, ordinalByEntityId.get(matches[0]!.entityId)!]);
    } else if (matches.length > 1) {
      ambiguousAlias = true;
    }
  }

  const activeEvents = activeAddressUseEvents(input.addressEvents).filter(
    (event) => event.sceneId === input.sceneId && event.contextType === 'direct' && event.status === 'reconciled',
  );
  const addresses = [
    ...new Set(
      activeEvents
        .filter(
          (event) =>
            event.speakerCandidateIds.length === 1 &&
            event.addresseeCandidateIds.length === 1 &&
            ordinalByEntityId.has(event.speakerCandidateIds[0]!) &&
            ordinalByEntityId.has(event.addresseeCandidateIds[0]!),
        )
        .map((event) => event.normalizedSurface),
    ),
  ].sort();
  const addressDictionary = addresses.map((address, ordinal) => [ordinal, address] as const);
  const addressOrdinalByValue = new Map(addressDictionary.map(([ordinal, address]) => [address, ordinal]));
  const rawAddressHints = activeEvents.flatMap((event): Array<readonly [number, number, number, number]> => {
    const subject = event.speakerCandidateIds[0];
    const object = event.addresseeCandidateIds[0];
    if (
      event.speakerCandidateIds.length !== 1 ||
      event.addresseeCandidateIds.length !== 1 ||
      !subject ||
      !object ||
      !ordinalByEntityId.has(subject) ||
      !ordinalByEntityId.has(object)
    ) {
      return [];
    }
    return [
      [
        ordinalByEntityId.get(subject)!,
        ordinalByEntityId.get(object)!,
        addressOrdinalByValue.get(event.normalizedSurface)!,
        eventQuality(event),
      ],
    ];
  });
  const uniqueAddressHints = [
    ...new Map(
      rawAddressHints
        .sort((left, right) => right[3] - left[3])
        .map((hint) => [`${hint[0]}:${hint[1]}:${hint[2]}`, hint]),
    ).values(),
  ];
  const addressHintCounts = new Map<number, number>();
  const addressHints = uniqueAddressHints
    .filter((hint) => {
      const subjectCount = addressHintCounts.get(hint[0]) ?? 0;
      const objectCount = addressHintCounts.get(hint[1]) ?? 0;
      if (subjectCount >= 4 || objectCount >= 4) {
        excluded.candidateLimit += 1;
        return false;
      }
      addressHintCounts.set(hint[0], subjectCount + 1);
      addressHintCounts.set(hint[1], objectCount + 1);
      return true;
    })
    .sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);

  const conflictCodes = [
    ...(excluded.future > 0 ? [TEMPORAL_SNAPSHOT_CONFLICT.futureRelationExcluded] : []),
    ...(excluded.provisional > 0 ? [TEMPORAL_SNAPSHOT_CONFLICT.provisionalRelationExcluded] : []),
    ...(excluded.storyTime > 0 ? [TEMPORAL_SNAPSHOT_CONFLICT.storyTimeUnsafe] : []),
    ...(excluded.timeline > 0 ? [TEMPORAL_SNAPSHOT_CONFLICT.timelineMismatch] : []),
    ...(excluded.candidateLimit > 0 ? [TEMPORAL_SNAPSHOT_CONFLICT.candidateEdgeLimit] : []),
    ...(ambiguousAlias ? [TEMPORAL_SNAPSHOT_CONFLICT.ambiguousAlias] : []),
  ].sort((left, right) => left - right);
  const activeEventsForRevision = activeAddressUseEvents(input.addressEvents);
  const activeEdgesForRevision = activeTemporalRelationEdges(input.temporalRelationEdges);
  const core = {
    version: CHARACTER_TEMPORAL_SNAPSHOT_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    sceneId: input.sceneId,
    narrativeOrder: input.narrativeOrder,
    timelineId: input.timelineId,
    storyTimeBucket: input.storyTimeBucket,
    readerMode: input.readerMode,
    candidateDictionary,
    surfaceDictionary,
    relationDictionary,
    addressDictionary,
    activeSpeakerEntityIds: candidateDictionary.map(([, entityId]) => entityId),
    aliasOrdinals: aliasOrdinals.sort((left, right) => left[0] - right[0] || left[1] - right[1]),
    relationEdges,
    addressHints,
    conflictCodes,
    excludedCounts: excluded,
    sourceRevision: input.sourceRevision,
    graphRevision: input.graphRevision,
    correctionCursor: input.correctionCursor ?? 'none',
    mentionInventoryHash: input.mentionInventory.fingerprint,
    candidateMemoryHash: input.candidateMemory.fingerprint,
    addressEventRevision: revisionHash(activeEventsForRevision),
    temporalRelationRevision: revisionHash(activeEdgesForRevision),
    dependencyIds: [
      input.mentionInventory.id,
      input.candidateMemory.id,
      ...activeEventsForRevision.map((event) => event.id),
      ...cappedEdges.map((edge) => edge.id),
    ].sort(),
    compilerVersion: TEMPORAL_SNAPSHOT_COMPILER_VERSION,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('character_temporal_snapshot', [
      input.contentRevisionId,
      input.sceneId,
      input.readerMode,
      fingerprint,
    ]),
    fingerprint,
  };
}
