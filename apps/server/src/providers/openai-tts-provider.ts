import type { TTSSynthesisInput, TTSSynthesisProvider, TTSSynthesisResult } from '../../../../src/providers/tts';

type OpenAITTSFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

export interface OpenAITTSProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly organization?: string;
  readonly project?: string;
  readonly modelId: string;
  readonly defaultVoice?: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly fetchImpl?: typeof fetch;
}

export class OpenAITTSProvider implements TTSSynthesisProvider {
  readonly providerId = 'openai-tts';
  readonly displayName = 'OpenAI TTS';
  readonly supportsStreaming = true;
  readonly supportsAudioCache = true;
  readonly supportsPerCharacterVoice = true;

  constructor(private readonly options: OpenAITTSProviderOptions) {}

  async synthesize(input: TTSSynthesisInput): Promise<TTSSynthesisResult> {
    const apiKey = this.options.apiKey?.trim();
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for openai-tts provider');
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const providerOptions = mergeOptions(this.options.providerOptions, input.voiceProfile.providerOptions, input.providerOptions);
    const responseFormat = openAIFormat(input.format, stringOption(providerOptions, 'responseFormat'));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.options.organization?.trim()) headers['OpenAI-Organization'] = this.options.organization.trim();
    if (this.options.project?.trim()) headers['OpenAI-Project'] = this.options.project.trim();

    const body: Record<string, unknown> = {
      model: this.options.modelId,
      input: input.text,
      voice: voiceValue(stringOption(providerOptions, 'voice') ?? input.voiceProfile.providerVoiceId ?? this.options.defaultVoice ?? 'alloy'),
      response_format: responseFormat,
    };
    const speed = clampSpeed(numberOption(providerOptions, 'speed') ?? input.speed ?? input.voiceProfile.speed);
    if (speed !== undefined) body.speed = speed;
    const instructions = stringOption(providerOptions, 'instructions') ?? speechInstructions(input);
    if (instructions && !legacyTTSModel(this.options.modelId)) body.instructions = instructions;

    const baseUrl = this.options.baseUrl?.replace(/\/+$/, '') || 'https://api.openai.com/v1';
    const response = await fetchImpl(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: input.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`OpenAI TTS request failed with ${response.status}: ${errorText.slice(0, 500)}`);
    }

    return {
      audio: await response.arrayBuffer(),
      contentType: response.headers.get('content-type') ?? contentTypeForFormat(responseFormat),
      providerRequestId: response.headers.get('x-request-id') ?? undefined,
      providerMetadata: { responseFormat },
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

function openAIFormat(inputFormat: TTSSynthesisInput['format'], optionFormat?: string): OpenAITTSFormat {
  const requested = optionFormat ?? inputFormat;
  if (requested === 'wav' || requested === 'pcm' || requested === 'mp3') return requested;
  if (requested === 'ogg' || requested === 'opus') return 'opus';
  if (requested === 'aac' || requested === 'flac') return requested;
  return 'mp3';
}

function contentTypeForFormat(format: OpenAITTSFormat): string {
  if (format === 'wav') return 'audio/wav';
  if (format === 'pcm') return 'audio/pcm';
  if (format === 'opus') return 'audio/opus';
  if (format === 'aac') return 'audio/aac';
  if (format === 'flac') return 'audio/flac';
  return 'audio/mpeg';
}

function clampSpeed(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.min(4, Math.max(0.25, value));
}

function speechInstructions(input: TTSSynthesisInput): string | undefined {
  const parts = [input.tone, input.emotion && input.emotion !== 'neutral' ? `emotion: ${input.emotion}` : undefined]
    .filter((part): part is string => Boolean(part && part.trim()));
  return parts.length ? parts.join('; ') : undefined;
}

function legacyTTSModel(modelId: string): boolean {
  return modelId === 'tts-1' || modelId === 'tts-1-hd';
}

function voiceValue(value: string): string | { id: string } {
  return value.startsWith('voice_') ? { id: value } : value;
}
