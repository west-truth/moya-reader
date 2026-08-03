import { persistentId128, textIntegrityHash } from '@noveldesk/text-core/hash';
import type {
  SpeakerSourceParagraphInput,
  SpeakerSpanInventoryV1,
  SpeakerSpanType,
} from '@noveldesk/text-core/speaker-attribution';
import type { Character, LabeledSegment, SegmentType } from '../../domain/types';
import { labeledSegmentId, segmentTextIntegrityHash } from '../../domain/identity/ai-identities';
import type { ChapterLabelingResult, ChapterLabelingUncertainty } from '../ai';
import {
  SpeakerOrdinal,
  type DialogueSequenceDecisionV1,
  type SceneSpeakerPacketV3,
  type ValidatedSpeakerWireV2,
} from './contracts';
import type { DeterministicSpeakerSieveResultV1 } from './deterministic-sieve';

const segmentType: Readonly<Record<SpeakerSpanType, SegmentType>> = {
  narration: 'narration',
  dialogue: 'quoted_dialogue',
  inner_monologue: 'inner_monologue',
  message: 'plain_dialogue',
  system: 'system_message',
  sfx: 'sfx',
  metadata: 'author_note',
  unknown: 'unknown',
};

export interface PendingSpeakerEntityV1 {
  readonly id: string;
  readonly targetPosition: number;
  readonly mentionOrdinal: number;
  readonly sourceMentionId: string;
  readonly displayName: string;
  readonly provenance: 'speaker_wire_new_from_mention';
}

export interface CanonicalSpeakerExpansionV3 {
  readonly result: ChapterLabelingResult;
  readonly pendingSpeakerEntities: readonly PendingSpeakerEntityV1[];
  readonly routedSpanIds: readonly string[];
}

export function expandSpeakerAttributionToCanonicalLabels(input: {
  readonly bookId: string;
  readonly chapterId: string;
  readonly characters: readonly Character[];
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly paragraphs: readonly SpeakerSourceParagraphInput[];
  readonly packet: SceneSpeakerPacketV3;
  readonly validatedWire: ValidatedSpeakerWireV2;
  readonly sequenceDecisions: readonly DialogueSequenceDecisionV1[];
  readonly sieve: DeterministicSpeakerSieveResultV1;
  readonly speakerIdByEntityId: Readonly<Record<string, string>>;
  readonly targetSpanIndexes?: readonly number[];
}): CanonicalSpeakerExpansionV3 {
  const paragraphById = new Map(input.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph]));
  const sieveBySpanId = new Map(input.sieve.decisions.map((decision) => [decision.spanId, decision]));
  const targetPositionBySpanIndex = new Map(input.packet.targets.map((target, position) => [target[0], position]));
  const entityIdByOrdinal = new Map(input.packet.candidates.map(([ordinal, entityId]) => [ordinal, entityId]));
  const newMentionByTarget = new Map(input.validatedWire.wire.x);
  const sourceMentionIdByOrdinal = new Map(input.packet.mentionSourceIds);
  const sequenceDisagreementSpanIndexes = new Set(
    input.sequenceDecisions.flatMap((decision) => decision.disagreementIndexes),
  );
  const pendingSpeakerEntities: PendingSpeakerEntityV1[] = [];
  const uncertainties: ChapterLabelingUncertainty[] = [];
  const routedSpanIds: string[] = [];
  const segmentAnnotations: NonNullable<ChapterLabelingResult['segmentAnnotations']> = {};

  const targetSpanIndexes = input.targetSpanIndexes ? new Set(input.targetSpanIndexes) : undefined;
  const labels = input.spanInventory.spans
    .filter((span) => !targetSpanIndexes || targetSpanIndexes.has(span.spanIndex))
    .map<LabeledSegment>((span) => {
      const paragraph = paragraphById.get(span.paragraphId);
      if (!paragraph) throw new Error(`Canonical expansion is missing paragraph ${span.paragraphId}`);
      const text = paragraph.text.slice(span.startOffset, span.endOffset);
      if (textIntegrityHash(text) !== span.textHash)
        throw new Error(`Canonical expansion source hash is stale for ${span.id}`);
      const sieveDecision = sieveBySpanId.get(span.id);
      const targetPosition = targetPositionBySpanIndex.get(span.spanIndex);
      let speakerId: LabeledSegment['speakerId'] = 'unknown';
      let candidateSpeakers: string[] = [];
      let confidence = 0;
      let evidenceCode = sieveDecision?.ruleCode ?? 'unresolved';
      let isUserCorrected = false;

      if (sieveDecision?.outcome === 'accepted' && sieveDecision.speakerEntityId) {
        speakerId =
          sieveDecision.speakerEntityId === 'narrator' || sieveDecision.speakerEntityId === 'system'
            ? sieveDecision.speakerEntityId
            : (input.speakerIdByEntityId[sieveDecision.speakerEntityId] ?? 'unknown');
        candidateSpeakers = sieveDecision.candidateEntityIds.flatMap((entityId) => {
          const canonical = input.speakerIdByEntityId[entityId];
          return canonical ? [canonical] : [];
        });
        if (
          speakerId === 'unknown' &&
          sieveDecision.speakerEntityId !== 'narrator' &&
          sieveDecision.speakerEntityId !== 'system'
        ) {
          candidateSpeakers = [...new Set([sieveDecision.speakerEntityId, ...candidateSpeakers])];
          routedSpanIds.push(span.id);
          uncertainties.push({
            paragraphId: span.paragraphId,
            startOffset: span.startOffset,
            endOffset: span.endOffset,
            reasonCode: 'speaker_entity_not_canonical',
            candidateIds: candidateSpeakers,
          });
        }
        confidence = sieveDecision.confidence;
        isUserCorrected = sieveDecision.ruleCode.includes('user_');
      } else if (targetPosition !== undefined) {
        const ordinal = input.validatedWire.wire.s[targetPosition]!;
        const entityId = entityIdByOrdinal.get(ordinal);
        const canonical = entityId ? input.speakerIdByEntityId[entityId] : undefined;
        if (ordinal === SpeakerOrdinal.unknown) speakerId = 'unknown';
        else if (ordinal === SpeakerOrdinal.newFromMention) {
          const mentionOrdinal = newMentionByTarget.get(targetPosition);
          const mention = input.packet.mentions.find(([candidate]) => candidate === mentionOrdinal);
          const sourceMentionId =
            mentionOrdinal === undefined ? undefined : sourceMentionIdByOrdinal.get(mentionOrdinal);
          if (mentionOrdinal !== undefined && mention && sourceMentionId) {
            const pendingId = persistentId128('pending_speaker_entity', [
              input.packet.contentRevisionId,
              sourceMentionId,
            ]);
            pendingSpeakerEntities.push({
              id: pendingId,
              targetPosition,
              mentionOrdinal,
              sourceMentionId,
              displayName: mention[1],
              provenance: 'speaker_wire_new_from_mention',
            });
            candidateSpeakers = [pendingId];
          }
        } else if (canonical) speakerId = canonical;
        else if (entityId) candidateSpeakers = [entityId];
        const target = input.packet.targets[targetPosition]!;
        candidateSpeakers = [
          ...new Set([
            ...candidateSpeakers,
            ...target[4].flatMap((candidateOrdinal) => {
              const candidateEntityId = entityIdByOrdinal.get(candidateOrdinal);
              const candidateSpeakerId = candidateEntityId ? input.speakerIdByEntityId[candidateEntityId] : undefined;
              return candidateSpeakerId ? [candidateSpeakerId] : [];
            }),
          ]),
        ];
        confidence = input.validatedWire.wire.q[targetPosition]! / 1_000;
        evidenceCode = `speaker_wire:${input.validatedWire.wire.e[targetPosition]}`;
        const sequenceDisagreement = sequenceDisagreementSpanIndexes.has(span.spanIndex);
        if (sequenceDisagreement) {
          confidence = Math.min(confidence, 0.65);
          evidenceCode += ':sequence_disagreement';
        }
        if (
          speakerId === 'unknown' ||
          sequenceDisagreement ||
          input.validatedWire.reviewTargetPositions.includes(targetPosition)
        ) {
          routedSpanIds.push(span.id);
          uncertainties.push({
            paragraphId: span.paragraphId,
            startOffset: span.startOffset,
            endOffset: span.endOffset,
            reasonCode:
              speakerId === 'unknown'
                ? 'speaker_unresolved'
                : sequenceDisagreement
                  ? 'speaker_sequence_disagreement'
                  : 'speaker_review_required',
            candidateIds: candidateSpeakers,
          });
        }
      } else if (
        sieveDecision?.outcome === 'boundary_review' ||
        sieveDecision?.outcome === 'window_split' ||
        sieveDecision?.outcome === 'provider_target'
      ) {
        routedSpanIds.push(span.id);
        candidateSpeakers = sieveDecision.candidateEntityIds.flatMap((entityId) => {
          const canonical = input.speakerIdByEntityId[entityId];
          return canonical ? [canonical] : [];
        });
        uncertainties.push({
          paragraphId: span.paragraphId,
          startOffset: span.startOffset,
          endOffset: span.endOffset,
          reasonCode:
            sieveDecision.outcome === 'provider_target' ? 'speaker_packet_result_missing' : sieveDecision.ruleCode,
          candidateIds: candidateSpeakers,
        });
      }
      const segmentTextHash = segmentTextIntegrityHash(text);
      const id = labeledSegmentId({
        novelId: input.bookId,
        chapterId: input.chapterId,
        paragraphId: span.paragraphId,
        startOffset: span.startOffset,
        endOffset: span.endOffset,
        segmentTextHash,
      });
      segmentAnnotations[id] = { evidenceCodes: [evidenceCode] };
      return {
        id,
        novelId: input.bookId,
        chapterId: input.chapterId,
        paragraphId: span.paragraphId,
        segmentIndex: span.spanIndex,
        startOffset: span.startOffset,
        endOffset: span.endOffset,
        segmentTextHash,
        type: segmentType[span.type],
        speakerId,
        candidateSpeakers,
        listenerIds: [],
        emotion: speakerId === 'system' ? 'system' : 'neutral',
        confidence,
        evidence: evidenceCode,
        isUserCorrected,
      };
    });
  return {
    result: {
      characters: [...input.characters],
      segments: labels,
      uncertainties,
      segmentAnnotations,
    },
    pendingSpeakerEntities,
    routedSpanIds: [...new Set(routedSpanIds)].sort(),
  };
}
