import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { DialogueBurstInventoryV1, SpeakerSpanInventoryV1 } from '@noveldesk/text-core/speaker-attribution';
import type { ChapterLabelingResult } from '../ai';
import type { SpeakerSegmentProvenanceDraftV1 } from './accepted-speaker-provenance';
import type { CanonicalSpeakerAttributionUnitV3 } from './canonical-batch-expander';
import { SpeakerOrdinal } from './contracts';
import type { DeterministicSpeakerSieveResultV1 } from './deterministic-sieve';

interface ProviderSelection {
  readonly packetFingerprint: string;
  readonly temporalSnapshotId: string;
  readonly sequenceDecisionId?: string;
  readonly speakerEntityId?: string;
  readonly resolutionKind: SpeakerSegmentProvenanceDraftV1['resolutionKind'];
  readonly dialogueBurstId: string;
}

function providerSelections(
  units: readonly CanonicalSpeakerAttributionUnitV3[],
): ReadonlyMap<number, ProviderSelection> {
  const selections = new Map<number, ProviderSelection>();
  for (const unit of units) {
    const candidateByOrdinal = new Map(unit.packet.candidates.map(([ordinal, entityId]) => [ordinal, entityId]));
    const newMentionByTarget = new Map(unit.validatedWire.wire.x);
    const sourceMentionByOrdinal = new Map(unit.packet.mentionSourceIds);
    const sequenceBySpanIndex = new Map(
      unit.sequenceDecisions.flatMap((decision) =>
        decision.spanIndexes.map((spanIndex) => [spanIndex, { decisionId: decision.id }] as const),
      ),
    );
    unit.packet.targets.forEach((target, targetPosition) => {
      const spanIndex = target[0];
      if (selections.has(spanIndex)) throw new Error(`Speaker provenance target is duplicated: ${spanIndex}`);
      const sequence = sequenceBySpanIndex.get(spanIndex);
      const ordinal = unit.validatedWire.wire.s[targetPosition]!;
      let speakerEntityId: string | undefined;
      let resolutionKind: ProviderSelection['resolutionKind'] = 'provider_candidate';
      if (ordinal === SpeakerOrdinal.narrator) speakerEntityId = 'narrator';
      else if (ordinal === SpeakerOrdinal.system) speakerEntityId = 'system';
      else if (ordinal === SpeakerOrdinal.unknown) resolutionKind = 'unresolved';
      else if (ordinal === SpeakerOrdinal.newFromMention) {
        resolutionKind = 'provider_new_mention';
        const mentionOrdinal = newMentionByTarget.get(targetPosition);
        const sourceMentionId = mentionOrdinal === undefined ? undefined : sourceMentionByOrdinal.get(mentionOrdinal);
        if (!sourceMentionId) throw new Error(`Speaker provenance NEW_FROM_MENTION is ungrounded: ${spanIndex}`);
        speakerEntityId = persistentId128('pending_speaker_entity', [unit.packet.contentRevisionId, sourceMentionId]);
      } else {
        speakerEntityId = candidateByOrdinal.get(ordinal);
        if (!speakerEntityId) throw new Error(`Speaker provenance candidate ordinal is ungrounded: ${ordinal}`);
      }
      selections.set(spanIndex, {
        packetFingerprint: unit.packet.fingerprint,
        temporalSnapshotId: unit.packet.temporalSnapshotId,
        sequenceDecisionId: sequence?.decisionId,
        speakerEntityId,
        resolutionKind,
        dialogueBurstId: persistentId128('projected_dialogue_burst', [
          unit.packet.contentRevisionId,
          unit.packet.chapterId,
          unit.packet.sceneId,
          unit.packet.dialogueBurstInventoryHash,
          String(target[1]),
        ]),
      });
    });
  }
  return selections;
}

export function projectSpeakerSegmentProvenanceDrafts(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly sourceManifestFingerprint: string;
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly dialogueBurstInventory?: DialogueBurstInventoryV1;
  readonly sieve: DeterministicSpeakerSieveResultV1;
  readonly result: ChapterLabelingResult;
  readonly units: readonly CanonicalSpeakerAttributionUnitV3[];
}): readonly SpeakerSegmentProvenanceDraftV1[] {
  if (!Number.isSafeInteger(input.chapterIndex) || input.chapterIndex < 0) {
    throw new Error('Speaker provenance chapter index must be a nonnegative safe integer');
  }
  const spanByIndex = new Map(input.spanInventory.spans.map((span) => [span.spanIndex, span]));
  const decisionBySpanId = new Map(input.sieve.decisions.map((decision) => [decision.spanId, decision]));
  const burstIdBySpanId = new Map(
    (input.dialogueBurstInventory?.bursts ?? []).flatMap((burst) =>
      burst.spanIds.map((spanId) => [spanId, burst.id] as const),
    ),
  );
  const providerBySpanIndex = providerSelections(input.units);
  const drafts = input.result.segments.map<SpeakerSegmentProvenanceDraftV1>((segment) => {
    const span = spanByIndex.get(segment.segmentIndex);
    if (!span || span.paragraphId !== segment.paragraphId) {
      throw new Error(`Speaker provenance source span is missing for segment ${segment.id}`);
    }
    const provider = providerBySpanIndex.get(span.spanIndex);
    const deterministic = decisionBySpanId.get(span.id);
    const deterministicSpeakerEntityId =
      !provider && deterministic?.outcome === 'accepted' ? deterministic.speakerEntityId : undefined;
    const narrativeOrder = input.chapterIndex * 1_000_000 + span.spanIndex;
    if (!Number.isSafeInteger(narrativeOrder)) throw new Error('Speaker provenance narrative order overflowed');
    return {
      bookId: input.bookId,
      contentRevisionId: input.contentRevisionId,
      chapterId: input.chapterId,
      paragraphId: segment.paragraphId,
      segmentId: segment.id,
      sourceSpanId: span.id,
      sceneId: span.sceneId,
      dialogueBurstId: burstIdBySpanId.get(span.id) ?? provider?.dialogueBurstId,
      narrativeOrder,
      speakerEntityId: provider?.speakerEntityId ?? deterministicSpeakerEntityId,
      canonicalSpeakerId: segment.speakerId,
      resolutionKind: provider
        ? provider.resolutionKind
        : deterministicSpeakerEntityId
          ? 'deterministic'
          : 'unresolved',
      sourceManifestFingerprint: input.sourceManifestFingerprint,
      packetFingerprint: provider?.packetFingerprint,
      temporalSnapshotId: provider?.temporalSnapshotId,
      sequenceDecisionId: provider?.sequenceDecisionId,
      confidence: segment.confidence,
    };
  });
  const segmentIds = new Set<string>();
  for (const draft of drafts) {
    if (segmentIds.has(draft.segmentId))
      throw new Error(`Speaker provenance segment is duplicated: ${draft.segmentId}`);
    segmentIds.add(draft.segmentId);
  }
  return drafts;
}

export function speakerSegmentProvenanceDraftsFingerprint(drafts: readonly SpeakerSegmentProvenanceDraftV1[]): string {
  return structuredIntegrityHash(
    [...drafts]
      .sort(
        (left, right) => left.narrativeOrder - right.narrativeOrder || left.segmentId.localeCompare(right.segmentId),
      )
      .map((draft) => ({ ...draft })),
  );
}
