import type {
  AIProvider,
  AttributeSpeakersInput,
  AnalyzeCharacterBundleInput,
  CharacterBundleAnalysisResult,
  ChapterLabelingResult,
  CharacterGraph,
  LabelChapterSegmentsInput,
  MergeCharacterGraphInput,
  RepairChapterLabelsInput,
  SpeakerAttributionResultV2,
} from '../../../../src/providers/ai';
import { buildCharacterBundleAnalysisRequest } from '../../../../src/providers/character-bundle-request-profile';
import { buildChapterLabelRepairRequest } from '../../../../src/providers/chapter-label-repair-request-profile';
import { buildChapterLabelingRequest } from '../../../../src/providers/chapter-labeling-request-profile';
import { buildCharacterGraphMergeRequest } from '../../../../src/providers/character-graph-request-profile';
import {
  attachProviderExecutionMetadata,
  isStructuredJsonGenerationResult,
  normalizeProviderExecutionMetadata,
  type ProviderExecutionMetadata,
  type StructuredJsonGenerationOutput,
} from '../../../../src/providers/provider-execution';
import {
  applyLLMGenerationPolicy,
  resolveLLMGenerationPolicy,
  type LLMGenerationPolicyV2,
  type LLMGenerationTaskKind,
} from '../../../../src/providers/provider-generation-policy';
import { withProviderOutputDiagnostics } from '../../../../src/providers/speaker-attribution/failure-classifier';
import { buildCompactSpeakerAttributionRequest } from '../../../../src/providers/speaker-attribution/request-profile';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';

export interface ServerStructuredJsonGenerateInput {
  readonly modelId: string;
  readonly prompt: string;
  readonly responseSchema: unknown;
  readonly jsonSchemaName: string;
  readonly schemaVersion?: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly generationPolicy?: LLMGenerationPolicyV2;
  readonly signal?: AbortSignal;
}

export interface ServerStructuredJsonGenerateClient {
  generateJson(input: ServerStructuredJsonGenerateInput): Promise<StructuredJsonGenerationOutput>;
}

export interface ServerStructuredJsonAIProviderOptions {
  readonly providerId: string;
  readonly displayName: string;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly client: ServerStructuredJsonGenerateClient;
}

export class ServerStructuredJsonAIProvider implements AIProvider {
  readonly providerId: string;
  readonly displayName: string;
  private executionMetadata: ProviderExecutionMetadata | undefined;

  constructor(private readonly options: ServerStructuredJsonAIProviderOptions) {
    this.providerId = options.providerId;
    this.displayName = options.displayName;
  }

  takeExecutionMetadata(): ProviderExecutionMetadata | undefined {
    const metadata = this.executionMetadata;
    this.executionMetadata = undefined;
    return metadata;
  }

  private async generateJson<T>(input: ServerStructuredJsonGenerateInput, parse: (text: string) => T): Promise<T> {
    const output = await this.options.client.generateJson(input);
    if (!isStructuredJsonGenerationResult(output)) return parse(output);
    const baseMetadata = normalizeProviderExecutionMetadata(output.executionMetadata);
    if (!baseMetadata) throw new Error(`${this.displayName} returned invalid provider execution metadata`);
    const metadata = normalizeProviderExecutionMetadata(
      withProviderOutputDiagnostics(baseMetadata, {
        generationPolicy: input.generationPolicy,
        prompt: input.prompt,
        text: output.text,
      }),
    );
    if (!metadata) throw new Error(`${this.displayName} returned invalid provider execution evidence`);
    this.executionMetadata = metadata;
    try {
      return parse(output.text);
    } catch (error) {
      this.executionMetadata = undefined;
      throw attachProviderExecutionMetadata(error, metadata);
    }
  }

  private generationFields(
    taskKind: LLMGenerationTaskKind,
    providerOptions: Record<string, unknown>,
  ): Pick<ServerStructuredJsonGenerateInput, 'modelId' | 'providerOptions' | 'generationPolicy'> {
    const generationPolicy = resolveLLMGenerationPolicy({
      providerId: this.providerId,
      modelId: this.options.modelId,
      taskKind,
      providerOptions,
    });
    return {
      modelId: this.options.modelId,
      providerOptions: applyLLMGenerationPolicy(providerOptions, generationPolicy),
      generationPolicy,
    };
  }

  async labelChapterSegments(input: LabelChapterSegmentsInput): Promise<ChapterLabelingResult> {
    if (!this.options.modelId.trim()) throw new Error(`${this.displayName} model id is required`);
    const request = buildChapterLabelingRequest(input, this.options.providerOptions);
    return this.generateJson(
      {
        ...this.generationFields('standard_labeling', request.providerOptions),
        prompt: request.prompt,
        responseSchema: request.responseSchema,
        jsonSchemaName: request.jsonSchemaName,
        schemaVersion: request.profile.schemaVersion,
        signal: input.signal,
      },
      (text) => request.profile.toResult(input, request.profile.parseResponse(text)),
    );
  }

  async attributeSpeakers(input: AttributeSpeakersInput): Promise<SpeakerAttributionResultV2> {
    if (!this.options.modelId.trim()) throw new Error(`${this.displayName} model id is required`);
    const request = buildCompactSpeakerAttributionRequest({
      packet: input.packet,
      providerId: this.providerId,
      modelId: this.options.modelId,
      providerOptions: this.options.providerOptions,
      modelMaxOutputTokens: input.outputBudget.requestedOutputCap,
      reasoningP99: input.outputBudget.reasoningReserve,
      taskKind: input.mode === 'independent_escalation' ? 'speaker_escalation' : 'speaker_attribution',
    });
    if (
      request.generationPolicy.fingerprint !== input.generationPolicy.fingerprint ||
      structuredIntegrityHash(request.outputBudget) !== structuredIntegrityHash(input.outputBudget)
    ) {
      throw new Error('Pinned compact speaker generation policy or output budget is stale');
    }
    const validatedWire = await this.generateJson(
      {
        modelId: this.options.modelId,
        prompt: request.prompt,
        responseSchema: request.responseSchema,
        jsonSchemaName: request.jsonSchemaName,
        schemaVersion: request.schemaVersion,
        providerOptions: request.providerOptions,
        generationPolicy: request.generationPolicy,
        signal: input.signal,
      },
      (text) => request.validateResponse(request.parseResponse(text)),
    );
    return { packetFingerprint: input.packet.fingerprint, validatedWire };
  }

  async repairChapterLabels(input: RepairChapterLabelsInput): Promise<ChapterLabelingResult> {
    if (!this.options.modelId.trim()) throw new Error(`${this.displayName} model id is required`);
    const request = buildChapterLabelRepairRequest(input, this.options.providerOptions);
    return this.generateJson(
      {
        ...this.generationFields('patch_repair', request.providerOptions),
        prompt: request.prompt,
        responseSchema: request.responseSchema,
        jsonSchemaName: request.jsonSchemaName,
        schemaVersion: request.profile.schemaVersion,
        signal: input.signal,
      },
      (text) => request.profile.toResult(input, request.profile.parseResponse(text)),
    );
  }

  async analyzeCharacterBundle(input: AnalyzeCharacterBundleInput): Promise<CharacterBundleAnalysisResult> {
    if (!this.options.modelId.trim()) throw new Error(`${this.displayName} model id is required`);
    const request = buildCharacterBundleAnalysisRequest(input, this.options.providerOptions);
    return this.generateJson(
      {
        ...this.generationFields('graph_observation', request.providerOptions),
        prompt: request.prompt,
        responseSchema: request.responseSchema,
        jsonSchemaName: request.jsonSchemaName,
        schemaVersion: request.profile.schemaVersion,
        signal: input.signal,
      },
      (text) => request.profile.toResult(input, request.profile.parseResponse(text)),
    );
  }

  async mergeCharacterGraph(input: MergeCharacterGraphInput): Promise<CharacterGraph> {
    if (!this.options.modelId.trim()) throw new Error(`${this.displayName} model id is required`);
    const request = buildCharacterGraphMergeRequest(input, this.options.providerOptions);
    return this.generateJson(
      {
        ...this.generationFields('graph_consolidation', request.providerOptions),
        prompt: request.prompt,
        responseSchema: request.responseSchema,
        jsonSchemaName: request.jsonSchemaName,
        schemaVersion: request.profile.schemaVersion,
        signal: input.signal,
      },
      (text) => request.profile.toResult(input, request.profile.parseResponse(text)),
    );
  }
}

export function cleanProviderOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!options) return {};
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

export function numberProviderOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

const singleSchemaKeys = new Set(['items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames']);
const schemaArrayKeys = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const schemaMapKeys = new Set(['$defs', 'definitions', 'patternProperties', 'dependentSchemas']);

function schemaMap(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function toStandardJsonSchema(schema: unknown): unknown {
  const source = schemaMap(schema);
  if (!source) return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'type') {
      result.type =
        typeof value === 'string'
          ? value.toLowerCase()
          : Array.isArray(value)
            ? value.map((item) => (typeof item === 'string' ? item.toLowerCase() : item))
            : value;
      continue;
    }
    if (key === 'properties' || schemaMapKeys.has(key)) {
      const entries = schemaMap(value);
      result[key] = entries
        ? Object.fromEntries(Object.entries(entries).map(([name, child]) => [name, toStandardJsonSchema(child)]))
        : value;
      continue;
    }
    if (singleSchemaKeys.has(key)) {
      result[key] = toStandardJsonSchema(value);
      continue;
    }
    if (schemaArrayKeys.has(key)) {
      result[key] = Array.isArray(value) ? value.map(toStandardJsonSchema) : value;
      continue;
    }
    result[key] = value;
  }
  if (result.type === 'object' || schemaMap(result.properties)) {
    result.additionalProperties = false;
  }
  return result;
}

export function supportsOpenAIStrictSchema(schema: unknown): boolean {
  const source = schemaMap(schema);
  if (!source) return true;
  const properties = schemaMap(source.properties);
  if (properties) {
    const required = new Set(
      Array.isArray(source.required) ? source.required.filter((item): item is string => typeof item === 'string') : [],
    );
    if (Object.keys(properties).some((key) => !required.has(key))) return false;
    if (Object.values(properties).some((child) => !supportsOpenAIStrictSchema(child))) return false;
  }
  for (const key of singleSchemaKeys) {
    if (key in source && !supportsOpenAIStrictSchema(source[key])) return false;
  }
  for (const key of schemaArrayKeys) {
    const values = source[key];
    if (Array.isArray(values) && values.some((child) => !supportsOpenAIStrictSchema(child))) return false;
  }
  for (const key of schemaMapKeys) {
    const values = schemaMap(source[key]);
    if (values && Object.values(values).some((child) => !supportsOpenAIStrictSchema(child))) return false;
  }
  return true;
}

export async function postJson(
  providerName: string,
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    const message = text.trim().slice(0, 500) || response.statusText;
    throw new Error(`${providerName} request failed (${response.status}): ${message}`);
  }
  if (!text.trim()) throw new Error(`${providerName} returned an empty response`);
  return JSON.parse(text);
}
