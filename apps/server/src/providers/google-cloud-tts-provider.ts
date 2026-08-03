import crypto from 'node:crypto';
import fs from 'node:fs';
import type { TTSSynthesisInput, TTSSynthesisProvider, TTSSynthesisResult } from '../../../../src/providers/tts';

export interface GoogleCloudTTSProviderOptions {
  readonly project?: string;
  readonly location?: string;
  readonly credentialsPath?: string;
  readonly accessToken?: string;
  readonly baseUrl?: string;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly fetchImpl?: typeof fetch;
}

interface ServiceAccountCredentials {
  readonly client_email?: string;
  readonly private_key?: string;
  readonly token_uri?: string;
  readonly project_id?: string;
}

export class GoogleCloudTTSProvider implements TTSSynthesisProvider {
  readonly providerId = 'google-cloud-tts';
  readonly displayName = 'Google Cloud TTS';
  readonly supportsStreaming = true;
  readonly supportsAudioCache = true;
  readonly supportsPerCharacterVoice = true;

  constructor(private readonly options: GoogleCloudTTSProviderOptions) {}

  async synthesize(input: TTSSynthesisInput): Promise<TTSSynthesisResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const accessToken = await resolveAccessToken(this.options, fetchImpl, input.signal);
    const providerOptions = mergeOptions(this.options.providerOptions, input.voiceProfile.providerOptions, input.providerOptions);
    const audioEncoding = googleAudioEncoding(input.format, stringOption(providerOptions, 'audioEncoding'));
    const voiceName = stringOption(providerOptions, 'voice') ?? input.voiceProfile.providerVoiceId ?? 'Kore';
    const languageCode = stringOption(providerOptions, 'languageCode') ?? input.voiceProfile.language ?? 'ko-KR';
    const body: Record<string, unknown> = {
      input: {
        text: input.text,
        prompt: stringOption(providerOptions, 'prompt') ?? stringOption(providerOptions, 'instructions') ?? speechPrompt(input),
      },
      voice: {
        languageCode,
        name: voiceName,
        model_name: this.options.modelId || 'gemini-3.1-flash-tts-preview',
      },
      audioConfig: {
        audioEncoding,
      },
    };
    const speed = numberOption(providerOptions, 'speakingRate') ?? numberOption(providerOptions, 'speed') ?? input.speed;
    const pitch = numberOption(providerOptions, 'pitch') ?? input.voiceProfile.pitch;
    const sampleRateHertz = integerOption(providerOptions, 'sampleRateHertz');
    const audioConfig = body.audioConfig as Record<string, unknown>;
    if (speed !== undefined) audioConfig.speakingRate = clamp(speed, 0.25, 4);
    if (pitch !== undefined) audioConfig.pitch = clamp(pitch, -20, 20);
    if (sampleRateHertz !== undefined) audioConfig.sampleRateHertz = sampleRateHertz;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    const project = this.options.project?.trim();
    if (project) headers['x-goog-user-project'] = project;

    const response = await fetchImpl(synthesizeUrl(this.options), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: input.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Google Cloud TTS request failed with ${response.status}: ${errorText.slice(0, 500)}`);
    }
    const json = await response.json().catch(() => undefined);
    const audioContent = json && typeof json === 'object' ? (json as Record<string, unknown>).audioContent : undefined;
    if (typeof audioContent !== 'string' || !audioContent.trim()) throw new Error('Google Cloud TTS returned no audioContent payload');
    const audio = Buffer.from(audioContent, 'base64');
    return {
      audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer,
      contentType: contentTypeForGoogleEncoding(audioEncoding),
      providerRequestId: response.headers.get('x-request-id') ?? undefined,
      providerMetadata: {
        audioEncoding,
        languageCode,
        voice: voiceName,
      },
    };
  }
}

async function resolveAccessToken(options: GoogleCloudTTSProviderOptions, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  if (options.accessToken?.trim()) return options.accessToken.trim();
  const credentialsPath = options.credentialsPath?.trim();
  if (!credentialsPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS or VERTEX_CREDENTIALS_DIR is required for google-cloud-tts provider');
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as ServiceAccountCredentials;
  const tokenUri = credentials.token_uri?.trim() || 'https://oauth2.googleapis.com/token';
  const clientEmail = credentials.client_email?.trim();
  const privateKey = credentials.private_key;
  if (!clientEmail || !privateKey) throw new Error('Google Cloud service account credentials are missing client_email or private_key');
  const now = Math.floor(Date.now() / 1000);
  const assertion = [
    base64UrlJson({ alg: 'RS256', typ: 'JWT' }),
    base64UrlJson({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: tokenUri,
      exp: now + 3600,
      iat: now,
    }),
  ].join('.');
  const signature = crypto.createSign('RSA-SHA256').update(assertion).sign(privateKey);
  const response = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${assertion}.${base64Url(signature)}`,
    }),
    signal,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Google Cloud access token request failed with ${response.status}: ${errorText.slice(0, 500)}`);
  }
  const json = await response.json().catch(() => undefined);
  const accessToken = json && typeof json === 'object' ? (json as Record<string, unknown>).access_token : undefined;
  if (typeof accessToken !== 'string' || !accessToken.trim()) throw new Error('Google Cloud access token response did not include access_token');
  return accessToken.trim();
}

function synthesizeUrl(options: GoogleCloudTTSProviderOptions): string {
  if (options.baseUrl?.trim()) return `${options.baseUrl.replace(/\/+$/, '')}/v1/text:synthesize`;
  const location = options.location?.trim();
  if (location && location !== 'global') return `https://${location}-texttospeech.googleapis.com/v1/text:synthesize`;
  return 'https://texttospeech.googleapis.com/v1/text:synthesize';
}

function mergeOptions(...values: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  return Object.assign({}, ...values.filter(Boolean));
}

function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integerOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function googleAudioEncoding(inputFormat: TTSSynthesisInput['format'], optionFormat?: string): string {
  const requested = optionFormat?.toUpperCase() ?? inputFormat?.toUpperCase();
  if (requested === 'LINEAR16' || requested === 'WAV') return 'LINEAR16';
  if (requested === 'PCM') return 'PCM';
  if (requested === 'OGG_OPUS' || requested === 'OGG' || requested === 'OPUS') return 'OGG_OPUS';
  if (requested === 'MULAW') return 'MULAW';
  if (requested === 'ALAW') return 'ALAW';
  return 'MP3';
}

function contentTypeForGoogleEncoding(audioEncoding: string): string {
  if (audioEncoding === 'LINEAR16') return 'audio/wav';
  if (audioEncoding === 'PCM') return 'audio/pcm';
  if (audioEncoding === 'OGG_OPUS') return 'audio/ogg';
  if (audioEncoding === 'MULAW') return 'audio/basic';
  if (audioEncoding === 'ALAW') return 'audio/basic';
  return 'audio/mpeg';
}

function speechPrompt(input: TTSSynthesisInput): string {
  const parts = [input.tone, input.emotion && input.emotion !== 'neutral' ? input.emotion : undefined]
    .filter((part): part is string => Boolean(part && part.trim()));
  return parts.length ? `Read the text exactly with this delivery: ${parts.join(', ')}.` : 'Read the text exactly.';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value: Buffer): string {
  return value.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
