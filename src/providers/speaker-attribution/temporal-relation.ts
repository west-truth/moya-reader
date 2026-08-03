import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { CharacterGraphKnowledgeV2 } from '../character-graph-v2';
import type { AddressUseEventV1 } from './address-event';

export const TEMPORAL_RELATION_EDGE_VERSION = 'temporal-relation-edge-v1' as const;

export interface TemporalRelationEdgeV1 {
  readonly version: typeof TEMPORAL_RELATION_EDGE_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly subjectSpeakerEntityId: string;
  readonly relationType: string;
  readonly objectSpeakerEntityId: string;
  readonly direction: 'directed' | 'symmetric';
  readonly timelineId?: string;
  readonly validFromStoryTime?: string;
  readonly validToStoryTime?: string;
  readonly observedAtSceneId: string;
  readonly readerVisibleFromOrder?: number;
  readonly readerVisibleToOrder?: number;
  readonly effectiveFromNarrativeOrder?: number;
  readonly effectiveToNarrativeOrder?: number;
  readonly evidenceEventIds: readonly string[];
  readonly confidenceKind: 'rule' | 'model_score' | 'calibrated' | 'human_verified';
  readonly confidence: number;
  readonly status: 'confirmed' | 'provisional' | 'ambiguous' | 'rejected' | 'superseded';
  readonly provenance: 'address_observation' | 'legacy_import' | 'user_correction' | 'model_hypothesis';
  readonly assertedAtRevision: string;
  readonly supersedesEdgeId?: string;
  readonly supersededAtRevision?: string;
  readonly fingerprint: string;
}

function relationTypeForAddress(addressClass: AddressUseEventV1['addressClass']): string {
  return `address:${addressClass}`;
}

function temporalRelationEdge(
  core: Omit<TemporalRelationEdgeV1, 'version' | 'id' | 'fingerprint'>,
): TemporalRelationEdgeV1 {
  const versioned = { version: TEMPORAL_RELATION_EDGE_VERSION, ...core };
  const fingerprint = structuredIntegrityHash(versioned);
  return {
    ...versioned,
    id: persistentId128('temporal_relation_edge', [
      core.contentRevisionId,
      core.subjectSpeakerEntityId,
      core.relationType,
      core.objectSpeakerEntityId,
      core.assertedAtRevision,
      fingerprint,
    ]),
    fingerprint,
  };
}

export function reconcileAddressUseEvent(
  current: AddressUseEventV1,
  input: {
    readonly speakerEntityId: string;
    readonly addresseeEntityId: string;
    readonly revision: string;
    readonly confidenceKind?: AddressUseEventV1['confidenceKind'];
    readonly confidence?: number;
    readonly relationStatus?: AddressUseEventV1['relationStatus'];
    readonly contextType?: AddressUseEventV1['contextType'];
  },
): AddressUseEventV1 {
  if (current.status === 'rejected' || current.status === 'superseded') {
    throw new Error(`Address event ${current.id} cannot be reconciled from ${current.status}`);
  }
  if (input.speakerEntityId === input.addresseeEntityId) {
    throw new Error('Address event speaker and addressee must differ');
  }
  const { id: _currentId, fingerprint: _currentFingerprint, ...currentCore } = current;
  const eventCore = {
    ...currentCore,
    speakerCandidateIds: [input.speakerEntityId],
    addresseeCandidateIds: [input.addresseeEntityId],
    status: 'reconciled' as const,
    relationStatus: input.relationStatus ?? ('candidate' as const),
    contextType: input.contextType ?? current.contextType,
    confidenceKind: input.confidenceKind ?? ('calibrated' as const),
    confidence: Math.max(0, Math.min(1, input.confidence ?? current.confidence)),
    revision: input.revision,
    supersedesEventId: current.id,
    supersededBy: undefined,
  };
  const fingerprint = structuredIntegrityHash(eventCore);
  return {
    ...eventCore,
    id: persistentId128('address_use_event_revision', [current.id, input.revision, fingerprint]),
    fingerprint,
  };
}

export function deriveTemporalRelationEdgesFromAddressEvents(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly events: readonly AddressUseEventV1[];
  readonly assertedAtRevision: string;
}): readonly TemporalRelationEdgeV1[] {
  const supersededEventIds = new Set(
    input.events.flatMap((event) => (event.supersedesEventId ? [event.supersedesEventId] : [])),
  );
  const groups = new Map<string, AddressUseEventV1[]>();
  for (const event of input.events) {
    if (
      supersededEventIds.has(event.id) ||
      event.status !== 'reconciled' ||
      event.relationStatus === 'rejected' ||
      event.contextType !== 'direct' ||
      event.speakerCandidateIds.length !== 1 ||
      event.addresseeCandidateIds.length !== 1
    ) {
      continue;
    }
    const subject = event.speakerCandidateIds[0]!;
    const object = event.addresseeCandidateIds[0]!;
    if (subject === object) continue;
    const relationType = relationTypeForAddress(event.addressClass);
    const key = `${subject}:${relationType}:${object}:${event.timelineId ?? ''}:${event.storyTimeBucket ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.values()]
    .map((events) => {
      const sorted = [...events].sort(
        (left, right) => left.narrativeOrder - right.narrativeOrder || left.id.localeCompare(right.id),
      );
      const first = sorted[0]!;
      const evidenceEventIds = [...new Set(sorted.map((event) => event.id))].sort();
      const humanVerified = sorted.some((event) => event.confidenceKind === 'human_verified');
      const reliable = sorted.filter(
        (event) =>
          event.confidenceKind === 'human_verified' ||
          (event.confidenceKind === 'calibrated' && event.confidence >= 0.85),
      );
      const independentlyConfirmed = new Set(reliable.map((event) => `${event.sceneId}:${event.spanId}`)).size >= 2;
      const confirmed = humanVerified || independentlyConfirmed;
      const confidence = sorted.reduce((total, event) => total + event.confidence, 0) / sorted.length;
      return temporalRelationEdge({
        bookId: input.bookId,
        contentRevisionId: input.contentRevisionId,
        subjectSpeakerEntityId: first.speakerCandidateIds[0]!,
        relationType: relationTypeForAddress(first.addressClass),
        objectSpeakerEntityId: first.addresseeCandidateIds[0]!,
        direction: 'directed',
        timelineId: first.timelineId,
        validFromStoryTime: first.storyTimeBucket,
        observedAtSceneId: sorted.at(-1)!.sceneId,
        readerVisibleFromOrder: confirmed ? Math.max(...sorted.map((event) => event.narrativeOrder)) : undefined,
        effectiveFromNarrativeOrder: Math.min(...sorted.map((event) => event.narrativeOrder)),
        evidenceEventIds,
        confidenceKind: humanVerified ? 'human_verified' : 'rule',
        confidence,
        status: confirmed ? 'confirmed' : 'provisional',
        provenance: humanVerified ? 'user_correction' : 'address_observation',
        assertedAtRevision: input.assertedAtRevision,
      });
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function legacyTemporalRelationEdges(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly graphKnowledge: CharacterGraphKnowledgeV2;
  readonly speakerEntityIdByCharacterId: Readonly<Record<string, string>>;
  readonly graphRevision: string;
}): readonly TemporalRelationEdgeV1[] {
  return input.graphKnowledge.relationFacts
    .filter((fact) => fact.status !== 'rejected')
    .flatMap((fact): TemporalRelationEdgeV1[] => {
      const subject = input.speakerEntityIdByCharacterId[fact.sourceCharacterId];
      const object = input.speakerEntityIdByCharacterId[fact.targetCharacterId];
      if (!subject || !object || subject === object) return [];
      const confirmed = fact.lockedByUser;
      return [
        temporalRelationEdge({
          bookId: input.bookId,
          contentRevisionId: input.contentRevisionId,
          subjectSpeakerEntityId: subject,
          relationType: fact.relationLabel,
          objectSpeakerEntityId: object,
          direction: 'directed',
          observedAtSceneId: fact.validity.sceneId ?? `chapter_${fact.validity.fromChapterIndex}`,
          readerVisibleFromOrder: fact.validity.fromChapterIndex * 1_000_000,
          effectiveFromNarrativeOrder: fact.validity.fromChapterIndex * 1_000_000,
          effectiveToNarrativeOrder:
            fact.validity.toChapterIndex === undefined ? undefined : fact.validity.toChapterIndex * 1_000_000 + 999_999,
          evidenceEventIds: [...fact.evidenceIds].sort(),
          confidenceKind: confirmed ? 'human_verified' : 'model_score',
          confidence: fact.confidence,
          status: confirmed ? 'confirmed' : 'provisional',
          provenance: 'legacy_import',
          assertedAtRevision: input.graphRevision,
        }),
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function supersedeTemporalRelationEdge(
  current: TemporalRelationEdgeV1,
  patch: Partial<
    Pick<
      TemporalRelationEdgeV1,
      | 'status'
      | 'readerVisibleFromOrder'
      | 'readerVisibleToOrder'
      | 'effectiveFromNarrativeOrder'
      | 'effectiveToNarrativeOrder'
      | 'validFromStoryTime'
      | 'validToStoryTime'
      | 'confidence'
      | 'confidenceKind'
    >
  > & { readonly assertedAtRevision: string },
): TemporalRelationEdgeV1 {
  const {
    version: _version,
    id: _id,
    fingerprint: _fingerprint,
    supersededAtRevision: _supersededAtRevision,
    ...currentCore
  } = current;
  return temporalRelationEdge({
    ...currentCore,
    ...patch,
    supersedesEdgeId: current.id,
    provenance: 'user_correction',
    assertedAtRevision: patch.assertedAtRevision,
    supersededAtRevision: undefined,
  });
}
