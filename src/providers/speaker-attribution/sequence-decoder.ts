import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import {
  SpeakerReviewBits,
  type DialogueSequenceDecisionV1,
  type SceneSpeakerPacketV3,
  type ValidatedSpeakerWireV2,
} from './contracts';

function decodeBurst(input: {
  readonly packet: SceneSpeakerPacketV3;
  readonly validated: ValidatedSpeakerWireV2;
  readonly burstOrdinal: number;
  readonly spanIndexes: readonly number[];
}): DialogueSequenceDecisionV1 {
  const positionBySpanIndex = new Map(input.packet.targets.map((target, position) => [target[0], position]));
  const alternativesByPosition = new Map(
    input.validated.wire.u.map((position, index) => [position, input.validated.wire.c[index] ?? []]),
  );
  const positions = input.spanIndexes.flatMap((spanIndex) => {
    const position = positionBySpanIndex.get(spanIndex);
    return position === undefined ? [] : [position];
  });
  const candidateOrdinals = positions.map((position) => [
    ...new Set([input.validated.wire.s[position]!, ...(alternativesByPosition.get(position) ?? [])]),
  ]);
  const selectedSpeakerOrdinals = positions.map((position) => input.validated.wire.s[position]!);
  const disagreementIndexes: number[] = [];
  const ruleConstraintBits = positions.map((position, index) => {
    const ordinal = selectedSpeakerOrdinals[index]!;
    const target = input.packet.targets[position]!;
    const candidateIndex = target[4].indexOf(ordinal);
    return candidateIndex < 0 ? 0 : (target[5][candidateIndex] ?? 0);
  });
  const reviewCodes = [
    ...(disagreementIndexes.length > 0 ? [SpeakerReviewBits.sequenceDisagreement] : []),
    ...positions.flatMap((position) =>
      input.validated.reviewTargetPositions.includes(position)
        ? [
            input.validated.wire.r[input.validated.wire.u.findIndex((reviewPosition) => reviewPosition === position)] ??
              0,
          ]
        : [],
    ),
  ].filter((code) => code > 0);
  const core = {
    version: 'dialogue-sequence-decision-v1' as const,
    burstOrdinal: input.burstOrdinal,
    spanIndexes: positions.map((position) => input.packet.targets[position]![0]),
    candidateOrdinals,
    selectedSpeakerOrdinals,
    ruleConstraintBits,
    decoderMethod: 'none' as const,
    disagreementIndexes,
    reviewCodes: [...new Set(reviewCodes)].sort((left, right) => left - right),
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('dialogue_sequence_decision', [
      input.packet.fingerprint,
      String(input.burstOrdinal),
      fingerprint,
    ]),
    fingerprint,
  };
}

export function decodeDialogueSequences(
  packet: SceneSpeakerPacketV3,
  validated: ValidatedSpeakerWireV2,
): readonly DialogueSequenceDecisionV1[] {
  const decisions = packet.dialogueBursts.map(([burstOrdinal, spanIndexes]) =>
    decodeBurst({ packet, validated, burstOrdinal, spanIndexes }),
  );
  const covered = new Set(decisions.flatMap((decision) => decision.spanIndexes));
  const ungrouped = packet.targets.flatMap((target) =>
    covered.has(target[0])
      ? []
      : [
          decodeBurst({
            packet,
            validated,
            burstOrdinal: -1 - target[0],
            spanIndexes: [target[0]],
          }),
        ],
  );
  return [...decisions, ...ungrouped].sort((left, right) => left.spanIndexes[0]! - right.spanIndexes[0]!);
}
