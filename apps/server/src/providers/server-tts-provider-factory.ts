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
import type { ResolvedProviderSecrets } from './server-provider-secrets.js';

const serverTTSProviderSet = new Set<string>(serverTTSProviderIds);

export interface ServerTTSProviderFactoryInput {
  readonly providerId: string;
  readonly modelId?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly fetchImpl?: typeof fetch;
  readonly secrets?: ResolvedProviderSecrets;
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

export function createServerTTSSynthesisProvider(input: ServerTTSProviderFactoryInput): TTSSynthesisProvider {
  const env = input.env ?? process.env;
  if (!isServerTTSProviderId(input.providerId)) throw new Error(`Unsupported TTS provider: ${input.providerId}`);
  const providerId = input.providerId;
  if (!serverTTSProviderIsImplemented(providerId) || providerId === 'system') {
    throw new Error(`TTS provider is not available for server synthesis: ${providerId}`);
  }
  const modelId = modelIdForTTSProvider(providerId, input.modelId, env);
  if (providerId === 'openai-tts') {
    if (!modelId) throw new Error('TTS_OPENAI_MODEL_ID is required for openai-tts provider');
    return new OpenAITTSProvider({
      apiKey: input.secrets?.apiKey ?? env.OPENAI_API_KEY,
      baseUrl: env.TTS_OPENAI_BASE_URL || env.OPENAI_BASE_URL,
      organization: env.OPENAI_ORGANIZATION,
      project: env.OPENAI_PROJECT,
      modelId,
      defaultVoice: env.TTS_OPENAI_VOICE_ID,
      fetchImpl: input.fetchImpl,
    });
  }
  if (providerId === 'elevenlabs') {
    return new ElevenLabsTTSProvider({
      apiKey: input.secrets?.apiKey ?? env.ELEVENLABS_API_KEY,
      baseUrl: env.TTS_ELEVENLABS_BASE_URL,
      modelId: modelId ?? 'eleven_flash_v2_5',
      fetchImpl: input.fetchImpl,
    });
  }
  if (providerId === 'gemini-tts') {
    return new GeminiTTSProvider({
      apiKey: input.secrets?.apiKey ?? (env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
      baseUrl: env.TTS_GEMINI_BASE_URL,
      modelId: modelId ?? 'gemini-3.1-flash-tts-preview',
      fetchImpl: input.fetchImpl,
    });
  }
  if (providerId === 'gemini-vertex-tts') {
    const aiSettings = loadServerAISettings(env, input.cwd);
    return new GeminiVertexTTSProvider({
      project: env.GOOGLE_CLOUD_PROJECT?.trim() || aiSettings.geminiVertex.project,
      location: env.TTS_GEMINI_VERTEX_LOCATION?.trim() || env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
      credentialsPath: input.secrets?.credentialsPath ?? aiSettings.geminiVertex.credentialsPath,
      modelId: modelId ?? 'gemini-3.1-flash-tts-preview',
    });
  }
  if (providerId === 'google-cloud-tts') {
    const aiSettings = loadServerAISettings(env, input.cwd);
    return new GoogleCloudTTSProvider({
      project: env.GOOGLE_CLOUD_PROJECT?.trim() || aiSettings.geminiVertex.project,
      location: env.TTS_GOOGLE_CLOUD_LOCATION?.trim() || env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
      credentialsPath: input.secrets?.credentialsPath ?? aiSettings.geminiVertex.credentialsPath,
      accessToken:
        input.secrets?.accessToken ??
        (env.TTS_GOOGLE_CLOUD_ACCESS_TOKEN?.trim() || env.GOOGLE_CLOUD_ACCESS_TOKEN?.trim() || undefined),
      baseUrl: env.TTS_GOOGLE_CLOUD_BASE_URL,
      modelId: modelId ?? 'gemini-3.1-flash-tts-preview',
      fetchImpl: input.fetchImpl,
    });
  }
  if (providerId === 'local-endpoint') {
    return new LocalEndpointTTSProvider({
      endpointUrl: input.secrets?.endpointUrl ?? env.TTS_LOCAL_ENDPOINT_URL ?? '',
      modelId,
      allowedHosts: localTTSAllowedHosts(env),
      fetchImpl: input.fetchImpl,
    });
  }
  throw new Error(`Unsupported TTS provider: ${input.providerId}`);
}
