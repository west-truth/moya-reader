export interface DesktopTTSSynthesisInput {
  readonly providerId: string;
  readonly modelId?: string;
  readonly text: string;
  readonly voiceId?: string;
  readonly speed?: number;
  readonly emotion?: string;
  readonly tone?: string;
  readonly format?: 'mp3' | 'wav' | 'pcm' | 'ogg' | 'opus' | 'aac' | 'flac';
  readonly providerOptions?: Record<string, unknown>;
}

export interface DesktopTTSSynthesisCommandResult {
  readonly providerId: string;
  readonly modelId?: string;
  readonly contentType: string;
  readonly audioBase64: string;
  readonly byteSize: number;
  readonly providerRequestId?: string;
}

export interface DesktopTTSSynthesisResult {
  readonly providerId: string;
  readonly modelId?: string;
  readonly contentType: string;
  readonly audio: ArrayBuffer;
  readonly byteSize: number;
  readonly providerRequestId?: string;
}

export interface DesktopTTSVoice {
  readonly id: string;
  readonly label: string;
  readonly lang: string;
}

export function desktopTTSSynthesisResultFromCommand(
  result: DesktopTTSSynthesisCommandResult,
): DesktopTTSSynthesisResult {
  return {
    providerId: result.providerId,
    modelId: result.modelId,
    contentType: result.contentType,
    audio: base64ToArrayBuffer(result.audioBase64),
    byteSize: result.byteSize,
    providerRequestId: result.providerRequestId,
  };
}

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export async function synthesizeDesktopTTS(
  input: DesktopTTSSynthesisInput,
  invoke?: TauriInvoke,
): Promise<DesktopTTSSynthesisResult> {
  if (!input.providerId.trim()) throw new Error('데스크톱 TTS provider id가 필요합니다');
  if (!input.text.trim()) throw new Error('데스크톱 TTS text가 필요합니다');
  const invokeCommand = invoke ?? (await loadInvoke());
  const result = await invokeCommand<DesktopTTSSynthesisCommandResult>('desktop_tts_synthesize', {
    request: {
      providerId: input.providerId,
      modelId: input.modelId,
      text: input.text,
      voiceId: input.voiceId,
      speed: input.speed,
      emotion: input.emotion,
      tone: input.tone,
      format: input.format,
      providerOptions: input.providerOptions ?? {},
    },
  });
  return desktopTTSSynthesisResultFromCommand(result);
}

export async function listDesktopTTSVoices(
  providerId: string,
  invoke?: TauriInvoke,
): Promise<{ voices: DesktopTTSVoice[] }> {
  if (!providerId.trim()) throw new Error('데스크톱 TTS provider id가 필요합니다');
  const invokeCommand = invoke ?? (await loadInvoke());
  return invokeCommand<{ voices: DesktopTTSVoice[] }>('desktop_tts_list_voices', { providerId });
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }
  const bufferCtor = (globalThis as unknown as { Buffer?: { from(value: string, encoding: 'base64'): Uint8Array } })
    .Buffer;
  if (!bufferCtor) throw new Error('Base64 decoder is unavailable');
  const bytes = bufferCtor.from(value, 'base64');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function loadInvoke(): Promise<TauriInvoke> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as TauriInvoke;
}
