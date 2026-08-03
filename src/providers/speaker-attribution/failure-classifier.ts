import { textIntegrityHash } from '@noveldesk/text-core/hash';
import type { LLMGenerationPolicyV2 } from '../provider-generation-policy';
import type { ProviderExecutionMetadata } from '../provider-execution';
import { analyzeRepetitionEvidence } from './repetition-evidence';

export type SpeakerFailureClass =
  | 'candidate_coverage'
  | 'boundary_ambiguity'
  | 'semantic_ambiguity'
  | 'decoding_loop'
  | 'thinking_overrun'
  | 'genuine_truncation'
  | 'contract_invalid'
  | 'stale_input'
  | 'transient_provider'
  | 'outcome_unknown';

export function classifySpeakerFailure(input: {
  readonly incompleteReason?: string;
  readonly finishReason?: string;
  readonly repetitionScore?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly requestedOutputCap?: number;
  readonly transient?: boolean;
}): SpeakerFailureClass {
  if (input.transient) return 'transient_provider';
  const reason = `${input.incompleteReason ?? ''} ${input.finishReason ?? ''}`.toLowerCase();
  if (/stale|revision|content[_ -]?changed/.test(reason)) return 'stale_input';
  if (/candidate|coverage/.test(reason)) return 'candidate_coverage';
  if (/boundary|span/.test(reason)) return 'boundary_ambiguity';
  if (/semantic|ambiguous/.test(reason)) return 'semantic_ambiguity';
  if (/refusal|safety|content_filter|empty|invalid|malformed|schema/.test(reason)) return 'contract_invalid';
  if (/max[_ -]?tokens|length|token[_ -]?limit/.test(reason)) {
    if ((input.repetitionScore ?? 0) >= 0.45) return 'decoding_loop';
    const cap = input.requestedOutputCap ?? 0;
    const reasoningShare = cap > 0 ? (input.reasoningTokens ?? 0) / cap : 0;
    const visibleShare = cap > 0 ? (input.outputTokens ?? 0) / cap : 1;
    if (reasoningShare >= 0.55 && visibleShare <= 0.35) return 'thinking_overrun';
    return 'genuine_truncation';
  }
  return 'outcome_unknown';
}

export function withProviderOutputDiagnostics(
  metadata: ProviderExecutionMetadata,
  input: {
    readonly generationPolicy?: LLMGenerationPolicyV2;
    readonly prompt: string;
    readonly text: string;
  },
): ProviderExecutionMetadata {
  const policy = input.generationPolicy;
  const common: ProviderExecutionMetadata = {
    ...metadata,
    stage: policy?.taskKind,
    generationPolicyId: policy?.id,
    generationPolicyHash: policy?.fingerprint,
    requestedOutputCap: policy?.requestedOutputCap,
    visibleOutputEstimate: policy?.visibleOutputEstimate,
    promptHash: textIntegrityHash(input.prompt),
  };
  if (!metadata.incompleteReason) return common;
  const repetition = analyzeRepetitionEvidence(input.text);
  return {
    ...common,
    partialOutputHash: repetition.partialOutputHash,
    repetitionScore: repetition.repetitionScore,
    parsedItemCount: repetition.parsedItemCount,
    failureClass: classifySpeakerFailure({
      incompleteReason: metadata.incompleteReason,
      finishReason: metadata.finishReason,
      repetitionScore: repetition.repetitionScore,
      outputTokens: metadata.outputTokens,
      reasoningTokens: metadata.reasoningTokens,
      requestedOutputCap: policy?.requestedOutputCap,
    }),
  };
}
