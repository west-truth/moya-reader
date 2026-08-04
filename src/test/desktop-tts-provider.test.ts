import { describe, expect, it, vi } from 'vitest';
import {
  listDesktopTTSVoices,
  synthesizeDesktopTTS,
  type DesktopTTSSynthesisCommandResult,
} from '../providers/desktop-tts-provider';

describe('desktop TTS provider bridge', () => {
  it('invokes the Tauri synthesis command and decodes returned audio', async () => {
    const commandResult: DesktopTTSSynthesisCommandResult = {
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
      contentType: 'audio/mpeg',
      audioBase64: btoa(String.fromCharCode(1, 2, 3)),
      byteSize: 3,
      providerRequestId: 'req_1',
    };
    const invoke = vi.fn(async () => commandResult);

    const result = await synthesizeDesktopTTS(
      {
        providerId: 'openai-tts',
        modelId: 'gpt-4o-mini-tts',
        text: 'Hello.',
        voiceId: 'alloy',
        speed: 1.1,
        providerOptions: { instructions: 'Read softly.' },
      },
      invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    );

    expect(invoke).toHaveBeenCalledWith('desktop_tts_synthesize', {
      request: {
        providerId: 'openai-tts',
        modelId: 'gpt-4o-mini-tts',
        text: 'Hello.',
        voiceId: 'alloy',
        speed: 1.1,
        emotion: undefined,
        tone: undefined,
        format: undefined,
        providerOptions: { instructions: 'Read softly.' },
      },
    });
    expect(result).toMatchObject({
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
      contentType: 'audio/mpeg',
      byteSize: 3,
      providerRequestId: 'req_1',
    });
    expect(new Uint8Array(result.audio)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('passes local endpoint synthesis options through the desktop TTS command', async () => {
    const commandResult: DesktopTTSSynthesisCommandResult = {
      providerId: 'local-endpoint',
      modelId: 'kokoro',
      contentType: 'audio/wav',
      audioBase64: btoa(String.fromCharCode(4, 5, 6)),
      byteSize: 3,
    };
    const invoke = vi.fn(async () => commandResult);

    const result = await synthesizeDesktopTTS(
      {
        providerId: 'local-endpoint',
        modelId: 'kokoro',
        text: '안녕하세요.',
        voiceId: 'alice',
        speed: 0.95,
        tone: 'calm',
        emotion: 'warm',
        format: 'wav',
        providerOptions: { sampleRate: 24000 },
      },
      invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    );

    expect(invoke).toHaveBeenCalledWith('desktop_tts_synthesize', {
      request: {
        providerId: 'local-endpoint',
        modelId: 'kokoro',
        text: '안녕하세요.',
        voiceId: 'alice',
        speed: 0.95,
        emotion: 'warm',
        tone: 'calm',
        format: 'wav',
        providerOptions: { sampleRate: 24000 },
      },
    });
    expect(result.contentType).toBe('audio/wav');
    expect(new Uint8Array(result.audio)).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('lists desktop TTS voices through the typed bridge', async () => {
    const invoke = vi.fn(async () => ({
      voices: [{ id: 'alice', label: 'Alice', lang: 'ko-KR' }],
    }));

    await expect(
      listDesktopTTSVoices(
        'local-endpoint',
        invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
      ),
    ).resolves.toEqual({ voices: [{ id: 'alice', label: 'Alice', lang: 'ko-KR' }] });
    expect(invoke).toHaveBeenCalledWith('desktop_tts_list_voices', { providerId: 'local-endpoint' });
  });

  it('rejects empty provider ids and text before crossing IPC', async () => {
    const invoke = vi.fn();

    await expect(
      synthesizeDesktopTTS(
        { providerId: ' ', text: 'Hello.' },
        invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
      ),
    ).rejects.toThrow('provider id가 필요합니다');
    await expect(
      synthesizeDesktopTTS(
        { providerId: 'openai-tts', text: ' ' },
        invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
      ),
    ).rejects.toThrow('text가 필요합니다');
    await expect(
      listDesktopTTSVoices(
        ' ',
        invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
      ),
    ).rejects.toThrow('provider id가 필요합니다');
    expect(invoke).not.toHaveBeenCalled();
  });
});
