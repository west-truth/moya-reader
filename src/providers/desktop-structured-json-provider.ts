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
} from './ai';
import { buildCharacterBundleAnalysisRequest } from './character-bundle-request-profile';
import { buildChapterLabelRepairRequest } from './chapter-label-repair-request-profile';
import { buildChapterLabelingRequest } from './chapter-labeling-request-profile';
import { buildCharacterGraphMergeRequest } from './character-graph-request-profile';
import {
  attachProviderExecutionMetadata,
  isStructuredJsonGenerationResult,
  normalizeProviderExecutionMetadata,
  ProviderOutputIncompleteError,
  type ProviderExecutionMetadata,
  type StructuredJsonGenerationOutput,
  type StructuredJsonGenerationResult,
} from './provider-execution';
import {
  applyLLMGenerationPolicy,
  resolveLLMGenerationPolicy,
  type LLMGenerationPolicyV2,
  type LLMGenerationTaskKind,
} from './provider-generation-policy';
import { withProviderOutputDiagnostics } from './speaker-attribution/failure-classifier';
import { buildCompactSpeakerAttributionRequest } from './speaker-attribution/request-profile';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';

export interface DesktopStructuredJsonGenerateInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly responseSchema: unknown;
  readonly jsonSchemaName: string;
  readonly schemaVersion?: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly generationPolicy?: LLMGenerationPolicyV2;
}

export type DesktopStructuredJsonGenerate = (
  input: DesktopStructuredJsonGenerateInput,
) => Promise<StructuredJsonGenerationOutput>;

export interface DesktopStructuredJsonAIProviderOptions {
  readonly providerId: string;
  readonly displayName?: string;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly generateJson?: DesktopStructuredJsonGenerate;
}

export interface DesktopStructuredJsonSampleInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly generateJson?: DesktopStructuredJsonGenerate;
}

export interface DesktopStructuredJsonSampleResult {
  readonly ok: true;
  readonly providerId: string;
  readonly modelId: string;
  readonly message: string;
}

const desktopStructuredJsonSampleSchema = {
  type: 'OBJECT',
  properties: {
    ok: { type: 'BOOLEAN' },
    message: { type: 'STRING' },
  },
  required: ['ok', 'message'],
};

const desktopStructuredJsonSamplePrompt = [
  'Return only JSON matching the supplied schema.',
  'This is a provider connectivity smoke test for Moya.',
  'Set ok to true and message to "ready".',
].join('\n');

const desktopStructuredJsonSampleInternalOptionKeys = new Set([
  'requestProfileId',
  'labelingProfileId',
  'promptProfileId',
  'promptVersion',
  'autoRepairOnValidationFailure',
  'repairRequestProfileId',
  'repairProfileId',
  'characterBundleProfileId',
  'bundleRequestProfileId',
  'bundleAnalysisProfileId',
  'characterGraphProfileId',
  'graphRequestProfileId',
]);

export class DesktopStructuredJsonAIProvider implements AIProvider {
  readonly providerId: string;
  readonly displayName: string;
  private executionMetadata: ProviderExecutionMetadata | undefined;

  constructor(private readonly options: DesktopStructuredJsonAIProviderOptions) {
    this.providerId = options.providerId;
    this.displayName = options.displayName ?? options.providerId;
  }

  takeExecutionMetadata(): ProviderExecutionMetadata | undefined {
    const metadata = this.executionMetadata;
    this.executionMetadata = undefined;
    return metadata;
  }

  private async generateJson<T>(input: DesktopStructuredJsonGenerateInput, parse: (text: string) => T): Promise<T> {
    const output = await (this.options.generateJson ?? invokeDesktopStructuredJson)(input);
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
  ): Pick<DesktopStructuredJsonGenerateInput, 'providerOptions' | 'generationPolicy'> {
    const generationPolicy = resolveLLMGenerationPolicy({
      providerId: this.providerId,
      modelId: this.options.modelId,
      taskKind,
      providerOptions,
    });
    return {
      providerOptions: applyLLMGenerationPolicy(providerOptions, generationPolicy),
      generationPolicy,
    };
  }

  async labelChapterSegments(input: LabelChapterSegmentsInput): Promise<ChapterLabelingResult> {
    if (!this.options.modelId.trim()) throw new Error(`${this.displayName} model id is required`);
    const request = buildChapterLabelingRequest(input, this.options.providerOptions);
    return this.generateJson(
      {
        providerId: this.providerId,
        modelId: this.options.modelId,
        prompt: request.prompt,
        responseSchema: request.responseSchema,
        jsonSchemaName: request.jsonSchemaName,
        schemaVersion: request.profile.schemaVersion,
        ...this.generationFields('standard_labeling', request.providerOptions),
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
        providerId: this.providerId,
        modelId: this.options.modelId,
        prompt: request.prompt,
        responseSchema: request.responseSchema,
        jsonSchemaName: request.jsonSchemaName,
        schemaVersion: request.schemaVersion,
        providerOptions: request.providerOptions,
        generationPolicy: request.generationPolicy,
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
        providerId: this.providerId,
        modelId: this.options.modelId,
        prompt: request.prompt,
        responseSchema: request.responseSchema,
        jsonSchemaName: request.jsonSchemaName,
        schemaVersion: request.profile.schemaVersion,
        ...this.generationFields('patch_repair', request.providerOptions),
      },
      (text) => request.profile.toResult(input, request.profile.parseResponse(text)),
    );
  }

  async analyzeCharacterBundle(input: AnalyzeCharacterBundleInput): Promise<CharacterBundleAnalysisResult> {
    if (!this.options.modelId.trim()) throw new Error(`${this.displayName} model id is required`);
    const request = buildCharacterBundleAnalysisRequest(input, this.options.providerOptions);
    return this.generateJson(
      {
        providerId: this.providerId,
        modelId: this.options.modelId,
        prompt: request.prompt,
        responseSchema: request.responseSchema,
        jsonSchemaName: request.jsonSchemaName,
        schemaVersion: request.profile.schemaVersion,
        ...this.generationFields('graph_observation', request.providerOptions),
      },
      (text) => request.profile.toResult(input, request.profile.parseResponse(text)),
    );
  }

  async mergeCharacterGraph(input: MergeCharacterGraphInput): Promise<CharacterGraph> {
    if (!this.options.modelId.trim()) throw new Error(`${this.displayName} model id is required`);
    const request = buildCharacterGraphMergeRequest(input, this.options.providerOptions);
    return this.generateJson(
      {
        providerId: this.providerId,
        modelId: this.options.modelId,
        prompt: request.prompt,
        responseSchema: request.responseSchema,
        jsonSchemaName: request.jsonSchemaName,
        schemaVersion: request.profile.schemaVersion,
        ...this.generationFields('graph_consolidation', request.providerOptions),
      },
      (text) => request.profile.toResult(input, request.profile.parseResponse(text)),
    );
  }
}

export function desktopStructuredJsonProviderName(providerId: string): string {
  if (providerId === 'openai') return 'OpenAI';
  if (providerId === 'gemini-ai-studio') return 'Gemini API / AI Studio';
  if (providerId === 'gemini-vertex') return 'Gemini Vertex';
  if (providerId === 'anthropic') return 'Claude API';
  return providerId;
}

export async function runDesktopStructuredJsonSample(
  input: DesktopStructuredJsonSampleInput,
): Promise<DesktopStructuredJsonSampleResult> {
  const providerId = input.providerId.trim();
  const modelId = input.modelId.trim();
  if (!providerId) throw new Error('기기 로컬 LLM provider id가 필요합니다');
  if (!modelId) throw new Error(`${desktopStructuredJsonProviderName(providerId)} 모델이 필요합니다`);

  const generated = await (input.generateJson ?? invokeDesktopStructuredJson)({
    providerId,
    modelId,
    prompt: desktopStructuredJsonSamplePrompt,
    responseSchema: desktopStructuredJsonSampleSchema,
    jsonSchemaName: 'noveldesk_provider_smoke',
    schemaVersion: 'provider-smoke-v1',
    providerOptions: desktopStructuredJsonSampleProviderOptions(input.providerOptions),
  });
  const text = isStructuredJsonGenerationResult(generated) ? generated.text : generated;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('기기 로컬 LLM 샘플 응답이 올바른 JSON이 아닙니다');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('기기 로컬 LLM 샘플 응답이 JSON 객체가 아닙니다');
  }
  const record = parsed as Record<string, unknown>;
  if (record.ok !== true) {
    throw new Error('기기 로컬 LLM 샘플 응답으로 준비 상태를 확인하지 못했습니다');
  }
  const message = typeof record.message === 'string' && record.message.trim() ? record.message.trim() : 'ready';
  return { ok: true, providerId, modelId, message };
}

async function invokeDesktopStructuredJson(
  input: DesktopStructuredJsonGenerateInput,
): Promise<StructuredJsonGenerationResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<StructuredJsonGenerationResult>('desktop_ai_generate_json', {
      request: {
        providerId: input.providerId,
        modelId: input.modelId,
        prompt: input.prompt,
        responseSchema: input.responseSchema,
        jsonSchemaName: input.jsonSchemaName,
        schemaVersion: input.schemaVersion,
        providerOptions: input.providerOptions ?? {},
      },
    });
  } catch (error) {
    const source = error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
    const metadata = normalizeProviderExecutionMetadata(source?.executionMetadata);
    if (source?.code === 'provider_output_incomplete' && metadata) {
      throw new ProviderOutputIncompleteError(metadata);
    }
    throw error;
  }
}

function desktopStructuredJsonSampleProviderOptions(
  providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!providerOptions) return {};
  return Object.fromEntries(
    Object.entries(providerOptions).filter(([key]) => !desktopStructuredJsonSampleInternalOptionKeys.has(key)),
  );
}
