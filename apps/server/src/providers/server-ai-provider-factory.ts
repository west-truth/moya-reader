import { MockAIProvider, type AIProvider } from '../../../../src/providers/ai';
import { AnthropicAIProvider } from './anthropic-ai-provider.js';
import { GeminiAIStudioProvider } from './gemini-ai-studio-provider.js';
import { GeminiAgentPlatformAIProvider, GeminiVertexAIProvider } from './gemini-vertex-ai-provider.js';
import { OpenAIAIProvider } from './openai-ai-provider.js';
import {
  isServerAIProviderId,
  loadServerAISettings,
  modelIdForProvider,
  type ServerAISettings,
} from './server-ai-config.js';
import type { ProviderSecretName, ResolvedProviderSecrets } from './server-provider-secrets.js';
import { ServerProviderTransportRegistry } from './server-provider-transport-registry.js';

export interface ServerAIProviderFactoryInput {
  providerId: string;
  modelId?: string | null;
  settings?: ServerAISettings;
  providerOptions?: Record<string, unknown>;
  secrets?: ResolvedProviderSecrets;
}

interface ResolvedServerAIProviderFactoryInput extends ServerAIProviderFactoryInput {
  readonly settings: ServerAISettings;
  readonly modelId?: string;
}

function requireModel(modelId: string | undefined, message: string): string {
  if (!modelId) throw new Error(message);
  return modelId;
}

export const serverAIProviderTransportRegistry = new ServerProviderTransportRegistry<
  ResolvedServerAIProviderFactoryInput,
  AIProvider,
  ProviderSecretName
>('AI', [
  {
    providerId: 'mock',
    create: () => new MockAIProvider(),
  },
  {
    providerId: 'openai',
    secretName: 'api_key',
    create: (input) =>
      new OpenAIAIProvider({
        apiKey: input.secrets?.apiKey ?? input.settings.openAI.apiKey,
        baseUrl: input.settings.openAI.baseUrl,
        organization: input.settings.openAI.organization,
        project: input.settings.openAI.project,
        modelId: requireModel(
          input.modelId,
          'AI_OPENAI_LABELING_MODEL_ID or AI_LABELING_MODEL_ID is required for openai provider',
        ),
        providerOptions: { ...input.settings.openAI.providerOptions, ...input.providerOptions },
      }),
  },
  {
    providerId: 'gemini-ai-studio',
    secretName: 'api_key',
    create: (input) =>
      new GeminiAIStudioProvider({
        apiKey: input.secrets?.apiKey ?? input.settings.geminiAIStudio.apiKey,
        modelId: requireModel(
          input.modelId,
          'AI_GEMINI_AI_STUDIO_LABELING_MODEL_ID or AI_LABELING_MODEL_ID is required for gemini-ai-studio provider',
        ),
        providerOptions: { ...input.settings.geminiAIStudio.providerOptions, ...input.providerOptions },
      }),
  },
  {
    providerId: 'gemini-vertex',
    secretName: 'credential_path',
    create: (input) =>
      new GeminiVertexAIProvider({
        project: input.settings.geminiVertex.project,
        location: input.settings.geminiVertex.location,
        modelId: requireModel(input.modelId, 'AI_LABELING_MODEL_ID is required for gemini-vertex provider'),
        credentialsPath: input.secrets?.credentialsPath ?? input.settings.geminiVertex.credentialsPath,
        providerOptions: { ...input.settings.geminiVertex.providerOptions, ...input.providerOptions },
      }),
  },
  {
    providerId: 'gemini-agent-platform',
    secretName: 'credential_path',
    create: (input) =>
      new GeminiAgentPlatformAIProvider({
        project: input.settings.geminiAgentPlatform.project,
        location: input.settings.geminiAgentPlatform.location,
        modelId: requireModel(
          input.modelId,
          'AI_GEMINI_AGENT_PLATFORM_LABELING_MODEL_ID or AI_LABELING_MODEL_ID is required for gemini-agent-platform provider',
        ),
        credentialsPath: input.secrets?.credentialsPath ?? input.settings.geminiAgentPlatform.credentialsPath,
        providerOptions: { ...input.settings.geminiAgentPlatform.providerOptions, ...input.providerOptions },
      }),
  },
  {
    providerId: 'anthropic',
    secretName: 'api_key',
    create: (input) =>
      new AnthropicAIProvider({
        apiKey: input.secrets?.apiKey ?? input.settings.anthropic.apiKey,
        baseUrl: input.settings.anthropic.baseUrl,
        anthropicVersion: input.settings.anthropic.anthropicVersion,
        modelId: requireModel(
          input.modelId,
          'AI_ANTHROPIC_LABELING_MODEL_ID or AI_LABELING_MODEL_ID is required for anthropic provider',
        ),
        providerOptions: { ...input.settings.anthropic.providerOptions, ...input.providerOptions },
      }),
  },
]);

export function createServerAIProvider(input: ServerAIProviderFactoryInput): AIProvider {
  const settings = input.settings ?? loadServerAISettings();
  if (!isServerAIProviderId(input.providerId)) throw new Error(`Unsupported AI provider: ${input.providerId}`);
  return serverAIProviderTransportRegistry.create(input.providerId, {
    ...input,
    settings,
    modelId: modelIdForProvider(settings, input.providerId, input.modelId ?? undefined),
  });
}
