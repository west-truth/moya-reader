import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { DeterministicSpeakerSieveResultV1 } from './deterministic-sieve';
import type { DialogueSequenceDecisionV1, SceneSpeakerPacketV3, ValidatedSpeakerWireV2 } from './contracts';
import { CandidateEvidenceBits } from './evidence-miner';

export type SpeakerRiskClassV1 = 'candidate' | 'boundary' | 'temporal' | 'sequence' | 'semantic' | 'provider';

export type SpeakerRiskActionV1 =
  | 'rebuild_candidates'
  | 'boundary_patch_or_review'
  | 'regenerate_temporal_snapshot'
  | 'targeted_escalation_or_review'
  | 'independent_escalation_or_review'
  | 'provider_retry_policy';

export interface SpeakerRiskRouteV1 {
  readonly version: 'speaker-risk-route-v1';
  readonly riskClass: SpeakerRiskClassV1;
  readonly action: SpeakerRiskActionV1;
  readonly targetSpanIndexes: readonly number[];
  readonly reasonCodes: readonly string[];
  readonly providerRetryAllowed: boolean;
  readonly escalationAllowed: boolean;
  readonly fingerprint: string;
}

export interface SpeakerEscalationComparisonV1 {
  readonly version: 'speaker-escalation-comparison-v1';
  readonly resolvedSpanIndexes: readonly number[];
  readonly disagreementSpanIndexes: readonly number[];
  readonly uncalibratedSpanIndexes: readonly number[];
  readonly fingerprint: string;
}

export interface SpeakerEscalationTargetRiskV1 {
  readonly version: 'speaker-escalation-target-risk-v6';
  readonly packetFingerprint: string;
  readonly spanIndex: number;
  readonly targetPosition: number;
  readonly score: number;
  readonly reasonCodes: readonly string[];
  readonly fingerprint: string;
}

export function assessSpeakerEscalationTargetRisks(
  packet: SceneSpeakerPacketV3,
): readonly SpeakerEscalationTargetRiskV1[] {
  const directEvidenceMask =
    CandidateEvidenceBits.explicitSpeechMarker |
    CandidateEvidenceBits.userCorrection |
    CandidateEvidenceBits.adjacentSpeechAttribution;
  return packet.targets
    .flatMap((target, targetPosition) => {
      if (target[4].length === 0) return [];
      const reasons: string[] = [];
      let score = 0;
      if (target[4].length >= 3) {
        reasons.push('three_or_more_candidates');
        score += 2;
      } else if (target[4].length === 2) {
        reasons.push('two_candidates');
        score += 1;
      }
      if (!target[5].some((bits) => Boolean(bits & directEvidenceMask))) {
        reasons.push('no_direct_local_evidence');
        score += 2;
      }
      if (target[5].some((bits) => Boolean(bits & CandidateEvidenceBits.distantSceneMention))) {
        reasons.push('distant_candidate_context');
        score += 2;
      }
      const visibleSpeechLength = target[3].replace(/[\s“”"'「」『』]/gu, '').length;
      if (visibleSpeechLength <= 32 && !target[5].some((bits) => Boolean(bits & directEvidenceMask))) {
        reasons.push('short_utterance_without_direct_evidence');
        score += 2;
      }
      if (target[2] === 2 || target[2] === 3) {
        reasons.push(target[2] === 2 ? 'inner_monologue' : 'message_speaker');
        score += 2;
      }
      if (packet.newMentionOrdinalsByTarget.some(([position]) => position === targetPosition)) {
        reasons.push('new_speaker_mention');
        score += 2;
      }
      if (score < 3) return [];
      const core = {
        version: 'speaker-escalation-target-risk-v6' as const,
        packetFingerprint: packet.fingerprint,
        spanIndex: target[0],
        targetPosition,
        score,
        reasonCodes: reasons.sort(),
      };
      return [{ ...core, fingerprint: structuredIntegrityHash(core) }];
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.spanIndex - right.spanIndex || left.targetPosition - right.targetPosition,
    );
}

export function selectBoundedSpeakerEscalationTargets(
  risks: readonly SpeakerEscalationTargetRiskV1[],
  totalTargetCount: number,
  maximumRatio = 0.15,
): readonly SpeakerEscalationTargetRiskV1[] {
  const cap = Math.floor(Math.max(0, totalTargetCount) * Math.min(0.15, Math.max(0, maximumRatio)));
  const queues = new Map<string, SpeakerEscalationTargetRiskV1[]>();
  for (const risk of risks) {
    queues.set(risk.packetFingerprint, [...(queues.get(risk.packetFingerprint) ?? []), risk]);
  }
  for (const queue of queues.values()) {
    queue.sort(
      (left, right) =>
        right.score - left.score || left.spanIndex - right.spanIndex || left.targetPosition - right.targetPosition,
    );
  }
  const selected: SpeakerEscalationTargetRiskV1[] = [];
  const orderedQueues = [...queues.entries()].sort(([left], [right]) => left.localeCompare(right));
  while (selected.length < cap && orderedQueues.some(([, queue]) => queue.length > 0)) {
    for (const [, queue] of orderedQueues) {
      const next = queue.shift();
      if (next) selected.push(next);
      if (selected.length >= cap) break;
    }
  }
  return selected;
}

function route(
  riskClass: SpeakerRiskClassV1,
  action: SpeakerRiskActionV1,
  targetSpanIndexes: readonly number[],
  reasonCodes: readonly string[],
  providerRetryAllowed: boolean,
  escalationAllowed: boolean,
): SpeakerRiskRouteV1 {
  const core = {
    version: 'speaker-risk-route-v1' as const,
    riskClass,
    action,
    targetSpanIndexes: [...new Set(targetSpanIndexes)].sort((a, b) => a - b),
    reasonCodes: [...new Set(reasonCodes)].sort(),
    providerRetryAllowed,
    escalationAllowed,
  };
  return { ...core, fingerprint: structuredIntegrityHash(core) };
}

export function routeSpeakerRisks(input: {
  readonly sieve: DeterministicSpeakerSieveResultV1;
  readonly attributedUnits: readonly {
    readonly packet: SceneSpeakerPacketV3;
    readonly validatedWire: ValidatedSpeakerWireV2;
  }[];
  readonly sequenceDecisions: readonly DialogueSequenceDecisionV1[];
  readonly temporalConflictSpanIndexes?: readonly number[];
  readonly providerFailureSpanIndexes?: readonly number[];
  readonly targetSpanIndexes?: readonly number[];
  readonly escalationDisagreementSpanIndexes?: readonly number[];
  readonly escalationUncalibratedSpanIndexes?: readonly number[];
  readonly resolvedEscalationSpanIndexes?: readonly number[];
}): readonly SpeakerRiskRouteV1[] {
  const targetSpanIndexes = input.targetSpanIndexes ? new Set(input.targetSpanIndexes) : undefined;
  const resolvedEscalationSpanIndexes = new Set(input.resolvedEscalationSpanIndexes ?? []);
  const inScope = (spanIndex: number) => !targetSpanIndexes || targetSpanIndexes.has(spanIndex);
  const decisionById = new Map(input.sieve.decisions.map((decision) => [decision.spanId, decision]));
  const candidate = [...decisionById.values()].filter(
    (item) => ['candidate_missing', 'candidate_insufficient'].includes(item.ruleCode) && inScope(item.spanIndex),
  );
  const boundary = [...decisionById.values()].filter(
    (item) =>
      inScope(item.spanIndex) &&
      item.ruleCode !== 'candidate_insufficient' &&
      (item.outcome === 'boundary_review' || item.outcome === 'window_split'),
  );
  const sequence = input.sequenceDecisions.flatMap((item) => item.disagreementIndexes).filter(inScope);
  const semantic = input.attributedUnits.flatMap(({ packet, validatedWire }) =>
    validatedWire.reviewTargetPositions.flatMap((position) => {
      const target = packet.targets[position];
      return target && inScope(target[0]) && !resolvedEscalationSpanIndexes.has(target[0]) ? [target[0]] : [];
    }),
  );
  const distantCandidateSelected = input.attributedUnits.flatMap(({ packet, validatedWire }) =>
    packet.targets.flatMap((target, targetPosition) => {
      if (!inScope(target[0])) return [];
      const selectedOrdinal = validatedWire.wire.s[targetPosition];
      const selectedCandidateIndex = selectedOrdinal === undefined ? -1 : target[4].indexOf(selectedOrdinal);
      const selectedEvidence = selectedCandidateIndex < 0 ? 0 : (target[5][selectedCandidateIndex] ?? 0);
      return selectedEvidence & CandidateEvidenceBits.distantSceneMention ? [target[0]] : [];
    }),
  );
  return [
    ...(candidate.length
      ? [
          route(
            'candidate',
            'rebuild_candidates',
            candidate.map((item) => item.spanIndex),
            [...new Set(candidate.map((item) => item.ruleCode))],
            false,
            false,
          ),
        ]
      : []),
    ...(boundary.length
      ? [
          route(
            'boundary',
            'boundary_patch_or_review',
            boundary.map((item) => item.spanIndex),
            boundary.map((item) => item.ruleCode),
            false,
            false,
          ),
        ]
      : []),
    ...(input.temporalConflictSpanIndexes?.filter(inScope).length
      ? [
          route(
            'temporal',
            'regenerate_temporal_snapshot',
            input.temporalConflictSpanIndexes.filter(inScope),
            ['temporal_snapshot_conflict'],
            false,
            false,
          ),
        ]
      : []),
    ...(sequence.length
      ? [route('sequence', 'targeted_escalation_or_review', sequence, ['sequence_disagreement'], false, true)]
      : []),
    ...(semantic.length
      ? [route('semantic', 'independent_escalation_or_review', semantic, ['semantic_ambiguity'], false, true)]
      : []),
    ...(distantCandidateSelected.length
      ? [
          route(
            'semantic',
            'independent_escalation_or_review',
            distantCandidateSelected,
            ['distant_candidate_selected'],
            false,
            true,
          ),
        ]
      : []),
    ...(input.escalationDisagreementSpanIndexes?.filter(inScope).length
      ? [
          route(
            'semantic',
            'independent_escalation_or_review',
            input.escalationDisagreementSpanIndexes.filter(inScope),
            ['primary_escalator_disagreement'],
            false,
            false,
          ),
        ]
      : []),
    ...(input.escalationUncalibratedSpanIndexes?.filter(inScope).length
      ? [
          route(
            'semantic',
            'independent_escalation_or_review',
            input.escalationUncalibratedSpanIndexes.filter(inScope),
            ['escalation_uncalibrated'],
            false,
            false,
          ),
        ]
      : []),
    ...(input.providerFailureSpanIndexes?.filter(inScope).length
      ? [
          route(
            'provider',
            'provider_retry_policy',
            input.providerFailureSpanIndexes.filter(inScope),
            ['provider_failure'],
            true,
            false,
          ),
        ]
      : []),
  ];
}

export function selectIndependentEscalationTargets(
  requestedSpanIndexes: readonly number[],
  totalTargetCount: number,
  maximumRatio = 0.15,
): readonly number[] {
  const cap = Math.floor(Math.max(0, totalTargetCount) * Math.min(0.15, Math.max(0, maximumRatio)));
  return [...new Set(requestedSpanIndexes)].sort((a, b) => a - b).slice(0, cap);
}

export function compareIndependentSpeakerEscalation(input: {
  readonly primaryPacket: SceneSpeakerPacketV3;
  readonly primary: ValidatedSpeakerWireV2;
  readonly escalationPacket: SceneSpeakerPacketV3;
  readonly escalation: ValidatedSpeakerWireV2;
  readonly minimumConfidence?: number;
}): SpeakerEscalationComparisonV1 {
  const minimumConfidence = Math.max(650, Math.min(1_000, input.minimumConfidence ?? 850));
  const primaryPositionBySpanIndex = new Map(
    input.primaryPacket.targets.map((target, position) => [target[0], position]),
  );
  const resolvedSpanIndexes: number[] = [];
  const disagreementSpanIndexes: number[] = [];
  const uncalibratedSpanIndexes: number[] = [];
  input.escalationPacket.targets.forEach((target, escalationPosition) => {
    const spanIndex = target[0];
    const primaryPosition = primaryPositionBySpanIndex.get(spanIndex);
    if (primaryPosition === undefined) throw new Error(`Escalation target ${spanIndex} is absent from primary packet`);
    const primarySpeaker = input.primary.wire.s[primaryPosition];
    const escalationSpeaker = input.escalation.wire.s[escalationPosition];
    if (primarySpeaker !== escalationSpeaker) {
      disagreementSpanIndexes.push(spanIndex);
      return;
    }
    const primaryTarget = input.primaryPacket.targets[primaryPosition]!;
    const primaryCandidateIndex = primarySpeaker === undefined ? -1 : primaryTarget[4].indexOf(primarySpeaker);
    if (
      primaryCandidateIndex >= 0 &&
      Boolean((primaryTarget[5][primaryCandidateIndex] ?? 0) & CandidateEvidenceBits.distantSceneMention)
    ) {
      uncalibratedSpanIndexes.push(spanIndex);
      return;
    }
    if (primarySpeaker === undefined || primarySpeaker < 4) {
      uncalibratedSpanIndexes.push(spanIndex);
      return;
    }
    if (
      (input.primary.wire.q[primaryPosition] ?? 0) < minimumConfidence ||
      (input.escalation.wire.q[escalationPosition] ?? 0) < minimumConfidence
    ) {
      uncalibratedSpanIndexes.push(spanIndex);
      return;
    }
    resolvedSpanIndexes.push(spanIndex);
  });
  const core = {
    version: 'speaker-escalation-comparison-v1' as const,
    resolvedSpanIndexes: [...new Set(resolvedSpanIndexes)].sort((a, b) => a - b),
    disagreementSpanIndexes: [...new Set(disagreementSpanIndexes)].sort((a, b) => a - b),
    uncalibratedSpanIndexes: [...new Set(uncalibratedSpanIndexes)].sort((a, b) => a - b),
  };
  return { ...core, fingerprint: structuredIntegrityHash(core) };
}
