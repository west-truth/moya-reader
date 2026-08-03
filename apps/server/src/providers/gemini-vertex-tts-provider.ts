import type { TTSSynthesisInput, TTSSynthesisProvider, TTSSynthesisResult } from '../../../../src/providers/tts';

export interface GeminiVertexTTSGenerateContentClient {
  generateAudio(input: {
    readonly modelId: string;
    readonly contents: string;
    readonly voice: string;
    readonly languageCode: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly audio: ArrayBuffer;
    readonly sourceContentType?: string;
    readonly providerRequestId?: string;
  }>;
}

export interface GeminiVertexTTSProviderOptions {
  readonly project?: string;
  readonly location: string;
  readonly credentialsPath?: string;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly client?: GeminiVertexTTSGenerateContentClient;
}

export class GeminiVertexTTSProvider implements TTSSynthesisProvider {
  readonly providerId = 'gemini-vertex-tts';
  readonly displayName = 'Gemini Vertex TTS';
  readonly supportsStreaming = true;
  readonly supportsAudioCache = true;
  readonly supportsPerCharacterVoice = true;

  constructor(private readonly options: GeminiVertexTTSProviderOptions) {}

  async synthesize(input: TTSSynthesisInput): Promise<TTSSynthesisResult> {
    if (!this.options.modelId.trim()) throw new Error('Gemini Vertex TTS model id is required');
    const providerOptions = mergeOptions(this.options.providerOptions, input.voiceProfile.providerOptions, input.providerOptions);
    const voice = stringOption(providerOptions, 'voice') ?? input.voiceProfile.providerVoiceId ?? 'Kore';
    const languageCode = stringOption(providerOptions, 'languageCode') ?? input.voiceProfile.language ?? 'ko-KR';
    const client = this.options.client ?? await createGeminiVertexTTSGenerateContentClient(this.options);
    const result = await client.generateAudio({
      modelId: this.options.modelId,
      contents: ttsInputText(input, providerOptions),
      voice,
      languageCode,
      signal: input.signal,
    });
    if (!result.audio.byteLength) throw new Error('Gemini Vertex TTS returned no audio data');
    const audio = Buffer.from(result.audio);
    const wav = result.sourceContentType?.startsWith('audio/wav') ? audio : wavFromPcm16(audio, 24_000);
    return {
      audio: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
      contentType: 'audio/wav',
      providerRequestId: result.providerRequestId,
      providerMetadata: {
        sourceContentType: result.sourceContentType ?? 'audio/pcm',
        sampleRate: 24_000,
        voice,
        languageCode,
      },
    };
  }
}

export async function createGeminiVertexTTSGenerateContentClient(
  options: Omit<GeminiVertexTTSProviderOptions, 'client' | 'modelId'>,
): Promise<GeminiVertexTTSGenerateContentClient> {
  if (!options.project?.trim()) throw new Error('GOOGLE_CLOUD_PROJECT is required for gemini-vertex-tts provider');
  if (options.credentialsPath && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = options.credentialsPath;
  }
  process.env.GOOGLE_GENAI_USE_ENTERPRISE = process.env.GOOGLE_GENAI_USE_ENTERPRISE || 'True';
  const { GoogleGenAI } = await import('@google/genai');
  const sdkClient = new GoogleGenAI({
    vertexai: true,
    project: options.project,
    location: options.location || 'global',
  });
  return {
    async generateAudio(input) {
      const response = await sdkClient.models.generateContent({
        model: input.modelId,
        contents: input.contents,
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            languageCode: input.languageCode,
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: input.voice,
              },
            },
          },
          abortSignal: input.signal,
        } as Record<string, unknown>,
      });
      const audio = audioDataFromGenerateContentResponse(response);
      if (!audio.buffer.byteLength) throw new Error('Gemini Vertex TTS returned no audio data');
      const audioBuffer = audio.buffer;
      return {
        audio: audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength) as ArrayBuffer,
        sourceContentType: audio.mimeType,
        providerRequestId: response.sdkHttpResponse?.headers?.['x-request-id'],
      };
    },
  };
}

function mergeOptions(...values: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  return Object.assign({}, ...values.filter(Boolean));
}

function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function ttsInputText(input: TTSSynthesisInput, providerOptions: Record<string, unknown>): string {
  const prompt = stringOption(providerOptions, 'prompt') ?? stringOption(providerOptions, 'instructions') ?? speechInstructions(input);
  return prompt ? `${prompt}: ${input.text}` : input.text;
}

function speechInstructions(input: TTSSynthesisInput): string | undefined {
  const parts = [input.tone, input.emotion && input.emotion !== 'neutral' ? input.emotion : undefined]
    .filter((part): part is string => Boolean(part && part.trim()));
  return parts.length ? `Read the following text exactly with this delivery: ${parts.join(', ')}` : undefined;
}

function audioDataFromGenerateContentResponse(value: unknown): { buffer: Buffer; mimeType?: string } {
  const found = findInlineAudio(value);
  if (!found) return { buffer: Buffer.alloc(0) };
  return found;
}

function findInlineAudio(value: unknown): { buffer: Buffer; mimeType?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInlineAudio(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const inlineData = record.inlineData ?? record.inline_data;
  if (inlineData && typeof inlineData === 'object' && !Array.isArray(inlineData)) {
    const inlineRecord = inlineData as Record<string, unknown>;
    const mimeType = typeof inlineRecord.mimeType === 'string'
      ? inlineRecord.mimeType
      : typeof inlineRecord.mime_type === 'string'
        ? inlineRecord.mime_type
        : undefined;
    const data = inlineRecord.data;
    const buffer = bufferFromInlineAudioData(data);
    if (buffer) return { buffer, mimeType };
  }
  const directBuffer = bufferFromInlineAudioData(record.data);
  if (directBuffer && typeof record.mimeType === 'string' && record.mimeType.startsWith('audio/')) {
    return { buffer: directBuffer, mimeType: record.mimeType };
  }
  for (const item of Object.values(record)) {
    const found = findInlineAudio(item);
    if (found) return found;
  }
  return undefined;
}

function bufferFromInlineAudioData(value: unknown): Buffer | undefined {
  if (typeof value === 'string' && value.trim()) return Buffer.from(value, 'base64');
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return undefined;
}

function wavFromPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}
