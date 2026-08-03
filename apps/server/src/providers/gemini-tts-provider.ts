import type { TTSSynthesisInput, TTSSynthesisProvider, TTSSynthesisResult } from '../../../../src/providers/tts';

export interface GeminiTTSProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly fetchImpl?: typeof fetch;
}

export class GeminiTTSProvider implements TTSSynthesisProvider {
  readonly providerId = 'gemini-tts';
  readonly displayName = 'Gemini TTS';
  readonly supportsStreaming = true;
  readonly supportsAudioCache = true;
  readonly supportsPerCharacterVoice = true;

  constructor(private readonly options: GeminiTTSProviderOptions) {}

  async synthesize(input: TTSSynthesisInput): Promise<TTSSynthesisResult> {
    const apiKey = this.options.apiKey?.trim();
    if (!apiKey) throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is required for gemini-tts provider');
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const providerOptions = mergeOptions(
      this.options.providerOptions,
      input.voiceProfile.providerOptions,
      input.providerOptions,
    );
    const voice = stringOption(providerOptions, 'voice') ?? input.voiceProfile.providerVoiceId ?? 'Kore';
    const sampleRate = integerOption(providerOptions, 'sampleRate') ?? 24_000;
    const response = await fetchImpl(
      `${this.options.baseUrl?.replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com'}/v1beta/interactions`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.modelId || 'gemini-3.1-flash-tts-preview',
          input: ttsInputText(input, providerOptions),
          response_format: { type: 'audio' },
          generation_config: {
            speech_config: [{ voice }],
          },
        }),
        signal: input.signal,
      },
    );
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Gemini TTS request failed with ${response.status}: ${errorText.slice(0, 500)}`);
    }
    const json = await response.json().catch(() => undefined);
    const pcm = audioDataFromGeminiInteraction(json);
    if (!pcm.byteLength) throw new Error('Gemini TTS returned no audio data');
    const wav = wavFromPcm16(pcm, sampleRate);
    return {
      audio: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
      contentType: 'audio/wav',
      providerRequestId: response.headers.get('x-request-id') ?? undefined,
      providerMetadata: {
        sourceContentType: 'audio/pcm',
        sampleRate,
        voice,
      },
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

function integerOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function ttsInputText(input: TTSSynthesisInput, providerOptions: Record<string, unknown>): string {
  const prompt =
    stringOption(providerOptions, 'prompt') ??
    stringOption(providerOptions, 'instructions') ??
    speechInstructions(input);
  return prompt ? `${prompt}\n\n${input.text}` : input.text;
}

function speechInstructions(input: TTSSynthesisInput): string | undefined {
  const parts = [input.tone, input.emotion && input.emotion !== 'neutral' ? input.emotion : undefined].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return parts.length ? `Read the following text exactly with this delivery: ${parts.join(', ')}.` : undefined;
}

function audioDataFromGeminiInteraction(value: unknown): Buffer {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const outputAudio = (body.output_audio ?? body.outputAudio) as unknown;
  if (outputAudio && typeof outputAudio === 'object' && !Array.isArray(outputAudio)) {
    const data = (outputAudio as Record<string, unknown>).data;
    if (typeof data === 'string') return Buffer.from(data, 'base64');
  }
  const data = findBase64AudioData(body);
  if (data) return Buffer.from(data, 'base64');
  return Buffer.alloc(0);
}

function findBase64AudioData(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBase64AudioData(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const mimeType = record.mimeType ?? record.mime_type;
  if (typeof record.data === 'string' && typeof mimeType === 'string' && mimeType.startsWith('audio/')) {
    return record.data;
  }
  for (const item of Object.values(record)) {
    const found = findBase64AudioData(item);
    if (found) return found;
  }
  return undefined;
}

function wavFromPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}
