import type { TTSSynthesisInput, TTSSynthesisProvider, TTSSynthesisResult } from '../../../../src/providers/tts';

export interface ElevenLabsTTSProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly fetchImpl?: typeof fetch;
}

export class ElevenLabsTTSProvider implements TTSSynthesisProvider {
  readonly providerId = 'elevenlabs';
  readonly displayName = 'ElevenLabs';
  readonly supportsStreaming = true;
  readonly supportsAudioCache = true;
  readonly supportsPerCharacterVoice = true;

  constructor(private readonly options: ElevenLabsTTSProviderOptions) {}

  async synthesize(input: TTSSynthesisInput): Promise<TTSSynthesisResult> {
    const apiKey = this.options.apiKey?.trim();
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is required for elevenlabs provider');
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const providerOptions = mergeOptions(this.options.providerOptions, input.voiceProfile.providerOptions, input.providerOptions);
    const voiceId = stringOption(providerOptions, 'voice') ?? input.voiceProfile.providerVoiceId;
    if (!voiceId?.trim()) throw new Error('ElevenLabs voice id is required');
    const outputFormat = stringOption(providerOptions, 'outputFormat') ?? outputFormatForInput(input.format);
    const url = new URL(`${this.options.baseUrl?.replace(/\/+$/, '') || 'https://api.elevenlabs.io'}/v1/text-to-speech/${encodeURIComponent(voiceId.trim())}`);
    url.searchParams.set('output_format', outputFormat);
    const enableLogging = booleanOption(providerOptions, 'enableLogging');
    if (enableLogging !== undefined) url.searchParams.set('enable_logging', String(enableLogging));

    const body: Record<string, unknown> = {
      text: input.text,
      model_id: this.options.modelId || 'eleven_flash_v2_5',
    };
    const voiceSettings = voiceSettingsFromOptions(providerOptions, input);
    if (Object.keys(voiceSettings).length) body.voice_settings = voiceSettings;
    const previousText = stringOption(providerOptions, 'previousText');
    const nextText = stringOption(providerOptions, 'nextText');
    if (previousText) body.previous_text = previousText;
    if (nextText) body.next_text = nextText;

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: contentTypeForOutputFormat(outputFormat),
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`ElevenLabs TTS request failed with ${response.status}: ${errorText.slice(0, 500)}`);
    }

    return {
      audio: await response.arrayBuffer(),
      contentType: response.headers.get('content-type') ?? contentTypeForOutputFormat(outputFormat),
      providerRequestId: response.headers.get('request-id') ?? response.headers.get('x-request-id') ?? undefined,
      providerMetadata: { outputFormat },
    };
  }
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

function booleanOption(options: Record<string, unknown>, key: string): boolean | undefined {
  const value = options[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function outputFormatForInput(format: TTSSynthesisInput['format']): string {
  if (format === 'pcm') return 'pcm_24000';
  if (format === 'wav') return 'pcm_24000';
  if (format === 'opus' || format === 'ogg') return 'opus_48000_64';
  return 'mp3_44100_128';
}

function contentTypeForOutputFormat(outputFormat: string): string {
  if (outputFormat.startsWith('pcm_')) return 'audio/pcm';
  if (outputFormat.startsWith('opus_')) return 'audio/ogg';
  return 'audio/mpeg';
}

function voiceSettingsFromOptions(
  options: Record<string, unknown>,
  input: TTSSynthesisInput,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  const stability = numberOption(options, 'stability');
  const similarityBoost = numberOption(options, 'similarityBoost') ?? numberOption(options, 'similarity_boost');
  const style = numberOption(options, 'style');
  const speed = numberOption(options, 'speed') ?? input.speed ?? input.voiceProfile.speed;
  const useSpeakerBoost = booleanOption(options, 'useSpeakerBoost') ?? booleanOption(options, 'use_speaker_boost');
  if (stability !== undefined) settings.stability = clamp(stability, 0, 1);
  if (similarityBoost !== undefined) settings.similarity_boost = clamp(similarityBoost, 0, 1);
  if (style !== undefined) settings.style = clamp(style, 0, 1);
  if (speed !== undefined) settings.speed = clamp(speed, 0.7, 1.2);
  if (useSpeakerBoost !== undefined) settings.use_speaker_boost = useSpeakerBoost;
  return settings;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
