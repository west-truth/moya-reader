import type {
  TTSSynthesisInput,
  TTSSynthesisProvider,
  TTSSynthesisResult,
  TTSVoice,
} from '../../../../src/providers/tts';
import { requestLocalEndpoint, type LocalEndpointEgressOptions } from './local-endpoint-egress-policy.js';

export type { LocalEndpointAddress } from './local-endpoint-egress-policy.js';

export interface LocalEndpointTTSProviderOptions extends LocalEndpointEgressOptions {
  readonly endpointUrl: string;
  readonly modelId?: string;
  readonly providerOptions?: Record<string, unknown>;
}

export class LocalEndpointTTSProvider implements TTSSynthesisProvider {
  readonly providerId = 'local-endpoint';
  readonly displayName = 'Local TTS Endpoint';
  readonly supportsStreaming = false;
  readonly supportsAudioCache = true;
  readonly supportsPerCharacterVoice = true;

  constructor(private readonly options: LocalEndpointTTSProviderOptions) {}

  async listVoices(): Promise<TTSVoice[]> {
    const endpointUrl = this.options.endpointUrl.trim();
    if (!endpointUrl) throw new Error('TTS_LOCAL_ENDPOINT_URL is required for local-endpoint provider');
    const response = await requestLocalEndpoint(localEndpointVoicesUrl(endpointUrl), { method: 'GET' }, this.options);
    if (!response.ok) {
      throw new Error(`Local TTS voices request failed with status ${response.status}`);
    }
    const json = await response.json().catch(() => undefined);
    return parseLocalEndpointVoices(json);
  }

  async synthesize(input: TTSSynthesisInput): Promise<TTSSynthesisResult> {
    const endpointUrl = this.options.endpointUrl.trim();
    if (!endpointUrl) throw new Error('TTS_LOCAL_ENDPOINT_URL is required for local-endpoint provider');
    const providerOptions = Object.assign(
      {},
      this.options.providerOptions,
      input.voiceProfile.providerOptions,
      input.providerOptions,
    );
    const response = await requestLocalEndpoint(
      endpointUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: this.options.modelId,
          text: input.text,
          voiceProfile: input.voiceProfile,
          voiceId: input.voiceProfile.providerVoiceId,
          emotion: input.emotion,
          tone: input.tone,
          speed: input.speed ?? input.voiceProfile.speed,
          format: input.format ?? 'mp3',
          providerOptions,
        }),
        signal: input.signal,
      },
      this.options,
    );
    if (!response.ok) {
      throw new Error(`Local TTS endpoint request failed with status ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.startsWith('audio/') || contentType === 'application/octet-stream') {
      return {
        audio: await response.arrayBuffer(),
        contentType: contentType || 'application/octet-stream',
      };
    }

    const json = await response.json().catch(() => undefined);
    return parseLocalEndpointJson(json, endpointSecretValues(new URL(endpointUrl)));
  }
}

function localEndpointVoicesUrl(endpointUrl: string): string {
  const url = new URL(endpointUrl);
  url.pathname = url.pathname.replace(/\/[^/]*$/, '/voices');
  url.search = '';
  return url.toString();
}

function parseLocalEndpointVoices(value: unknown): TTSVoice[] {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const voices = Array.isArray(value) ? value : Array.isArray(body?.voices) ? body.voices : [];
  return voices
    .map((voice): TTSVoice | undefined => {
      const row = voice && typeof voice === 'object' ? (voice as Record<string, unknown>) : undefined;
      const id =
        typeof row?.id === 'string' && row.id.trim()
          ? row.id.trim()
          : typeof row?.voiceId === 'string' && row.voiceId.trim()
            ? row.voiceId.trim()
            : undefined;
      if (!id) return undefined;
      const label =
        typeof row?.label === 'string' && row.label.trim()
          ? row.label.trim()
          : typeof row?.name === 'string' && row.name.trim()
            ? row.name.trim()
            : id;
      const lang =
        typeof row?.lang === 'string' && row.lang.trim()
          ? row.lang.trim()
          : typeof row?.language === 'string' && row.language.trim()
            ? row.language.trim()
            : 'und';
      return { id, label, lang };
    })
    .filter((voice): voice is TTSVoice => Boolean(voice));
}

function parseLocalEndpointJson(value: unknown, secretValues: readonly string[]): TTSSynthesisResult {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const audioBase64 =
    typeof body?.audioBase64 === 'string' ? body.audioBase64 : typeof body?.audio === 'string' ? body.audio : undefined;
  if (!audioBase64) throw new Error('Local TTS endpoint returned no audioBase64 payload');
  const buffer = Buffer.from(audioBase64, 'base64');
  return {
    audio: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    contentType: typeof body?.contentType === 'string' ? body.contentType : 'audio/mpeg',
    durationMs: typeof body?.durationMs === 'number' ? body.durationMs : undefined,
    providerRequestId:
      typeof body?.requestId === 'string' && !containsSecretValue(body.requestId, secretValues)
        ? body.requestId
        : undefined,
    providerMetadata: sanitizeProviderMetadata(body?.metadata, secretValues),
  };
}

function endpointSecretValues(url: URL): readonly string[] {
  return [...url.searchParams.entries()]
    .filter(([key, value]) => value && isSecretMetadataKey(key))
    .map(([, value]) => value);
}

function sanitizeProviderMetadata(
  value: unknown,
  secretValues: readonly string[],
): Record<string, unknown> | undefined {
  const sanitized = sanitizeMetadataValue(value, 0, secretValues);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : undefined;
}

function sanitizeMetadataValue(value: unknown, depth: number, secretValues: readonly string[]): unknown {
  if (depth > 8) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string' && containsSecretValue(value, secretValues)) return '[redacted]';
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeMetadataValue(item, depth + 1, secretValues))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretMetadataKey(key)) continue;
    const sanitizedItem = sanitizeMetadataValue(item, depth + 1, secretValues);
    if (sanitizedItem !== undefined) sanitized[key] = sanitizedItem;
  }
  return sanitized;
}

function containsSecretValue(value: string, secretValues: readonly string[]): boolean {
  return secretValues.some((secret) => secret.length > 0 && value.includes(secret));
}

function isSecretMetadataKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized.includes('authorization') ||
    normalized.includes('credential') ||
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.endsWith('apikey') ||
    normalized.includes('endpointurl') ||
    normalized.includes('cookie')
  );
}
