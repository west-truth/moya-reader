import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import {
  ProviderOutputIncompleteError,
  type StructuredJsonGenerationResult,
} from '../../../../src/providers/provider-execution';
import type { LLMGenerationPolicyV2 } from '../../../../src/providers/provider-generation-policy';
import { withProviderOutputDiagnostics } from '../../../../src/providers/speaker-attribution/failure-classifier';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function geminiStructuredJsonResult(input: {
  readonly providerId: string;
  readonly requestedModelId: string;
  readonly prompt: string;
  readonly schemaVersion?: string;
  readonly responseSchema: unknown;
  readonly response: unknown;
  readonly text: string;
  readonly latencyMs: number;
  readonly generationPolicy?: LLMGenerationPolicyV2;
}): StructuredJsonGenerationResult {
  const body = record(input.response);
  const candidate = Array.isArray(body?.candidates) ? record(body.candidates[0]) : undefined;
  const usage = record(body?.usageMetadata);
  const promptFeedback = record(body?.promptFeedback);
  const finishReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : undefined;
  const blockReason = typeof promptFeedback?.blockReason === 'string' ? promptFeedback.blockReason : undefined;
  const incompleteReason =
    blockReason ??
    (finishReason && finishReason !== 'STOP' ? finishReason : undefined) ??
    (!input.text.trim() ? 'empty_response' : undefined);
  const metadata = withProviderOutputDiagnostics(
    {
      providerId: input.providerId,
      providerRequestId: typeof body?.responseId === 'string' ? body.responseId : undefined,
      requestedModelId: input.requestedModelId,
      resolvedModelVersion: typeof body?.modelVersion === 'string' ? body.modelVersion : undefined,
      structuredOutputMode: 'json_schema',
      schemaVersion: input.schemaVersion,
      schemaHash: structuredIntegrityHash(input.responseSchema),
      finishReason,
      incompleteReason,
      inputTokens: finiteNumber(usage?.promptTokenCount),
      outputTokens: finiteNumber(usage?.candidatesTokenCount),
      reasoningTokens: finiteNumber(usage?.thoughtsTokenCount),
      inputBytes: new TextEncoder().encode(input.prompt).byteLength,
      outputBytes: new TextEncoder().encode(input.text).byteLength,
      latencyMs: input.latencyMs,
      retryCount: 0,
      safetyOrRefusalCode: blockReason ?? (finishReason === 'SAFETY' ? 'SAFETY' : undefined),
    },
    {
      generationPolicy: input.generationPolicy,
      prompt: input.prompt,
      text: input.text,
    },
  );
  if (metadata.incompleteReason) throw new ProviderOutputIncompleteError(metadata, input.text);
  return { text: input.text, executionMetadata: metadata };
}
