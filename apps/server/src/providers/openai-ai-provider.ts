import {
  cleanProviderOptions,
  numberProviderOption,
  postJson,
  ServerStructuredJsonAIProvider,
  supportsOpenAIStrictSchema,
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

export interface OpenAIAIProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly organization?: string;
  readonly project?: string;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly fetchImpl?: typeof fetch;
  readonly client?: ServerStructuredJsonGenerateClient;
}

export class OpenAIAIProvider extends ServerStructuredJsonAIProvider {
  constructor(options: OpenAIAIProviderOptions) {
    super({
      providerId: 'openai',
      displayName: 'OpenAI',
      modelId: options.modelId,
      providerOptions: options.providerOptions,
      client: options.client ?? createOpenAIChatCompletionsClient(options),
    });
  }
}

export function createOpenAIChatCompletionsClient(
  options: Omit<OpenAIAIProviderOptions, 'modelId' | 'client'>,
): ServerStructuredJsonGenerateClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async generateJson(input: ServerStructuredJsonGenerateInput): Promise<StructuredJsonGenerationResult> {
      const startedAt = Date.now();
      const apiKey = options.apiKey?.trim();
      if (!apiKey) throw new Error('OPENAI_API_KEY is required for openai provider');
      const providerOptions = cleanProviderOptions(input.providerOptions);
      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
      if (options.organization?.trim()) headers['OpenAI-Organization'] = options.organization.trim();
      if (options.project?.trim()) headers['OpenAI-Project'] = options.project.trim();
      const maxCompletionTokens = numberProviderOption(providerOptions, 'maxOutputTokens');
      const responseSchema = toStandardJsonSchema(input.responseSchema);
      const strict = supportsOpenAIStrictSchema(responseSchema);
      const body: Record<string, unknown> = {
        model: input.modelId,
        messages: [
          { role: 'system', content: 'Return only JSON that matches the supplied schema.' },
          { role: 'user', content: input.prompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: input.jsonSchemaName,
            strict,
            schema: responseSchema,
          },
        },
      };
      const temperature = numberProviderOption(providerOptions, 'temperature');
      const topP = numberProviderOption(providerOptions, 'topP');
      if (temperature !== undefined) body.temperature = temperature;
      if (topP !== undefined) body.top_p = topP;
      if (maxCompletionTokens !== undefined) body.max_completion_tokens = maxCompletionTokens;
      const baseUrl = options.baseUrl?.replace(/\/+$/, '') || 'https://api.openai.com/v1';
      const json = await postJson('OpenAI', fetchImpl, `${baseUrl}/chat/completions`, headers, body, input.signal);
      const refusal = openAIRefusalPresent(json);
      const text = refusal ? '' : extractOpenAIMessageText(json);
      const baseMetadata = openAIExecutionMetadata(json, input, text, responseSchema, strict, Date.now() - startedAt);
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

function openAIExecutionMetadata(
  value: unknown,
  input: ServerStructuredJsonGenerateInput,
  text: string,
  responseSchema: unknown,
  strict: boolean,
  latencyMs: number,
): ProviderExecutionMetadata {
  const body = record(value);
  const choice = Array.isArray(body?.choices) ? record(body.choices[0]) : undefined;
  const usage = record(body?.usage);
  const completionDetails = record(usage?.completion_tokens_details);
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
  const refusal = openAIRefusalPresent(value);
  return {
    providerId: 'openai',
    providerRequestId: typeof body?.id === 'string' ? body.id : undefined,
    requestedModelId: input.modelId,
    resolvedModelVersion: typeof body?.model === 'string' ? body.model : undefined,
    structuredOutputMode: strict ? 'json_schema_strict' : 'json_schema',
    schemaVersion: input.schemaVersion,
    schemaHash: structuredIntegrityHash(responseSchema),
    finishReason,
    incompleteReason: refusal ? 'refusal' : finishReason && finishReason !== 'stop' ? finishReason : undefined,
    inputTokens: finiteNumber(usage?.prompt_tokens),
    outputTokens: finiteNumber(usage?.completion_tokens),
    reasoningTokens: finiteNumber(completionDetails?.reasoning_tokens),
    inputBytes: new TextEncoder().encode(input.prompt).byteLength,
    outputBytes: new TextEncoder().encode(text).byteLength,
    latencyMs,
    retryCount: 0,
    safetyOrRefusalCode: refusal ? 'refusal' : finishReason === 'content_filter' ? 'content_filter' : undefined,
  };
}

function openAIRefusalPresent(value: unknown): boolean {
  const body = record(value);
  const choice = Array.isArray(body?.choices) ? record(body.choices[0]) : undefined;
  const message = record(choice?.message);
  return typeof message?.refusal === 'string' && Boolean(message.refusal.trim());
}

function extractOpenAIMessageText(value: unknown): string {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  const first = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : undefined;
  const message =
    first?.message && typeof first.message === 'object' ? (first.message as Record<string, unknown>) : undefined;
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part === 'object' ? (part as Record<string, unknown>).text : undefined))
      .filter((part): part is string => typeof part === 'string')
      .join('');
    if (text.trim()) return text;
  }
  return '';
}
