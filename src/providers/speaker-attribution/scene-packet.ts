import { structuredIntegrityHash, textIntegrityHash } from '@noveldesk/text-core/hash';
import type {
  DialogueBurstInventoryV1,
  SpeakerSourceParagraphInput,
  SpeakerSpanInventoryV1,
} from '@noveldesk/text-core/speaker-attribution';
import type { CandidateMemoryViewV2 } from './candidate-memory';
import type { CandidateSelectionDecisionV1 } from './candidate-selector';
import { SCENE_SPEAKER_PACKET_VERSION, SpeakerSpanTypeCode, type SceneSpeakerPacketV3 } from './contracts';
import type { DeterministicSpeakerSieveResultV1 } from './deterministic-sieve';
import type { SourceMentionInventoryV1, SourceMentionType } from './mention-inventory';
import type { CharacterTemporalSnapshotV1 } from './reader-state-snapshot';
import { buildSpeakerContextEnvelope, sliceSpeakerContextEnvelope } from './speaker-context-envelope';

const mentionTypeCode: Readonly<Record<SourceMentionType, number>> = {
  name: 0,
  name_variant: 1,
  title_name: 2,
  role_description: 3,
  address_name: 4,
  address_term: 5,
  pronoun: 6,
  group_entity: 7,
  generic_role: 8,
};

export function buildSceneSpeakerPacket(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly sourceRevision: string;
  readonly sourceManifestFingerprint: string;
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly mentionInventory: SourceMentionInventoryV1;
  readonly dialogueBurstInventory: DialogueBurstInventoryV1;
  readonly candidateMemory: CandidateMemoryViewV2;
  readonly candidateSelections: Readonly<Record<string, CandidateSelectionDecisionV1>>;
  readonly temporalSnapshot: CharacterTemporalSnapshotV1;
  readonly sieve: DeterministicSpeakerSieveResultV1;
  readonly paragraphs: readonly SpeakerSourceParagraphInput[];
  readonly correctionCursor?: string;
  readonly dialogueBurstIds?: readonly string[];
  readonly providerTargetSpanIds?: readonly string[];
  readonly maxTargets?: number;
  readonly candidateHardCap?: number;
}): SceneSpeakerPacketV3 {
  if (input.temporalSnapshot.sceneId !== input.sceneId)
    throw new Error('Temporal snapshot scene does not match packet');
  const selectedBurstIds = input.dialogueBurstIds ? new Set(input.dialogueBurstIds) : undefined;
  const bursts = input.dialogueBurstInventory.bursts.filter(
    (burst) => burst.sceneId === input.sceneId && (!selectedBurstIds || selectedBurstIds.has(burst.id)),
  );
  const allowedTargetSpanIds = new Set(input.providerTargetSpanIds ?? input.sieve.providerTargetSpanIds);
  const targetSpanIds = new Set(
    bursts.flatMap((burst) => burst.spanIds.filter((spanId) => allowedTargetSpanIds.has(spanId))),
  );
  const targets = input.spanInventory.spans.filter((span) => targetSpanIds.has(span.id));
  const maxTargets = Math.max(1, Math.min(40, input.maxTargets ?? 40));
  if (targets.length === 0) throw new Error('Scene speaker packet requires at least one provider target');
  if (targets.length > maxTargets)
    throw new Error('Scene speaker packet target budget exceeded; split the request window');

  const candidateEntityIds = [
    ...new Set(targets.flatMap((span) => input.candidateSelections[span.id]?.selectedEntityIds ?? [])),
  ].sort();
  const candidateHardCap = Math.max(1, Math.min(24, input.candidateHardCap ?? 24));
  if (candidateEntityIds.length > candidateHardCap) {
    throw new Error('Scene speaker packet candidate hard cap exceeded; split by dialogue burst');
  }
  const memoryById = new Map(input.candidateMemory.entities.map((entity) => [entity.entityId, entity]));
  const evidenceBitsByEntity = new Map<string, number>();
  for (const span of targets) {
    for (const evidence of input.candidateSelections[span.id]?.evidence ?? []) {
      evidenceBitsByEntity.set(evidence.entityId, (evidenceBitsByEntity.get(evidence.entityId) ?? 0) | evidence.bits);
    }
  }
  const candidates = candidateEntityIds.map((entityId, index) => {
    const entity = memoryById.get(entityId);
    if (!entity) throw new Error(`Packet candidate ${entityId} is absent from Candidate Memory`);
    return [index + 4, entityId, entity.displayName, evidenceBitsByEntity.get(entityId) ?? 0] as const;
  });
  const ordinalByEntityId = new Map(candidates.map(([ordinal, entityId]) => [entityId, ordinal]));
  const candidateSourceAnchors = candidates.flatMap(([ordinal, entityId]) => {
    const anchor = memoryById.get(entityId)?.firstEvidence;
    return anchor
      ? [
          [
            ordinal,
            anchor.mentionId,
            anchor.sceneId,
            anchor.paragraphId,
            anchor.paragraphIndex,
            anchor.spanId,
            anchor.spanIndex,
            anchor.startOffset,
            anchor.endOffset,
          ] as const,
        ]
      : [];
  });
  const spanById = new Map(input.spanInventory.spans.map((span) => [span.id, span]));
  const targetPositionBySpanId = new Map(targets.map((span, index) => [span.id, index]));
  const originalBurstOrdinalById = new Map(bursts.map((burst, index) => [burst.id, index]));
  const burstOrdinalBySpanId = new Map(
    bursts.flatMap((burst, index) => burst.spanIds.map((spanId) => [spanId, index] as const)),
  );
  const paragraphById = new Map(input.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph]));

  const selectedOriginalMentionOrdinals = new Set(
    targets.flatMap((span) => input.candidateSelections[span.id]?.newFromMentionOrdinals ?? []),
  );
  const sourceMentions = input.mentionInventory.mentions
    .filter(
      (mention) => targetPositionBySpanId.has(mention.spanId) || selectedOriginalMentionOrdinals.has(mention.ordinal),
    )
    .sort((left, right) => left.ordinal - right.ordinal);
  const localMentionOrdinalByOriginal = new Map(sourceMentions.map((mention, ordinal) => [mention.ordinal, ordinal]));
  const mentions = sourceMentions.map(
    (mention, ordinal) => [ordinal, mention.normalizedSurface, mentionTypeCode[mention.type]] as const,
  );
  const mentionSourceIds = sourceMentions.map((mention, ordinal) => [ordinal, mention.id] as const);
  const newMentionOrdinalsByTarget = targets.flatMap((span, targetPosition) => {
    const ordinals = (input.candidateSelections[span.id]?.newFromMentionOrdinals ?? []).flatMap((original) => {
      const local = localMentionOrdinalByOriginal.get(original);
      return local === undefined ? [] : [local];
    });
    return ordinals.length > 0 ? ([[targetPosition, [...new Set(ordinals)].sort((a, b) => a - b)]] as const) : [];
  });

  const snapshotEntityByOrdinal = new Map(
    input.temporalSnapshot.candidateDictionary.map(([ordinal, entityId]) => [ordinal, entityId]),
  );
  const relationHints = input.temporalSnapshot.relationEdges.flatMap(
    ([snapshotSubject, relationCode, snapshotObject, qualityCode]) => {
      const subject = ordinalByEntityId.get(snapshotEntityByOrdinal.get(snapshotSubject) ?? '');
      const object = ordinalByEntityId.get(snapshotEntityByOrdinal.get(snapshotObject) ?? '');
      return subject === undefined || object === undefined
        ? []
        : ([[subject, relationCode, object, qualityCode]] as const);
    },
  );
  const usedRelationCodes = new Set(relationHints.map(([, relationCode]) => relationCode));
  const relationDictionary = input.temporalSnapshot.relationDictionary.filter(([relationCode]) =>
    usedRelationCodes.has(relationCode),
  );
  const recentTurns = input.candidateMemory.recentTurns.flatMap((turn) => {
    const entity = input.candidateMemory.entities.find((candidate) => candidate.characterId === turn.speakerId);
    const ordinal = entity ? ordinalByEntityId.get(entity.entityId) : undefined;
    return ordinal === undefined ? [] : ([[ordinal, turn.text.slice(0, 500)]] as const);
  });
  const dialogueBursts = bursts
    .map((burst) => {
      const spanIndexes = burst.spanIds
        .filter((spanId) => targetPositionBySpanId.has(spanId))
        .map((spanId) => spanById.get(spanId)!.spanIndex);
      const candidatePoolOrdinals = burst.participantCandidateIds
        .flatMap((entityId) => {
          const ordinal = ordinalByEntityId.get(entityId);
          return ordinal === undefined ? [] : [ordinal];
        })
        .sort((left, right) => left - right);
      return [originalBurstOrdinalById.get(burst.id)!, spanIndexes, candidatePoolOrdinals] as const;
    })
    .filter(([, spanIndexes]) => spanIndexes.length > 0);
  const targetTuples = targets.map((span) => {
    const paragraph = paragraphById.get(span.paragraphId);
    if (!paragraph) throw new Error(`Packet target ${span.id} has no source paragraph`);
    const text = paragraph.text.slice(span.startOffset, span.endOffset);
    if (textIntegrityHash(text) !== span.textHash) throw new Error(`Packet target ${span.id} source hash is stale`);
    const selection = input.candidateSelections[span.id];
    const selected = selection?.selectedEntityIds ?? [];
    const candidateOrdinals = selected.map((entityId) => ordinalByEntityId.get(entityId)!);
    const evidenceByEntity = new Map((selection?.evidence ?? []).map((evidence) => [evidence.entityId, evidence.bits]));
    return [
      span.spanIndex,
      burstOrdinalBySpanId.get(span.id) ?? 0,
      SpeakerSpanTypeCode[span.type],
      text,
      candidateOrdinals,
      selected.map((entityId) => evidenceByEntity.get(entityId) ?? 0),
    ] as const;
  });
  const sourceMentionById = new Map(input.mentionInventory.mentions.map((mention) => [mention.id, mention]));
  const supportingMentionsByTargetSpanId = Object.fromEntries(
    targets.map((span) => [
      span.id,
      (input.candidateSelections[span.id]?.supportingSourceMentionIds ?? [])
        .map((mentionId) => {
          const mention = sourceMentionById.get(mentionId);
          if (!mention)
            throw new Error(`Packet target ${span.id} has a missing supporting source mention: ${mentionId}`);
          return mention;
        })
        .sort((left, right) => right.spanIndex - left.spanIndex || right.ordinal - left.ordinal),
    ]),
  );
  const contextEnvelope = buildSpeakerContextEnvelope({
    sceneId: input.sceneId,
    targets,
    spanInventory: input.spanInventory,
    paragraphs: input.paragraphs,
    supportingMentionsByTargetSpanId,
  });
  const ordinalDictionaryFingerprint = structuredIntegrityHash({
    candidates,
    mentions,
    mentionSourceIds,
    relationDictionary,
    relationHints,
  });
  const core = {
    version: 6 as const,
    contract: SCENE_SPEAKER_PACKET_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    sceneId: input.sceneId,
    sourceRevision: input.sourceRevision,
    sourceManifestFingerprint: input.sourceManifestFingerprint,
    spanInventoryHash: input.spanInventory.fingerprint,
    mentionInventoryHash: input.mentionInventory.fingerprint,
    candidateMemoryHash: input.candidateMemory.fingerprint,
    temporalSnapshotId: input.temporalSnapshot.id,
    temporalSnapshotHash: input.temporalSnapshot.fingerprint,
    dialogueBurstInventoryHash: input.dialogueBurstInventory.fingerprint,
    sieveVersion: input.sieve.version,
    correctionCursor: input.correctionCursor ?? 'none',
    mode: input.temporalSnapshot.readerMode,
    candidates,
    candidateSourceAnchors,
    mentions,
    mentionSourceIds,
    newMentionOrdinalsByTarget,
    recentTurns,
    relationDictionary,
    relationHints,
    dialogueBursts,
    contextEnvelope,
    targets: targetTuples,
    ordinalDictionaryFingerprint,
  };
  return { ...core, fingerprint: structuredIntegrityHash(core) };
}

export function sliceSceneSpeakerPacketTargets(
  packet: SceneSpeakerPacketV3,
  selectedSpanIndexes: readonly number[],
): SceneSpeakerPacketV3 {
  const selected = new Set(selectedSpanIndexes);
  const retainedPositions = packet.targets.flatMap((target, position) => (selected.has(target[0]) ? [position] : []));
  if (retainedPositions.length === 0) throw new Error('Speaker packet slice requires at least one selected target');
  const localPositionByOriginal = new Map(retainedPositions.map((position, local) => [position, local]));
  const targets = retainedPositions.map((position) => packet.targets[position]!);
  const retainedCandidateOrdinals = new Set(targets.flatMap((target) => target[4]));
  const candidates = packet.candidates.filter(([ordinal]) => retainedCandidateOrdinals.has(ordinal));
  const candidateSourceAnchors = packet.candidateSourceAnchors.filter(([ordinal]) =>
    retainedCandidateOrdinals.has(ordinal),
  );
  const targetSpanIndexes = new Set(targets.map((target) => target[0]));
  const dialogueBursts = packet.dialogueBursts.flatMap(([ordinal, spanIndexes, candidatePool]) => {
    const retained = spanIndexes.filter((spanIndex) => targetSpanIndexes.has(spanIndex));
    return retained.length > 0 ? ([[ordinal, retained, candidatePool]] as const) : [];
  });
  const newMentionOrdinalsByTarget = packet.newMentionOrdinalsByTarget.flatMap(
    ([originalPosition, mentionOrdinals]) => {
      const localPosition = localPositionByOriginal.get(originalPosition);
      return localPosition === undefined ? [] : ([[localPosition, mentionOrdinals]] as const);
    },
  );
  const contextEnvelope = sliceSpeakerContextEnvelope(packet.contextEnvelope, retainedPositions);
  const { fingerprint: _fingerprint, ...base } = packet;
  const retainedMentionOrdinals = new Set(newMentionOrdinalsByTarget.flatMap(([, ordinals]) => ordinals));
  const mentions = packet.mentions.filter(([ordinal]) => retainedMentionOrdinals.has(ordinal));
  const mentionSourceIds = packet.mentionSourceIds.filter(([ordinal]) => retainedMentionOrdinals.has(ordinal));
  const recentTurns = packet.recentTurns.filter(([ordinal]) => retainedCandidateOrdinals.has(ordinal));
  const relationHints = packet.relationHints.filter(
    ([subject, , object]) => retainedCandidateOrdinals.has(subject) && retainedCandidateOrdinals.has(object),
  );
  const retainedRelationCodes = new Set(relationHints.map(([, relationCode]) => relationCode));
  const relationDictionary = packet.relationDictionary.filter(([relationCode]) =>
    retainedRelationCodes.has(relationCode),
  );
  const ordinalDictionaryFingerprint = structuredIntegrityHash({
    candidates,
    candidateSourceAnchors,
    mentions,
    mentionSourceIds,
    relationDictionary,
    relationHints,
  });
  const core = {
    ...base,
    candidates,
    candidateSourceAnchors,
    mentions,
    mentionSourceIds,
    recentTurns,
    relationDictionary,
    relationHints,
    dialogueBursts,
    contextEnvelope,
    targets,
    newMentionOrdinalsByTarget,
    ordinalDictionaryFingerprint,
  };
  return { ...core, fingerprint: structuredIntegrityHash(core) };
}
