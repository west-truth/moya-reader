import { MockAIProvider, type AIProvider } from '../../../../src/providers/ai';
import { AnthropicAIProvider } from './anthropic-ai-provider.js';
import { GeminiAIStudioProvider } from './gemini-ai-studio-provider.js';
import { GeminiAgentPlatformAIProvider, GeminiVertexAIProvider } from './gemini-vertex-ai-provider.js';
import { OpenAIAIProvider } from './openai-ai-provider.js';
import { isServerAIProviderId, loadServerAISettings, modelIdForProvider, type ServerAISettings } from './server-ai-config.js';
import type { ResolvedProviderSecrets } from './server-provider-secrets.js';

export interface ServerAIProviderFactoryInput {
  providerId: string;
  modelId?: string | null;
  settings?: ServerAISettings;
  providerOptions?: Record<string, unknown>;
  secrets?: ResolvedProviderSecrets;
}

export function createServerAIProvider(input: ServerAIProviderFactoryInput): AIProvider {
  const settings = input.settings ?? loadServerAISettings();
  if (!isServerAIProviderId(input.providerId)) throw new Error(`Unsupported AI provider: ${input.providerId}`);
  const providerId = input.providerId;
  const modelId = modelIdForProvider(settings, providerId, input.modelId ?? undefined);
  if (providerId === 'mock') return new MockAIProvider();
  if (providerId === 'openai') {
    if (!modelId) throw new Error('AI_OPENAI_LABELING_MODEL_ID or AI_LABELING_MODEL_ID is required for openai provider');
    return new OpenAIAIProvider({
      apiKey: input.secrets?.apiKey ?? settings.openAI.apiKey,
      baseUrl: settings.openAI.baseUrl,
      organization: settings.openAI.organization,
      project: settings.openAI.project,
      modelId,
      providerOptions: { ...settings.openAI.providerOptions, ...input.providerOptions },
    });
  }
  if (providerId === 'gemini-ai-studio') {
    if (!modelId) throw new Error('AI_GEMINI_AI_STUDIO_LABELING_MODEL_ID or AI_LABELING_MODEL_ID is required for gemini-ai-studio provider');
    return new GeminiAIStudioProvider({
      apiKey: input.secrets?.apiKey ?? settings.geminiAIStudio.apiKey,
      modelId,
      providerOptions: { ...settings.geminiAIStudio.providerOptions, ...input.providerOptions },
    });
  }
  if (providerId === 'gemini-vertex') {
    if (!modelId) throw new Error('AI_LABELING_MODEL_ID is required for gemini-vertex provider');
    return new GeminiVertexAIProvider({
      project: settings.geminiVertex.project,
      location: settings.geminiVertex.location,
      modelId,
      credentialsPath: input.secrets?.credentialsPath ?? settings.geminiVertex.credentialsPath,
      providerOptions: { ...settings.geminiVertex.providerOptions, ...input.providerOptions },
    });
  }
  if (providerId === 'gemini-agent-platform') {
    if (!modelId) throw new Error('AI_GEMINI_AGENT_PLATFORM_LABELING_MODEL_ID or AI_LABELING_MODEL_ID is required for gemini-agent-platform provider');
    return new GeminiAgentPlatformAIProvider({
      project: settings.geminiAgentPlatform.project,
      location: settings.geminiAgentPlatform.location,
      modelId,
      credentialsPath: input.secrets?.credentialsPath ?? settings.geminiAgentPlatform.credentialsPath,
      providerOptions: { ...settings.geminiAgentPlatform.providerOptions, ...input.providerOptions },
    });
  }
  if (providerId === 'anthropic') {
    if (!modelId) throw new Error('AI_ANTHROPIC_LABELING_MODEL_ID or AI_LABELING_MODEL_ID is required for anthropic provider');
    return new AnthropicAIProvider({
      apiKey: input.secrets?.apiKey ?? settings.anthropic.apiKey,
      baseUrl: settings.anthropic.baseUrl,
      anthropicVersion: settings.anthropic.anthropicVersion,
      modelId,
      providerOptions: { ...settings.anthropic.providerOptions, ...input.providerOptions },
    });
  }
  throw new Error(`Unsupported AI provider: ${input.providerId}`);
}
