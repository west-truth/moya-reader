import type { TTSSynthesisProvider } from '../../../../src/providers/tts';
import { ElevenLabsTTSProvider } from './elevenlabs-tts-provider.js';
import { GeminiTTSProvider } from './gemini-tts-provider.js';
import { GeminiVertexTTSProvider } from './gemini-vertex-tts-provider.js';
import { GoogleCloudTTSProvider } from './google-cloud-tts-provider.js';
import { LocalEndpointTTSProvider } from './local-endpoint-tts-provider.js';
import { OpenAITTSProvider } from './openai-tts-provider.js';
import { loadServerAISettings } from './server-ai-config.js';
import {
  serverTTSProviderIds,
  serverTTSProviderIsImplemented,
  type ServerTTSProviderId,
} from './server-provider-catalog.js';
import type { ProviderSecretName, ResolvedProviderSecrets } from './server-provider-secrets.js';
import { ServerProviderTransportRegistry } from './server-provider-transport-registry.js';

const serverTTSProviderSet = new Set<string>(serverTTSProviderIds);

export interface ServerTTSProviderFactoryInput {
  readonly providerId: string;
  readonly modelId?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly fetchImpl?: typeof fetch;
  readonly secrets?: ResolvedProviderSecrets;
}

interface ResolvedServerTTSProviderFactoryInput extends ServerTTSProviderFactoryInput {
  readonly providerId: ServerTTSProviderId;
  readonly env: NodeJS.ProcessEnv;
  readonly modelId?: string;
}

export function isServerTTSProviderId(value: string): value is ServerTTSProviderId {
  return serverTTSProviderSet.has(value);
}

export function modelIdForTTSProvider(
  providerId: ServerTTSProviderId,
  requestedModelId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (requestedModelId?.trim()) return requestedModelId.trim();
  if (providerId === 'openai-tts') return env.TTS_OPENAI_MODEL_ID?.trim() || undefined;
  if (providerId === 'elevenlabs') return env.TTS_ELEVENLABS_MODEL_ID?.trim() || 'eleven_flash_v2_5';
  if (providerId === 'gemini-tts') return env.TTS_GEMINI_MODEL_ID?.trim() || 'gemini-3.1-flash-tts-preview';
  if (providerId === 'gemini-vertex-tts')
    return env.TTS_GEMINI_VERTEX_MODEL_ID?.trim() || 'gemini-3.1-flash-tts-preview';
  if (providerId === 'google-cloud-tts') return env.TTS_GOOGLE_CLOUD_MODEL_ID?.trim() || 'gemini-3.1-flash-tts-preview';
  if (providerId === 'local-endpoint') return env.TTS_LOCAL_ENDPOINT_MODEL_ID?.trim() || undefined;
  return undefined;
}

export function localTTSAllowedHosts(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const configured = env.LOCAL_TTS_ALLOWED_HOSTS ?? env.TTS_LOCAL_ENDPOINT_ALLOWED_HOSTS ?? '';
  return configured
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

export const serverTTSProviderTransportRegistry = new ServerProviderTransportRegistry<
  ResolvedServerTTSProviderFactoryInput,
  TTSSynthesisProvider,
  ProviderSecretName
>('TTS', [
  {
    providerId: 'openai-tts',
    secretName: 'api_key',
    create: (input) => {
      if (!input.modelId) throw new Error('TTS_OPENAI_MODEL_ID is required for openai-tts provider');
      return new OpenAITTSProvider({
        apiKey: input.secrets?.apiKey ?? input.env.OPENAI_API_KEY,
        baseUrl: input.env.TTS_OPENAI_BASE_URL || input.env.OPENAI_BASE_URL,
        organization: input.env.OPENAI_ORGANIZATION,
        project: input.env.OPENAI_PROJECT,
        modelId: input.modelId,
        defaultVoice: input.env.TTS_OPENAI_VOICE_ID,
        fetchImpl: input.fetchImpl,
      });
    },
  },
  {
    providerId: 'elevenlabs',
    secretName: 'api_key',
    create: (input) =>
      new ElevenLabsTTSProvider({
        apiKey: input.secrets?.apiKey ?? input.env.ELEVENLABS_API_KEY,
        baseUrl: input.env.TTS_ELEVENLABS_BASE_URL,
        modelId: input.modelId ?? 'eleven_flash_v2_5',
        fetchImpl: input.fetchImpl,
      }),
  },
  {
    providerId: 'gemini-tts',
    secretName: 'api_key',
    create: (input) =>
      new GeminiTTSProvider({
        apiKey: input.secrets?.apiKey ?? (input.env.GEMINI_API_KEY || input.env.GOOGLE_API_KEY),
        baseUrl: input.env.TTS_GEMINI_BASE_URL,
        modelId: input.modelId ?? 'gemini-3.1-flash-tts-preview',
        fetchImpl: input.fetchImpl,
      }),
  },
  {
    providerId: 'gemini-vertex-tts',
    secretName: 'credential_path',
    create: (input) => {
      const aiSettings = loadServerAISettings(input.env, input.cwd);
      return new GeminiVertexTTSProvider({
        project: input.env.GOOGLE_CLOUD_PROJECT?.trim() || aiSettings.geminiVertex.project,
        location: input.env.TTS_GEMINI_VERTEX_LOCATION?.trim() || input.env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
        credentialsPath: input.secrets?.credentialsPath ?? aiSettings.geminiVertex.credentialsPath,
        modelId: input.modelId ?? 'gemini-3.1-flash-tts-preview',
      });
    },
  },
  {
    providerId: 'google-cloud-tts',
    secretName: 'access_token',
    create: (input) => {
      const aiSettings = loadServerAISettings(input.env, input.cwd);
      return new GoogleCloudTTSProvider({
        project: input.env.GOOGLE_CLOUD_PROJECT?.trim() || aiSettings.geminiVertex.project,
        location: input.env.TTS_GOOGLE_CLOUD_LOCATION?.trim() || input.env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
        credentialsPath: input.secrets?.credentialsPath ?? aiSettings.geminiVertex.credentialsPath,
        accessToken:
          input.secrets?.accessToken ??
          (input.env.TTS_GOOGLE_CLOUD_ACCESS_TOKEN?.trim() || input.env.GOOGLE_CLOUD_ACCESS_TOKEN?.trim() || undefined),
        baseUrl: input.env.TTS_GOOGLE_CLOUD_BASE_URL,
        modelId: input.modelId ?? 'gemini-3.1-flash-tts-preview',
        fetchImpl: input.fetchImpl,
      });
    },
  },
  {
    providerId: 'local-endpoint',
    secretName: 'endpoint_url',
    create: (input) =>
      new LocalEndpointTTSProvider({
        endpointUrl: input.secrets?.endpointUrl ?? input.env.TTS_LOCAL_ENDPOINT_URL ?? '',
        modelId: input.modelId,
        allowedHosts: localTTSAllowedHosts(input.env),
        fetchImpl: input.fetchImpl,
      }),
  },
]);

export function createServerTTSSynthesisProvider(input: ServerTTSProviderFactoryInput): TTSSynthesisProvider {
  const env = input.env ?? process.env;
  if (!isServerTTSProviderId(input.providerId)) throw new Error(`Unsupported TTS provider: ${input.providerId}`);
  const providerId = input.providerId;
  if (!serverTTSProviderIsImplemented(providerId) || providerId === 'system') {
    throw new Error(`TTS provider is not available for server synthesis: ${providerId}`);
  }
  return serverTTSProviderTransportRegistry.create(providerId, {
    ...input,
    providerId,
    env,
    modelId: modelIdForTTSProvider(providerId, input.modelId, env),
  });
}
