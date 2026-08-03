import {
  cleanProviderOptions,
  ServerStructuredJsonAIProvider,
  type ServerStructuredJsonGenerateClient,
  type ServerStructuredJsonGenerateInput,
} from './server-structured-json-provider.js';
import { geminiStructuredJsonResult } from './gemini-execution.js';
import type { StructuredJsonGenerationResult } from '../../../../src/providers/provider-execution';

export interface GeminiAIStudioProviderOptions {
  readonly apiKey?: string;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly client?: ServerStructuredJsonGenerateClient;
}

export class GeminiAIStudioProvider extends ServerStructuredJsonAIProvider {
  constructor(options: GeminiAIStudioProviderOptions) {
    super({
      providerId: 'gemini-ai-studio',
      displayName: 'Gemini API / AI Studio',
      modelId: options.modelId,
      providerOptions: options.providerOptions,
      client: options.client ?? createGeminiAIStudioGenerateContentClient(options),
    });
  }
}

export function createGeminiAIStudioGenerateContentClient(
  options: Omit<GeminiAIStudioProviderOptions, 'modelId' | 'client'>,
): ServerStructuredJsonGenerateClient {
  return {
    async generateJson(input: ServerStructuredJsonGenerateInput): Promise<StructuredJsonGenerationResult> {
      const startedAt = Date.now();
      const apiKey = options.apiKey?.trim();
      if (!apiKey) throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is required for gemini-ai-studio provider');
      const { GoogleGenAI } = await import('@google/genai');
      const sdkClient = new GoogleGenAI({ apiKey });
      const response = await sdkClient.models.generateContent({
        model: input.modelId,
        contents: input.prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: input.responseSchema,
          ...cleanProviderOptions(input.providerOptions),
          abortSignal: input.signal,
        },
      });
      const text = typeof response.text === 'string' ? response.text : '';
      return geminiStructuredJsonResult({
        providerId: 'gemini-ai-studio',
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
