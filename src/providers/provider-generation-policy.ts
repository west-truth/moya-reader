import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';

export type LLMGenerationTaskKind =
  | 'graph_observation'
  | 'graph_consolidation'
  | 'standard_labeling'
  | 'speaker_attribution'
  | 'speaker_escalation'
  | 'span_boundary_patch'
  | 'patch_repair'
  | 'voice_trait_profile'
  | 'emotion_projection';

export type LLMReasoningPolicy = 'none' | 'minimal' | 'low' | 'provider_default';

export interface LLMGenerationPolicyV2 {
  readonly version: 'llm-generation-policy-v2';
  readonly id: string;
  readonly providerId: string;
  readonly requestedModelId: string;
  readonly modelFamily: string;
  readonly taskKind: LLMGenerationTaskKind;
  readonly sampling:
    | 'model_default'
    | {
        readonly temperature?: number;
        readonly topP?: number;
        readonly topK?: number;
      };
  readonly reasoning: LLMReasoningPolicy;
  readonly outputBudgetStrategy: 'request_derived';
  readonly requestedOutputCap?: number;
  readonly visibleOutputEstimate?: number;
  readonly maxRetries: number;
  readonly fingerprint: string;
}

function finiteOption(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = finiteOption(value, 1, 131_072);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

export function resolveLLMModelFamily(providerId: string, modelId: string): string {
  const provider = providerId.trim().toLowerCase();
  const model = modelId
    .trim()
    .toLowerCase()
    .replace(/^models\//, '');
  if (provider.startsWith('gemini')) {
    if (/^gemini-3(?:[.-]|$)/.test(model)) return 'gemini-3.x';
    if (/^gemini-2\.5(?:[.-]|$)/.test(model)) return 'gemini-2.5';
    return 'gemini-other';
  }
  if (provider === 'openai') {
    if (/^(?:o\d|gpt-5)(?:[.-]|$)/.test(model)) return 'openai-reasoning';
    return 'openai-chat';
  }
  if (provider === 'anthropic') return 'anthropic-claude';
  return `${provider || 'unknown'}-default`;
}

function boundedReasoningTask(taskKind: LLMGenerationTaskKind): boolean {
  return [
    'standard_labeling',
    'speaker_attribution',
    'speaker_escalation',
    'span_boundary_patch',
    'patch_repair',
    'voice_trait_profile',
    'emotion_projection',
  ].includes(taskKind);
}

function reasoningPolicy(
  providerId: string,
  modelFamily: string,
  modelId: string,
  taskKind: LLMGenerationTaskKind,
): LLMReasoningPolicy {
  if (!boundedReasoningTask(taskKind)) return 'provider_default';
  if (providerId.startsWith('gemini') && modelFamily === 'gemini-3.x') {
    const normalizedModelId = modelId
      .trim()
      .toLowerCase()
      .replace(/^models\//, '');
    return normalizedModelId.startsWith('gemini-3.1-pro') ||
      (normalizedModelId.startsWith('gemini-3.6-flash') && taskKind === 'speaker_escalation')
      ? 'low'
      : 'minimal';
  }
  if (providerId.startsWith('gemini') && modelFamily === 'gemini-2.5') return 'none';
  if (providerId === 'openai' || providerId === 'anthropic') return 'none';
  return 'provider_default';
}

export function resolveLLMGenerationPolicy(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly taskKind: LLMGenerationTaskKind;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly requestedOutputCap?: number;
  readonly visibleOutputEstimate?: number;
}): LLMGenerationPolicyV2 {
  const providerId = input.providerId.trim().toLowerCase();
  const requestedModelId = input.modelId.trim();
  const options = input.providerOptions ?? {};
  const temperature = finiteOption(options.temperature, 0, 2);
  const topP = finiteOption(options.topP, 0, 1);
  const topK = finiteOption(options.topK, 1, 1_000);
  const sampling =
    temperature === undefined && topP === undefined && topK === undefined
      ? ('model_default' as const)
      : { temperature, topP, topK };
  const modelFamily = resolveLLMModelFamily(providerId, requestedModelId);
  const requestedOutputCap = positiveInteger(input.requestedOutputCap ?? options.maxOutputTokens);
  const visibleOutputEstimate = positiveInteger(input.visibleOutputEstimate);
  const core = {
    version: 'llm-generation-policy-v2' as const,
    providerId,
    requestedModelId,
    modelFamily,
    taskKind: input.taskKind,
    sampling,
    reasoning: reasoningPolicy(providerId, modelFamily, requestedModelId, input.taskKind),
    outputBudgetStrategy: 'request_derived' as const,
    requestedOutputCap,
    visibleOutputEstimate,
    maxRetries: ['speaker_attribution', 'span_boundary_patch', 'patch_repair'].includes(input.taskKind) ? 0 : 1,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('llm_generation_policy', [providerId, requestedModelId, input.taskKind, fingerprint]),
    fingerprint,
  };
}

export function applyLLMGenerationPolicy(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  policy: LLMGenerationPolicyV2,
): Record<string, unknown> {
  const result = { ...(providerOptions ?? {}) };
  delete result.temperature;
  delete result.topP;
  delete result.topK;

  if (policy.sampling !== 'model_default') {
    if (policy.sampling.temperature !== undefined) result.temperature = policy.sampling.temperature;
    if (policy.sampling.topP !== undefined) result.topP = policy.sampling.topP;
    if (policy.sampling.topK !== undefined) result.topK = policy.sampling.topK;
  }

  if (policy.providerId.startsWith('gemini') && policy.reasoning !== 'provider_default') {
    result.thinkingConfig =
      policy.reasoning === 'minimal' || policy.reasoning === 'low'
        ? { thinkingLevel: policy.reasoning }
        : { thinkingBudget: 0 };
  }
  if (policy.requestedOutputCap !== undefined) result.maxOutputTokens = policy.requestedOutputCap;
  return result;
}
