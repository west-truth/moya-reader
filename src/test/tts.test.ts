import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemTTSProvider } from '../providers/tts';

class MockUtterance {
  text: string;
  rate = 1;
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

  constructor(text = '') {
    this.text = text;
  }
}

function makeVoice(voiceURI: string, name: string, lang: string): SpeechSynthesisVoice {
  return {
    voiceURI,
    name,
    lang,
    localService: true,
    default: false,
  };
}

function installSpeechSynthesis(voices: SpeechSynthesisVoice[]) {
  const spoken: MockUtterance[] = [];
  const synthesis = {
    getVoices: vi.fn(() => voices),
    speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
      spoken.push(utterance as unknown as MockUtterance);
    }),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('window', {
    speechSynthesis: synthesis,
    SpeechSynthesisUtterance: MockUtterance,
    setTimeout,
    clearTimeout,
  });
  return { synthesis, spoken };
}

describe('SystemTTSProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports unsupported environments without throwing', async () => {
    vi.stubGlobal('window', undefined);
    const provider = new SystemTTSProvider();
    const onError = vi.fn();

    await expect(provider.listVoices()).resolves.toEqual([]);
    await expect(provider.getStatus()).resolves.toMatchObject({
      supported: false,
      canSpeak: false,
      voicesAvailable: false,
      voiceCount: 0,
    });
    await expect(provider.speak({ text: '안녕하세요', rate: 1, onError })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('이 환경에서는 시스템 TTS를 사용할 수 없습니다.');

    expect(() => provider.pause()).not.toThrow();
    expect(() => provider.resume()).not.toThrow();
    expect(() => provider.stop()).not.toThrow();
  });

  it('lists voices and falls back to Korean voices when a saved voice is unavailable', async () => {
    const koreanVoice = makeVoice('ko-local', 'Korean Local', 'ko-KR');
    const englishVoice = makeVoice('en-local', 'English Local', 'en-US');
    const { synthesis, spoken } = installSpeechSynthesis([englishVoice, koreanVoice]);
    const provider = new SystemTTSProvider();

    await expect(provider.getStatus()).resolves.toMatchObject({
      supported: true,
      canSpeak: true,
      voicesAvailable: true,
      voiceCount: 2,
    });
    await expect(provider.listVoices()).resolves.toEqual([
      expect.objectContaining({ id: 'en-local', label: 'English Local (en-US)', lang: 'en-US' }),
      expect.objectContaining({ id: 'ko-local', label: 'Korean Local (ko-KR)', lang: 'ko-KR' }),
    ]);

    await provider.speak({ text: '본문', rate: 1.2, voiceURI: 'missing-voice' });

    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(synthesis.speak).toHaveBeenCalledTimes(1);
    expect(spoken[0]).toMatchObject({
      text: '본문',
      rate: 1.2,
      lang: 'ko-KR',
      voice: koreanVoice,
    });
  });

  it('surfaces empty voice lists as a default-voice fallback state', async () => {
    vi.useFakeTimers();
    installSpeechSynthesis([]);
    const provider = new SystemTTSProvider();

    const statusPromise = provider.getStatus();
    await vi.advanceTimersByTimeAsync(500);

    await expect(statusPromise).resolves.toMatchObject({
      supported: true,
      canSpeak: true,
      voicesAvailable: false,
      voiceCount: 0,
    });
  });

  it('does not enqueue delayed speech after stop', async () => {
    vi.useFakeTimers();
    const { synthesis } = installSpeechSynthesis([]);
    const provider = new SystemTTSProvider();

    const speakPromise = provider.speak({ text: '늦게 시작하면 안 되는 본문', rate: 1 });
    provider.stop();
    await vi.advanceTimersByTimeAsync(500);
    await speakPromise;

    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(synthesis.speak).not.toHaveBeenCalled();
  });
});
