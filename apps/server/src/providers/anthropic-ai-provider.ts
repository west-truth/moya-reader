import {
  cleanProviderOptions,
  numberProviderOption,
  postJson,
  ServerStructuredJsonAIProvider,
  toStandardJsonSchema,
  type ServerStructuredJsonGenerateClient,
  type ServerStructuredJsonGenerateInput,
} from './server-structured-json-provider.js';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import {
  ProviderOutputIncompleteError,
  type ProviderExecutionMetadata,
  type StructuredJsonGenerationResult,
} from '../../../../src/providers/provider-execution';
import { withProviderOutputDiagnostics } from '../../../../src/providers/speaker-attribution/failure-classifier';

export interface AnthropicAIProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly anthropicVersion?: string;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly fetchImpl?: typeof fetch;
  readonly client?: ServerStructuredJsonGenerateClient;
}

export class AnthropicAIProvider extends ServerStructuredJsonAIProvider {
  constructor(options: AnthropicAIProviderOptions) {
    super({
      providerId: 'anthropic',
      displayName: 'Claude API',
      modelId: options.modelId,
      providerOptions: options.providerOptions,
      client: options.client ?? createAnthropicMessagesClient(options),
    });
  }
}

export function createAnthropicMessagesClient(
  options: Omit<AnthropicAIProviderOptions, 'modelId' | 'client'>,
): ServerStructuredJsonGenerateClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async generateJson(input: ServerStructuredJsonGenerateInput): Promise<StructuredJsonGenerationResult> {
      const startedAt = Date.now();
      const apiKey = options.apiKey?.trim();
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for anthropic provider');
      const providerOptions = cleanProviderOptions(input.providerOptions);
      const maxTokens = numberProviderOption(providerOptions, 'maxOutputTokens') ?? 8192;
      const responseSchema = toStandardJsonSchema(input.responseSchema);
      const body: Record<string, unknown> = {
        model: input.modelId,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: input.prompt }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: responseSchema,
          },
        },
      };
      const temperature = numberProviderOption(providerOptions, 'temperature');
      const topP = numberProviderOption(providerOptions, 'topP');
      if (temperature !== undefined) body.temperature = temperature;
      if (topP !== undefined) body.top_p = topP;
      const baseUrl = options.baseUrl?.replace(/\/+$/, '') || 'https://api.anthropic.com/v1';
      const json = await postJson(
        'Anthropic',
        fetchImpl,
        `${baseUrl}/messages`,
        {
          'x-api-key': apiKey,
          'anthropic-version': options.anthropicVersion?.trim() || '2023-06-01',
        },
        body,
        input.signal,
      );
      const text = extractAnthropicMessageText(json);
      const baseMetadata = anthropicExecutionMetadata(json, input, text, responseSchema, Date.now() - startedAt);
      const completedMetadata =
        !text.trim() && !baseMetadata.incompleteReason
          ? { ...baseMetadata, incompleteReason: 'empty_output' }
          : baseMetadata;
      const metadata = withProviderOutputDiagnostics(completedMetadata, {
        generationPolicy: input.generationPolicy,
        prompt: input.prompt,
        text,
      });
      if (metadata.incompleteReason) throw new ProviderOutputIncompleteError(metadata);
      return { text, executionMetadata: metadata };
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function anthropicExecutionMetadata(
  value: unknown,
  input: ServerStructuredJsonGenerateInput,
  text: string,
  responseSchema: unknown,
  latencyMs: number,
): ProviderExecutionMetadata {
  const body = record(value);
  const usage = record(body?.usage);
  const finishReason = typeof body?.stop_reason === 'string' ? body.stop_reason : undefined;
  const acceptedReasons = new Set(['end_turn', 'stop_sequence']);
  return {
    providerId: 'anthropic',
    providerRequestId: typeof body?.id === 'string' ? body.id : undefined,
    requestedModelId: input.modelId,
    resolvedModelVersion: typeof body?.model === 'string' ? body.model : undefined,
    structuredOutputMode: 'json_schema',
    schemaVersion: input.schemaVersion,
    schemaHash: structuredIntegrityHash(responseSchema),
    finishReason,
    incompleteReason: finishReason && !acceptedReasons.has(finishReason) ? finishReason : undefined,
    inputTokens: finiteNumber(usage?.input_tokens),
    outputTokens: finiteNumber(usage?.output_tokens),
    inputBytes: new TextEncoder().encode(input.prompt).byteLength,
    outputBytes: new TextEncoder().encode(text).byteLength,
    latencyMs,
    retryCount: 0,
    safetyOrRefusalCode: finishReason === 'refusal' ? 'refusal' : undefined,
  };
}

function extractAnthropicMessageText(value: unknown): string {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const content = Array.isArray(body?.content) ? body.content : [];
  const text = content
    .map((part) => (part && typeof part === 'object' ? (part as Record<string, unknown>).text : undefined))
    .filter((part): part is string => typeof part === 'string')
    .join('');
  return text;
}
