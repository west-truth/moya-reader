export interface ProviderExecutionMetadata {
  readonly providerId: string;
  readonly providerRequestId?: string;
  readonly requestedModelId: string;
  readonly resolvedModelVersion?: string;
  readonly structuredOutputMode?: 'json_schema_strict' | 'json_schema' | 'json_mode' | 'prompt_only';
  readonly schemaVersion?: string;
  readonly schemaHash?: string;
  readonly finishReason?: string;
  readonly incompleteReason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly inputBytes?: number;
  readonly outputBytes?: number;
  readonly latencyMs: number;
  readonly retryCount: number;
  readonly safetyOrRefusalCode?: string;
  readonly stage?: string;
  readonly generationPolicyId?: string;
  readonly generationPolicyHash?: string;
  readonly requestedOutputCap?: number;
  readonly visibleOutputEstimate?: number;
  readonly promptHash?: string;
  readonly sourceManifestHash?: string;
  readonly spanInventoryHash?: string;
  readonly mentionInventoryHash?: string;
  readonly candidateMemoryHash?: string;
  readonly temporalSnapshotId?: string;
  readonly temporalSnapshotHash?: string;
  readonly timelineId?: string;
  readonly storyTimeBucket?: string;
  readonly activeRelationEdgeCount?: number;
  readonly ambiguousRelationCount?: number;
  readonly futureEdgeExcludedCount?: number;
  readonly dialogueBurstCount?: number;
  readonly sequenceDecoderVersion?: string;
  readonly sequenceDisagreementCount?: number;
  readonly targetSpanCount?: number;
  readonly candidateCount?: number;
  readonly partialOutputHash?: string;
  readonly repetitionScore?: number;
  readonly parsedItemCount?: number;
  readonly failureClass?:
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
}

export interface StructuredJsonGenerationResult {
  readonly text: string;
  readonly executionMetadata: ProviderExecutionMetadata;
}

export type StructuredJsonGenerationOutput = string | StructuredJsonGenerationResult;

const structuredOutputModes = new Set<NonNullable<ProviderExecutionMetadata['structuredOutputMode']>>([
  'json_schema_strict',
  'json_schema',
  'json_mode',
  'prompt_only',
]);
const speakerFailureClasses = new Set<NonNullable<ProviderExecutionMetadata['failureClass']>>([
  'candidate_coverage',
  'boundary_ambiguity',
  'semantic_ambiguity',
  'decoding_loop',
  'thinking_overrun',
  'genuine_truncation',
  'contract_invalid',
  'stale_input',
  'transient_provider',
  'outcome_unknown',
]);

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function nonNegativeNumber(value: unknown, integer = true): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  if (integer && !Number.isInteger(value)) return undefined;
  return value;
}

export function normalizeProviderExecutionMetadata(value: unknown): ProviderExecutionMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const providerId = boundedString(source.providerId, 128);
  const requestedModelId = boundedString(source.requestedModelId, 256);
  const latencyMs = nonNegativeNumber(source.latencyMs);
  const retryCount = nonNegativeNumber(source.retryCount);
  if (!providerId || !requestedModelId || latencyMs === undefined || retryCount === undefined) return undefined;

  const structuredOutputMode = boundedString(source.structuredOutputMode, 64);
  if (structuredOutputMode && !structuredOutputModes.has(structuredOutputMode as never)) return undefined;

  const metadata: ProviderExecutionMetadata = {
    providerId,
    requestedModelId,
    latencyMs,
    retryCount,
  };
  const optionalStrings: ReadonlyArray<readonly [keyof ProviderExecutionMetadata, number]> = [
    ['providerRequestId', 512],
    ['resolvedModelVersion', 256],
    ['schemaVersion', 128],
    ['schemaHash', 256],
    ['finishReason', 128],
    ['incompleteReason', 128],
    ['safetyOrRefusalCode', 128],
    ['stage', 128],
    ['generationPolicyId', 256],
    ['generationPolicyHash', 256],
    ['promptHash', 256],
    ['sourceManifestHash', 256],
    ['spanInventoryHash', 256],
    ['mentionInventoryHash', 256],
    ['candidateMemoryHash', 256],
    ['temporalSnapshotId', 256],
    ['temporalSnapshotHash', 256],
    ['timelineId', 256],
    ['storyTimeBucket', 128],
    ['sequenceDecoderVersion', 128],
    ['partialOutputHash', 256],
  ];
  const result = { ...metadata } as Record<string, unknown>;
  if (structuredOutputMode) result.structuredOutputMode = structuredOutputMode;
  for (const [key, maxLength] of optionalStrings) {
    const normalized = boundedString(source[key], maxLength);
    if (normalized) result[key] = normalized;
  }
  for (const key of [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'inputBytes',
    'outputBytes',
    'requestedOutputCap',
    'visibleOutputEstimate',
    'activeRelationEdgeCount',
    'ambiguousRelationCount',
    'futureEdgeExcludedCount',
    'dialogueBurstCount',
    'sequenceDisagreementCount',
    'targetSpanCount',
    'candidateCount',
    'parsedItemCount',
  ] as const) {
    const normalized = nonNegativeNumber(source[key]);
    if (normalized !== undefined) result[key] = normalized;
  }
  const repetitionScore = nonNegativeNumber(source.repetitionScore, false);
  if (repetitionScore !== undefined && repetitionScore <= 1) result.repetitionScore = repetitionScore;
  const failureClass = boundedString(source.failureClass, 64);
  if (failureClass && speakerFailureClasses.has(failureClass as never)) result.failureClass = failureClass;
  return result as unknown as ProviderExecutionMetadata;
}

export function isStructuredJsonGenerationResult(
  value: StructuredJsonGenerationOutput,
): value is StructuredJsonGenerationResult {
  return typeof value !== 'string';
}

export class ProviderOutputIncompleteError extends Error {
  readonly code = 'provider_output_incomplete';

  constructor(
    readonly executionMetadata: ProviderExecutionMetadata,
    partialOutput?: string,
  ) {
    super(`Provider output was incomplete: ${executionMetadata.incompleteReason ?? 'unknown'}`);
    this.name = 'ProviderOutputIncompleteError';
    if (partialOutput !== undefined) providerPartialOutputs.set(this, partialOutput);
  }
}

const providerPartialOutputs = new WeakMap<object, string>();

export function providerPartialOutputFromError(error: unknown): string | undefined {
  return error && typeof error === 'object' ? providerPartialOutputs.get(error) : undefined;
}

export class ProviderExecutionError extends Error {
  readonly cause: unknown;

  constructor(
    message: string,
    readonly executionMetadata: ProviderExecutionMetadata,
    cause: unknown,
  ) {
    super(message);
    this.name = 'ProviderExecutionError';
    this.cause = cause;
  }
}

export function attachProviderExecutionMetadata(
  error: unknown,
  metadata: ProviderExecutionMetadata,
): ProviderExecutionError | ProviderOutputIncompleteError {
  if (error instanceof ProviderOutputIncompleteError) return error;
  const contractMetadata = normalizeProviderExecutionMetadata({
    ...metadata,
    failureClass: metadata.failureClass ?? 'contract_invalid',
  });
  return new ProviderExecutionError(
    error instanceof Error ? error.message : 'Provider response processing failed',
    contractMetadata ?? metadata,
    error,
  );
}

export function providerExecutionMetadataFromError(error: unknown): ProviderExecutionMetadata | undefined {
  if (error instanceof ProviderOutputIncompleteError || error instanceof ProviderExecutionError) {
    return normalizeProviderExecutionMetadata(error.executionMetadata);
  }
  if (!error || typeof error !== 'object') return undefined;
  const metadata = (error as { executionMetadata?: unknown }).executionMetadata;
  return normalizeProviderExecutionMetadata(metadata);
}

export function takeProviderExecutionMetadata(provider: {
  takeExecutionMetadata?: () => ProviderExecutionMetadata | undefined;
}): ProviderExecutionMetadata | undefined {
  return provider.takeExecutionMetadata?.();
}
