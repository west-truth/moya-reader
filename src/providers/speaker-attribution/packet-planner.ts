export type SpeakerPacketSplitReasonV1 = 'target_budget' | 'candidate_hard_cap';

export interface SpeakerPacketPlanUnitV1 {
  readonly burstIds: readonly string[];
  readonly targetSpanIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly splitReason?: SpeakerPacketSplitReasonV1;
}

export function planSpeakerPacketBatches(input: {
  readonly bursts: readonly {
    readonly id: string;
    readonly spanIds: readonly string[];
  }[];
  readonly providerTargetSpanIds: ReadonlySet<string>;
  readonly selectedCandidateIdsBySpan: Readonly<Record<string, readonly string[]>>;
  readonly maxTargets: number;
  readonly candidateHardCap: number;
}): readonly SpeakerPacketPlanUnitV1[] {
  if (!Number.isInteger(input.maxTargets) || input.maxTargets < 1 || input.maxTargets > 40) {
    throw new Error('Speaker packet target budget must be an integer from 1 to 40');
  }
  if (!Number.isInteger(input.candidateHardCap) || input.candidateHardCap < 1 || input.candidateHardCap > 24) {
    throw new Error('Speaker packet candidate hard cap must be an integer from 1 to 24');
  }

  const units: SpeakerPacketPlanUnitV1[] = [];
  const seenTargetSpanIds = new Set<string>();
  let burstIds: string[] = [];
  let targetSpanIds: string[] = [];
  let candidateIds = new Set<string>();
  const flush = (splitReason?: SpeakerPacketSplitReasonV1) => {
    if (burstIds.length > 0) {
      units.push({
        burstIds,
        targetSpanIds,
        candidateIds: [...candidateIds].sort(),
        splitReason,
      });
    }
    burstIds = [];
    targetSpanIds = [];
    candidateIds = new Set<string>();
  };

  for (const burst of input.bursts) {
    const nextTargetSpanIds = burst.spanIds.filter((spanId) => input.providerTargetSpanIds.has(spanId));
    if (nextTargetSpanIds.length === 0) continue;
    for (const spanId of nextTargetSpanIds) {
      if (seenTargetSpanIds.has(spanId)) throw new Error(`Speaker packet target appears in multiple bursts: ${spanId}`);
      seenTargetSpanIds.add(spanId);
    }
    const burstCandidateIds = new Set(
      nextTargetSpanIds.flatMap((spanId) => input.selectedCandidateIdsBySpan[spanId] ?? []),
    );
    if (nextTargetSpanIds.length > input.maxTargets) {
      throw new Error(`Speaker dialogue burst exceeds target budget: ${burst.id}`);
    }
    if (burstCandidateIds.size > input.candidateHardCap) {
      throw new Error(`Speaker dialogue burst exceeds candidate hard cap: ${burst.id}`);
    }

    const combinedCandidateIds = new Set([...candidateIds, ...burstCandidateIds]);
    const splitReason =
      targetSpanIds.length > 0 && targetSpanIds.length + nextTargetSpanIds.length > input.maxTargets
        ? 'target_budget'
        : targetSpanIds.length > 0 && combinedCandidateIds.size > input.candidateHardCap
          ? 'candidate_hard_cap'
          : undefined;
    if (splitReason) flush(splitReason);

    burstIds.push(burst.id);
    targetSpanIds.push(...nextTargetSpanIds);
    for (const candidateId of burstCandidateIds) candidateIds.add(candidateId);
  }
  const missingTargetSpanIds = [...input.providerTargetSpanIds].filter((spanId) => !seenTargetSpanIds.has(spanId));
  if (missingTargetSpanIds.length > 0) {
    throw new Error(`Speaker packet targets are missing from dialogue bursts: ${missingTargetSpanIds.join(', ')}`);
  }
  flush();
  return units;
}
