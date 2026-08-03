export interface SpeakerOutputBudgetInput {
  readonly targetSpanCount: number;
  readonly ambiguousEstimate?: number;
  readonly totalAlternativeCandidateEstimate?: number;
  readonly newMentionEstimate?: number;
  readonly reasoningP99?: number;
  readonly modelMaxOutputTokens?: number;
}

export interface SpeakerOutputBudget {
  readonly strategy: 'speaker-output-budget-v1';
  readonly visibleOutputEstimate: number;
  readonly reasoningReserve: number;
  readonly structuralReserve: number;
  readonly guardLimit: number;
  readonly requestedOutputCap: number;
  readonly decision: 'accepted' | 'rejected';
  readonly reason?: 'model_cap_below_visible_reserve';
}

function nonNegativeInteger(value: number | undefined, label: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

export function estimateSpeakerOutputBudget(input: SpeakerOutputBudgetInput): SpeakerOutputBudget {
  const targetSpanCount = nonNegativeInteger(input.targetSpanCount, 'targetSpanCount');
  if (targetSpanCount < 1) throw new Error('targetSpanCount must be at least 1');
  const ambiguousEstimate = nonNegativeInteger(input.ambiguousEstimate, 'ambiguousEstimate');
  const totalAlternativeCandidateEstimate = nonNegativeInteger(
    input.totalAlternativeCandidateEstimate,
    'totalAlternativeCandidateEstimate',
  );
  const newMentionEstimate = nonNegativeInteger(input.newMentionEstimate, 'newMentionEstimate');
  const reasoningReserve = nonNegativeInteger(input.reasoningP99, 'reasoningP99');
  const modelMaxOutputTokens =
    input.modelMaxOutputTokens === undefined
      ? 4_096
      : nonNegativeInteger(input.modelMaxOutputTokens, 'modelMaxOutputTokens');

  const visibleOutputEstimate =
    96 + 8 * targetSpanCount + 12 * ambiguousEstimate + 3 * totalAlternativeCandidateEstimate + 6 * newMentionEstimate;
  const structuralReserve = Math.ceil(visibleOutputEstimate * 0.15);
  const requestedWithReserves = visibleOutputEstimate + reasoningReserve + structuralReserve;
  const guardLimit = Math.max(512, visibleOutputEstimate * 3, requestedWithReserves);
  const hardLimit = Math.min(4_096, modelMaxOutputTokens);
  const requestedOutputCap = Math.min(hardLimit, guardLimit, Math.max(512, requestedWithReserves));
  const decision = requestedOutputCap >= visibleOutputEstimate + structuralReserve ? 'accepted' : 'rejected';

  return {
    strategy: 'speaker-output-budget-v1',
    visibleOutputEstimate,
    reasoningReserve,
    structuralReserve,
    guardLimit,
    requestedOutputCap,
    decision,
    reason: decision === 'rejected' ? 'model_cap_below_visible_reserve' : undefined,
  };
}
