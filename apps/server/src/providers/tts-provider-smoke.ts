import { pathToFileURL } from 'node:url';
import type { VoiceProfile } from '@noveldesk/contracts';
import type { TTSSynthesisInput, TTSSynthesisProvider } from '../../../../src/providers/tts';
import {
  createServerTTSSynthesisProvider,
  isServerTTSProviderId,
  modelIdForTTSProvider,
} from './server-tts-provider-factory.js';
import { loadServerAISettings } from './server-ai-config.js';
import { hasSecretLikeKey } from './server-provider-settings.js';
import { classifyProviderError } from './provider-error-classification.js';
import {
  listServerProviderCatalog,
  serverTTSProviderIds,
  serverTTSProviderIsImplemented,
  type ServerTTSProviderId,
} from './server-provider-catalog.js';

type TTSOutputFormat = NonNullable<TTSSynthesisInput['format']>;

export interface TTSProviderSmokeInput {
  readonly providerId?: ServerTTSProviderId;
  readonly modelId?: string;
  readonly voiceId?: string;
  readonly format?: TTSOutputFormat;
  readonly text?: string;
  readonly speed?: number;
  readonly pitch?: number;
  readonly tone?: string;
  readonly emotion?: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly live?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface TTSProviderSmokeSummary {
  readonly providerId: ServerTTSProviderId;
  readonly modelId?: string;
  readonly live: boolean;
  readonly ready: {
    readonly enabled: boolean;
    readonly implemented: boolean;
    readonly secretConfigured: boolean;
    readonly modelConfigured: boolean;
    readonly voiceConfigured: boolean;
  };
  readonly sample: {
    readonly inputCharacters: number;
    readonly format: TTSOutputFormat;
    readonly speed: number;
    readonly pitch?: number;
    readonly tonePresent: boolean;
    readonly emotionPresent: boolean;
    readonly providerOptionKeys: string[];
  };
  readonly result?: {
    readonly audioBytes: number;
    readonly contentType: string;
    readonly durationMs?: number;
    readonly providerRequestIdPresent: boolean;
    readonly providerMetadataKeys: string[];
  };
}

interface ParsedArgs {
  providerId?: ServerTTSProviderId;
  modelId?: string;
  voiceId?: string;
  format?: TTSOutputFormat;
  text?: string;
  speed?: number;
  pitch?: number;
  tone?: string;
  emotion?: string;
  providerOptions?: Record<string, unknown>;
  live: boolean;
  json: boolean;
  project?: string;
  location?: string;
}

const defaultSmokeText = 'Hello. This is a short TTS provider smoke test.';
const supportedFormats = new Set<TTSOutputFormat>(['mp3', 'wav', 'pcm', 'ogg', 'opus', 'aac', 'flac']);

export async function runTTSProviderSmoke(input: TTSProviderSmokeInput = {}): Promise<TTSProviderSmokeSummary> {
  const env = { ...(input.env ?? process.env) };
  const cwd = input.cwd ?? process.cwd();
  const catalog = listServerProviderCatalog(env, loadServerAISettings(env, cwd));
  const providerId = input.providerId ?? defaultTTSProviderId(env, cwd);
  if (!isServerTTSProviderId(providerId)) throw new Error(`Unsupported TTS provider: ${providerId}`);
  const catalogItem = catalog.ttsProviders.find((provider) => provider.providerId === providerId);
  const modelId = modelIdForTTSProvider(providerId, input.modelId, env);
  const voiceId = voiceIdForProvider(providerId, input.voiceId, env);
  const text = input.text?.trim() || env.TTS_SMOKE_TEXT?.trim() || defaultSmokeText;
  const capability = catalogItem?.models.find((model) => model.modelId === modelId)?.capabilitySnapshot;
  const capabilityFormat = capability?.kind === 'tts' ? parseFormat(capability.formats[0]) : undefined;
  const format = input.format ?? parseFormat(env.TTS_SMOKE_FORMAT) ?? capabilityFormat ?? 'mp3';
  const speed = input.speed ?? numberOption(env.TTS_SMOKE_SPEED) ?? 1;
  const pitch = input.pitch ?? numberOption(env.TTS_SMOKE_PITCH);
  const tone = input.tone?.trim() || env.TTS_SMOKE_TONE?.trim() || 'clear narration';
  const emotion = input.emotion?.trim() || env.TTS_SMOKE_EMOTION?.trim() || 'neutral';
  const providerOptions = {
    ...recordFromJsonEnv(env.TTS_SMOKE_PROVIDER_OPTIONS_JSON),
    ...(input.providerOptions ?? {}),
  };
  assertNoSecretLikeSmokeOptions({ tone, emotion, providerOptions });
  const summary: TTSProviderSmokeSummary = {
    providerId,
    modelId,
    live: Boolean(input.live),
    ready: {
      enabled: Boolean(catalogItem?.enabled),
      implemented: providerId !== 'system' && serverTTSProviderIsImplemented(providerId),
      secretConfigured: Boolean(catalogItem?.secretConfigured),
      modelConfigured: !modelRequired(providerId) || Boolean(modelId),
      voiceConfigured: !voiceRequired(providerId) || Boolean(voiceId),
    },
    sample: {
      inputCharacters: text.length,
      format,
      speed,
      pitch,
      tonePresent: Boolean(tone),
      emotionPresent: Boolean(emotion),
      providerOptionKeys: Object.keys(providerOptions).sort(),
    },
  };
  if (!input.live) return summary;
  const missing = Object.entries(summary.ready)
    .filter(([, ready]) => !ready)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`TTS provider smoke is not ready: ${missing.join(', ')}`);
  }

  const provider = createServerTTSSynthesisProvider({
    providerId,
    modelId,
    env,
    cwd,
    fetchImpl: input.fetchImpl,
  });
  const result = await provider.synthesize({
    text,
    voiceProfile: buildSmokeVoiceProfile(provider, providerId, modelId, voiceId, {
      speed,
      pitch,
      tone,
      providerOptions,
    }),
    emotion,
    tone,
    speed,
    format,
    providerOptions,
  });

  return {
    ...summary,
    result: {
      audioBytes: result.audio.byteLength,
      contentType: result.contentType,
      durationMs: result.durationMs,
      providerRequestIdPresent: Boolean(result.providerRequestId),
      providerMetadataKeys: result.providerMetadata ? Object.keys(result.providerMetadata).sort() : [],
    },
  };
}

export function parseTTSProviderSmokeArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { live: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const [flag, inlineValue] = item.startsWith('--') ? item.split('=', 2) : [item, undefined];
    const value = inlineValue ?? argv[index + 1];
    if (flag === '--live') {
      args.live = true;
    } else if (flag === '--json') {
      args.json = true;
    } else if (flag === '--provider' && value) {
      if (!inlineValue) index += 1;
      if (!isServerTTSProviderId(value)) throw new Error(`Unsupported TTS provider: ${value}`);
      args.providerId = value;
    } else if (flag === '--model' && value) {
      if (!inlineValue) index += 1;
      args.modelId = value;
    } else if (flag === '--voice' && value) {
      if (!inlineValue) index += 1;
      args.voiceId = value;
    } else if (flag === '--format' && value) {
      if (!inlineValue) index += 1;
      args.format = parseFormat(value);
      if (!args.format) throw new Error(`Unsupported TTS smoke format: ${value}`);
    } else if (flag === '--text' && value) {
      if (!inlineValue) index += 1;
      args.text = value;
    } else if (flag === '--speed' && value) {
      if (!inlineValue) index += 1;
      args.speed = parseNumberArg(value, 'speed');
    } else if (flag === '--pitch' && value) {
      if (!inlineValue) index += 1;
      args.pitch = parseNumberArg(value, 'pitch');
    } else if (flag === '--tone' && value) {
      if (!inlineValue) index += 1;
      args.tone = value;
    } else if (flag === '--emotion' && value) {
      if (!inlineValue) index += 1;
      args.emotion = value;
    } else if ((flag === '--option' || flag === '--provider-option') && value) {
      if (!inlineValue) index += 1;
      args.providerOptions = {
        ...(args.providerOptions ?? {}),
        ...parseProviderOptionArg(value),
      };
    } else if (flag === '--project' && value) {
      if (!inlineValue) index += 1;
      args.project = value;
    } else if (flag === '--location' && value) {
      if (!inlineValue) index += 1;
      args.location = value;
    } else if (flag === '--help' || flag === '-h') {
      throw new Error(helpText());
    }
  }
  return args;
}

function defaultTTSProviderId(env: NodeJS.ProcessEnv, cwd: string): ServerTTSProviderId {
  const catalog = listServerProviderCatalog(env, loadServerAISettings(env, cwd));
  const enabledProvider = catalog.ttsProviders.find((provider) => provider.providerId !== 'system' && provider.enabled);
  if (enabledProvider && isServerTTSProviderId(enabledProvider.providerId)) return enabledProvider.providerId;
  return 'local-endpoint';
}

function modelRequired(providerId: ServerTTSProviderId): boolean {
  return providerId === 'openai-tts';
}

function voiceRequired(providerId: ServerTTSProviderId): boolean {
  return providerId === 'elevenlabs';
}

function voiceIdForProvider(
  providerId: ServerTTSProviderId,
  requestedVoiceId: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const requested = requestedVoiceId?.trim() || env.TTS_SMOKE_VOICE_ID?.trim();
  if (requested) return requested;
  if (providerId === 'openai-tts') return env.TTS_OPENAI_VOICE_ID?.trim() || 'alloy';
  if (providerId === 'elevenlabs')
    return env.TTS_ELEVENLABS_VOICE_ID?.trim() || env.ELEVENLABS_VOICE_ID?.trim() || undefined;
  if (providerId === 'gemini-tts') return env.TTS_GEMINI_VOICE_ID?.trim() || 'Kore';
  if (providerId === 'gemini-vertex-tts') {
    return env.TTS_GEMINI_VERTEX_VOICE_ID?.trim() || env.GOOGLE_CLOUD_TTS_VOICE_ID?.trim() || 'Kore';
  }
  if (providerId === 'google-cloud-tts') {
    return env.TTS_GOOGLE_CLOUD_VOICE_ID?.trim() || env.GOOGLE_CLOUD_TTS_VOICE_ID?.trim() || 'Kore';
  }
  if (providerId === 'local-endpoint') return env.TTS_LOCAL_ENDPOINT_VOICE_ID?.trim() || 'local-smoke';
  return undefined;
}

function buildSmokeVoiceProfile(
  provider: TTSSynthesisProvider,
  providerId: ServerTTSProviderId,
  modelId: string | undefined,
  voiceId: string | undefined,
  options: {
    readonly speed: number;
    readonly pitch?: number;
    readonly tone?: string;
    readonly providerOptions?: Record<string, unknown>;
  },
): VoiceProfile {
  const now = new Date(0).toISOString();
  return {
    id: 'tts_smoke_voice',
    novelId: 'tts_smoke_book',
    role: 'narrator',
    providerId,
    providerVoiceId: voiceId ?? 'smoke',
    providerModel: modelId,
    label: `${provider.displayName} Smoke Voice`,
    language: 'ko-KR',
    tone: options.tone,
    speed: options.speed,
    pitch: options.pitch ?? 0,
    providerOptions: options.providerOptions,
    isUserSelected: true,
    createdAt: now,
    updatedAt: now,
  };
}

function parseFormat(value: string | undefined): TTSOutputFormat | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && supportedFormats.has(normalized as TTSOutputFormat)
    ? (normalized as TTSOutputFormat)
    : undefined;
}

function numberOption(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNumberArg(value: string, label: string): number {
  const parsed = numberOption(value);
  if (parsed === undefined) throw new Error(`Invalid TTS smoke ${label}: ${value}`);
  return parsed;
}

function parseProviderOptionArg(value: string): Record<string, unknown> {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex <= 0) throw new Error('TTS smoke provider option must use key=value syntax');
  const key = value.slice(0, separatorIndex).trim();
  const rawValue = value.slice(separatorIndex + 1).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error('TTS smoke provider option key contains unsupported characters');
  const parsedValue = parseProviderOptionValue(rawValue);
  const option = { [key]: parsedValue };
  if (hasSecretLikeKey(option))
    throw new Error('TTS smoke provider options must not contain secret-like keys or values');
  return option;
}

function parseProviderOptionValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value && Number.isFinite(Number(value))) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']'))
  ) {
    return JSON.parse(value) as unknown;
  }
  return value;
}

function recordFromJsonEnv(value: string | undefined): Record<string, unknown> {
  if (!value?.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TTS_SMOKE_PROVIDER_OPTIONS_JSON must be an object');
  }
  if (hasSecretLikeKey(parsed))
    throw new Error('TTS smoke provider options must not contain secret-like keys or values');
  return parsed as Record<string, unknown>;
}

function assertNoSecretLikeSmokeOptions(input: {
  readonly tone?: string;
  readonly emotion?: string;
  readonly providerOptions?: Record<string, unknown>;
}): void {
  if (hasSecretLikeKey(input.tone) || hasSecretLikeKey(input.emotion) || hasSecretLikeKey(input.providerOptions)) {
    throw new Error('TTS smoke options must not contain secret-like keys or values');
  }
}

function applyCliEnv(args: ParsedArgs): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (args.project) env.GOOGLE_CLOUD_PROJECT = args.project;
  if (args.location) {
    env.GOOGLE_CLOUD_LOCATION = args.location;
    env.TTS_GEMINI_VERTEX_LOCATION = args.location;
    env.TTS_GOOGLE_CLOUD_LOCATION = args.location;
  }
  return env;
}

function helpText(): string {
  return [
    'Usage: pnpm --filter server tts:smoke -- [--provider local-endpoint] [--model model-id] [--voice voice-id] [--format mp3] [--speed 1] [--pitch 0] [--tone calm] [--emotion neutral] [--option key=value] [--live] [--json]',
    '',
    'Dry-run is the default and does not call external TTS providers.',
    'Live mode requires server env/provider credentials to be configured and makes one short synthesis request.',
    `Supported providers: ${serverTTSProviderIds.join(', ')}`,
  ].join('\n');
}

export function formatTTSProviderSmokeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Usage:')) return message;
  const classification = classifyProviderError(error);
  if (message.startsWith('TTS provider smoke is not ready:')) {
    return `TTS provider smoke is not ready (${classification.category}): ${message.replace('TTS provider smoke is not ready: ', '')}`;
  }
  if (
    [
      'OPENAI_API_KEY is required for openai-tts provider',
      'TTS_OPENAI_MODEL_ID is required for openai-tts provider',
      'ELEVENLABS_API_KEY is required for elevenlabs provider',
      'ElevenLabs voice id is required',
      'GEMINI_API_KEY or GOOGLE_API_KEY is required for gemini-tts provider',
      'GOOGLE_CLOUD_PROJECT is required for gemini-vertex-tts provider',
      'Gemini Vertex TTS model id is required',
      'GOOGLE_APPLICATION_CREDENTIALS or VERTEX_CREDENTIALS_DIR is required for google-cloud-tts provider',
      'Google Cloud service account credentials are missing client_email or private_key',
      'TTS_LOCAL_ENDPOINT_URL is required for local-endpoint provider',
      'TTS_SMOKE_PROVIDER_OPTIONS_JSON must be an object',
      'TTS smoke provider options must not contain secret-like keys or values',
      'TTS smoke options must not contain secret-like keys or values',
    ].includes(message) ||
    message.startsWith('Invalid TTS smoke ') ||
    message.startsWith('TTS smoke provider option ')
  ) {
    return `TTS provider smoke failed (${classification.category}). ${message}`;
  }
  if (message.startsWith('Unsupported TTS provider:')) {
    return `TTS provider smoke failed (${classification.category}). Unsupported TTS provider.`;
  }
  if (message.startsWith('Unsupported TTS smoke format:')) {
    return `TTS provider smoke failed (${classification.category}). Unsupported TTS smoke format.`;
  }
  if (message.startsWith('TTS provider is not available for server synthesis:')) {
    return `TTS provider smoke failed (${classification.category}). TTS provider is not available for server synthesis.`;
  }
  return `TTS provider smoke failed (${classification.category}). ${classification.safeMessage}`;
}

async function main(): Promise<void> {
  const args = parseTTSProviderSmokeArgs(process.argv.slice(2));
  const summary = await runTTSProviderSmoke({
    providerId: args.providerId,
    modelId: args.modelId,
    voiceId: args.voiceId,
    format: args.format,
    text: args.text,
    speed: args.speed,
    pitch: args.pitch,
    tone: args.tone,
    emotion: args.emotion,
    providerOptions: args.providerOptions,
    live: args.live,
    env: applyCliEnv(args),
  });
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`provider=${summary.providerId}`);
    console.log(`model=${summary.modelId ?? '(not configured)'}`);
    console.log(`live=${summary.live ? 'yes' : 'no'}`);
    console.log(`ready=${JSON.stringify(summary.ready)}`);
    console.log(
      `sample=${summary.sample.inputCharacters} chars, format=${summary.sample.format}, speed=${summary.sample.speed}`,
    );
    console.log(`providerOptionKeys=${summary.sample.providerOptionKeys.join(',') || '(none)'}`);
    if (summary.result) {
      console.log(`result=${summary.result.audioBytes} bytes, contentType=${summary.result.contentType}`);
      console.log(`providerRequestId=${summary.result.providerRequestIdPresent ? 'yes' : 'no'}`);
      console.log(`metadataKeys=${summary.result.providerMetadataKeys.join(',') || '(none)'}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(formatTTSProviderSmokeError(error));
    process.exitCode = 1;
  });
}
