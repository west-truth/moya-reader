import type {
  AIProvider,
  AnalyzeCharacterBundleInput,
  AttributeSpeakersInput,
  CharacterBundleAnalysisResult,
  ChapterLabelingResult,
  CharacterGraph,
  LabelChapterSegmentsInput,
  MergeCharacterGraphInput,
  RepairChapterLabelsInput,
  SpeakerAttributionResultV2,
} from '../../../../src/providers/ai';
import type { Schema } from '@google/genai';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { buildCharacterBundleAnalysisRequest } from '../../../../src/providers/character-bundle-request-profile';
import { dropUnresolvableCharacterBundleRelations } from '../../../../src/providers/character-bundle-contract';
import { buildChapterLabelRepairRequest } from '../../../../src/providers/chapter-label-repair-request-profile';
import { buildChapterLabelingRequest } from '../../../../src/providers/chapter-labeling-request-profile';
import { buildCharacterGraphMergeRequest } from '../../../../src/providers/character-graph-request-profile';
import { restoreMissingCharacterGraphResponseCharacters } from '../../../../src/providers/character-graph-contract';
import { buildCompactSpeakerAttributionRequest } from '../../../../src/providers/speaker-attribution/request-profile';
import { repairSafeSpeakerWireV2Structure } from '../../../../src/providers/speaker-attribution/validator';
import { cleanProviderOptions } from './server-structured-json-provider.js';
import { geminiStructuredJsonResult } from './gemini-execution.js';
import {
  isStructuredJsonGenerationResult,
  type ProviderExecutionMetadata,
  type StructuredJsonGenerationOutput,
} from '../../../../src/providers/provider-execution';
import {
  applyLLMGenerationPolicy,
  resolveLLMGenerationPolicy,
  type LLMGenerationPolicyV2,
  type LLMGenerationTaskKind,
} from '../../../../src/providers/provider-generation-policy';

export interface GeminiVertexGenerateContentClient {
  countTokens?(input: {
    modelId: string;
    prompt: string;
    responseSchema: unknown;
    providerOptions?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<{ readonly totalTokens: number }>;
  generateJson(input: {
    modelId: string;
    prompt: string;
    responseSchema: unknown;
    schemaVersion?: string;
    providerOptions?: Record<string, unknown>;
    generationPolicy?: LLMGenerationPolicyV2;
    signal?: AbortSignal;
  }): Promise<StructuredJsonGenerationOutput>;
}

function generationFields(
  providerId: string,
  modelId: string,
  taskKind: LLMGenerationTaskKind,
  providerOptions: Record<string, unknown>,
): { providerOptions: Record<string, unknown>; generationPolicy: LLMGenerationPolicyV2 } {
  const generationPolicy = resolveLLMGenerationPolicy({ providerId, modelId, taskKind, providerOptions });
  return {
    providerOptions: applyLLMGenerationPolicy(providerOptions, generationPolicy),
    generationPolicy,
  };
}

export interface GeminiVertexAIProviderOptions {
  project?: string;
  location: string;
  modelId: string;
  credentialsPath?: string;
  providerOptions?: Record<string, unknown>;
  client?: GeminiVertexGenerateContentClient;
  restoreMissingCharacterGraphIds?: boolean;
  dropUnresolvableCharacterBundleRelations?: boolean;
  repairSafeSpeakerWireV2Structure?: boolean;
}

export class GeminiVertexAIProvider implements AIProvider {
  readonly providerId = 'gemini-vertex';
  readonly displayName = 'Gemini Vertex AI';
  private executionMetadata: ProviderExecutionMetadata | undefined;

  constructor(private readonly options: GeminiVertexAIProviderOptions) {}

  takeExecutionMetadata(): ProviderExecutionMetadata | undefined {
    const metadata = this.executionMetadata;
    this.executionMetadata = undefined;
    return metadata;
  }

  private async generateJson(
    client: GeminiVertexGenerateContentClient,
    input: Parameters<GeminiVertexGenerateContentClient['generateJson']>[0],
  ): Promise<string> {
    const output = await client.generateJson(input);
    if (!isStructuredJsonGenerationResult(output)) return output;
    this.executionMetadata = { ...output.executionMetadata, providerId: this.providerId };
    return output.text;
  }

  async labelChapterSegments(input: LabelChapterSegmentsInput): Promise<ChapterLabelingResult> {
    if (!this.options.modelId.trim()) throw new Error('Gemini Vertex model id is required');
    const client = this.options.client ?? (await createGeminiVertexGenerateContentClient(this.options));
    const request = buildChapterLabelingRequest(input, this.options.providerOptions);
    const text = await this.generateJson(client, {
      modelId: this.options.modelId,
      prompt: request.prompt,
      responseSchema: request.responseSchema,
      schemaVersion: request.profile.schemaVersion,
      ...generationFields(this.providerId, this.options.modelId, 'standard_labeling', request.providerOptions),
      signal: input.signal,
    });
    return request.profile.toResult(input, request.profile.parseResponse(text));
  }

  async attributeSpeakers(input: AttributeSpeakersInput): Promise<SpeakerAttributionResultV2> {
    if (!this.options.modelId.trim()) throw new Error('Gemini Vertex model id is required');
    const client = this.options.client ?? (await createGeminiVertexGenerateContentClient(this.options));
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
    const text = await this.generateJson(client, {
      modelId: this.options.modelId,
      prompt: request.prompt,
      responseSchema: request.responseSchema,
      schemaVersion: request.schemaVersion,
      providerOptions: request.providerOptions,
      generationPolicy: request.generationPolicy,
      signal: input.signal,
    });
    const parsed = request.parseResponse(text);
    const wire = this.options.repairSafeSpeakerWireV2Structure
      ? repairSafeSpeakerWireV2Structure(input.packet, parsed)
      : parsed;
    return {
      packetFingerprint: input.packet.fingerprint,
      validatedWire: request.validateResponse(wire),
    };
  }

  async repairChapterLabels(input: RepairChapterLabelsInput): Promise<ChapterLabelingResult> {
    if (!this.options.modelId.trim()) throw new Error('Gemini Vertex model id is required');
    const client = this.options.client ?? (await createGeminiVertexGenerateContentClient(this.options));
    const request = buildChapterLabelRepairRequest(input, this.options.providerOptions);
    const text = await this.generateJson(client, {
      modelId: this.options.modelId,
      prompt: request.prompt,
      responseSchema: request.responseSchema,
      schemaVersion: request.profile.schemaVersion,
      ...generationFields(this.providerId, this.options.modelId, 'patch_repair', request.providerOptions),
      signal: input.signal,
    });
    return request.profile.toResult(input, request.profile.parseResponse(text));
  }

  async analyzeCharacterBundle(input: AnalyzeCharacterBundleInput): Promise<CharacterBundleAnalysisResult> {
    if (!this.options.modelId.trim()) throw new Error('Gemini Vertex model id is required');
    const client = this.options.client ?? (await createGeminiVertexGenerateContentClient(this.options));
    const request = buildCharacterBundleAnalysisRequest(input, this.options.providerOptions);
    const text = await this.generateJson(client, {
      modelId: this.options.modelId,
      prompt: request.prompt,
      responseSchema: request.responseSchema,
      schemaVersion: request.profile.schemaVersion,
      ...generationFields(this.providerId, this.options.modelId, 'graph_observation', request.providerOptions),
      signal: input.signal,
    });
    const parsed = request.profile.parseResponse(text);
    const response = this.options.dropUnresolvableCharacterBundleRelations
      ? dropUnresolvableCharacterBundleRelations(parsed).response
      : parsed;
    return request.profile.toResult(input, response);
  }

  async mergeCharacterGraph(input: MergeCharacterGraphInput): Promise<CharacterGraph> {
    if (!this.options.modelId.trim()) throw new Error('Gemini Vertex model id is required');
    const client = this.options.client ?? (await createGeminiVertexGenerateContentClient(this.options));
    const request = buildCharacterGraphMergeRequest(input, this.options.providerOptions);
    const text = await this.generateJson(client, {
      modelId: this.options.modelId,
      prompt: request.prompt,
      responseSchema: request.responseSchema,
      schemaVersion: request.profile.schemaVersion,
      ...generationFields(this.providerId, this.options.modelId, 'graph_consolidation', request.providerOptions),
      signal: input.signal,
    });
    const parsed = request.profile.parseResponse(text);
    const response = this.options.restoreMissingCharacterGraphIds
      ? restoreMissingCharacterGraphResponseCharacters(input, parsed).response
      : parsed;
    return request.profile.toResult(input, response);
  }
}

export class GeminiAgentPlatformAIProvider implements AIProvider {
  readonly providerId = 'gemini-agent-platform';
  readonly displayName = 'Gemini Enterprise Agent Platform';
  private executionMetadata: ProviderExecutionMetadata | undefined;

  constructor(private readonly options: GeminiVertexAIProviderOptions) {}

  takeExecutionMetadata(): ProviderExecutionMetadata | undefined {
    const metadata = this.executionMetadata;
    this.executionMetadata = undefined;
    return metadata;
  }

  private async generateJson(
    client: GeminiVertexGenerateContentClient,
    input: Parameters<GeminiVertexGenerateContentClient['generateJson']>[0],
  ): Promise<string> {
    const output = await client.generateJson(input);
    if (!isStructuredJsonGenerationResult(output)) return output;
    this.executionMetadata = { ...output.executionMetadata, providerId: this.providerId };
    return output.text;
  }

  async labelChapterSegments(input: LabelChapterSegmentsInput): Promise<ChapterLabelingResult> {
    if (!this.options.modelId.trim()) throw new Error('Gemini Agent Platform model id is required');
    const client = this.options.client ?? (await createGeminiVertexGenerateContentClient(this.options));
    const request = buildChapterLabelingRequest(input, this.options.providerOptions);
    const text = await this.generateJson(client, {
      modelId: this.options.modelId,
      prompt: request.prompt,
      responseSchema: request.responseSchema,
      schemaVersion: request.profile.schemaVersion,
      ...generationFields(this.providerId, this.options.modelId, 'standard_labeling', request.providerOptions),
      signal: input.signal,
    });
    return request.profile.toResult(input, request.profile.parseResponse(text));
  }

  async repairChapterLabels(input: RepairChapterLabelsInput): Promise<ChapterLabelingResult> {
    if (!this.options.modelId.trim()) throw new Error('Gemini Agent Platform model id is required');
    const client = this.options.client ?? (await createGeminiVertexGenerateContentClient(this.options));
    const request = buildChapterLabelRepairRequest(input, this.options.providerOptions);
    const text = await this.generateJson(client, {
      modelId: this.options.modelId,
      prompt: request.prompt,
      responseSchema: request.responseSchema,
      schemaVersion: request.profile.schemaVersion,
      ...generationFields(this.providerId, this.options.modelId, 'patch_repair', request.providerOptions),
      signal: input.signal,
    });
    return request.profile.toResult(input, request.profile.parseResponse(text));
  }

  async analyzeCharacterBundle(input: AnalyzeCharacterBundleInput): Promise<CharacterBundleAnalysisResult> {
    if (!this.options.modelId.trim()) throw new Error('Gemini Agent Platform model id is required');
    const client = this.options.client ?? (await createGeminiVertexGenerateContentClient(this.options));
    const request = buildCharacterBundleAnalysisRequest(input, this.options.providerOptions);
    const text = await this.generateJson(client, {
      modelId: this.options.modelId,
      prompt: request.prompt,
      responseSchema: request.responseSchema,
      schemaVersion: request.profile.schemaVersion,
      ...generationFields(this.providerId, this.options.modelId, 'graph_observation', request.providerOptions),
      signal: input.signal,
    });
    const parsed = request.profile.parseResponse(text);
    const response = this.options.dropUnresolvableCharacterBundleRelations
      ? dropUnresolvableCharacterBundleRelations(parsed).response
      : parsed;
    return request.profile.toResult(input, response);
  }

  async mergeCharacterGraph(input: MergeCharacterGraphInput): Promise<CharacterGraph> {
    if (!this.options.modelId.trim()) throw new Error('Gemini Agent Platform model id is required');
    const client = this.options.client ?? (await createGeminiVertexGenerateContentClient(this.options));
    const request = buildCharacterGraphMergeRequest(input, this.options.providerOptions);
    const text = await this.generateJson(client, {
      modelId: this.options.modelId,
      prompt: request.prompt,
      responseSchema: request.responseSchema,
      schemaVersion: request.profile.schemaVersion,
      ...generationFields(this.providerId, this.options.modelId, 'graph_consolidation', request.providerOptions),
      signal: input.signal,
    });
    const parsed = request.profile.parseResponse(text);
    const response = this.options.restoreMissingCharacterGraphIds
      ? restoreMissingCharacterGraphResponseCharacters(input, parsed).response
      : parsed;
    return request.profile.toResult(input, response);
  }
}

export async function createGeminiVertexGenerateContentClient(
  options: Omit<GeminiVertexAIProviderOptions, 'client' | 'modelId'>,
): Promise<GeminiVertexGenerateContentClient> {
  if (!options.project?.trim()) throw new Error('GOOGLE_CLOUD_PROJECT is required for gemini-vertex provider');
  if (options.credentialsPath && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = options.credentialsPath;
  }
  process.env.GOOGLE_GENAI_USE_ENTERPRISE = process.env.GOOGLE_GENAI_USE_ENTERPRISE || 'True';
  const { GoogleGenAI } = await import('@google/genai');
  const sdkClient = new GoogleGenAI({
    vertexai: true,
    project: options.project,
    location: options.location || 'global',
  });
  return {
    async countTokens(input) {
      const response = await sdkClient.models.countTokens({
        model: input.modelId,
        contents: input.prompt,
        config: {
          abortSignal: input.signal,
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: input.responseSchema as Schema,
            ...cleanProviderOptions(input.providerOptions),
          },
        },
      });
      if (!Number.isSafeInteger(response.totalTokens) || (response.totalTokens ?? 0) < 1) {
        throw new Error('Gemini Vertex countTokens returned an invalid total');
      }
      return { totalTokens: response.totalTokens! };
    },
    async generateJson(input) {
      const startedAt = Date.now();
      const config: Record<string, unknown> = {
        responseMimeType: 'application/json',
        responseSchema: input.responseSchema,
        ...cleanProviderOptions(input.providerOptions),
        abortSignal: input.signal,
      };
      const response = await sdkClient.models.generateContent({
        model: input.modelId,
        contents: input.prompt,
        config,
      });
      const text = typeof response.text === 'string' ? response.text : '';
      return geminiStructuredJsonResult({
        providerId: 'gemini-vertex',
        requestedModelId: input.modelId,
        prompt: input.prompt,
        schemaVersion: input.schemaVersion,
        responseSchema: input.responseSchema,
        response,
        text,
        latencyMs: Date.now() - startedAt,
        generationPolicy: input.generationPolicy,
      });
    },
  };
}
