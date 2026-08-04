import { describe, expect, it, vi } from 'vitest';
import {
  ANDROID_SYSTEM_TTS_EVENT,
  AndroidSystemTTSProvider,
  createPlatformSystemTTSProvider,
  type AndroidSystemTtsBridge,
} from './system-tts';

class FakeSystemTtsBridge implements AndroidSystemTtsBridge {
  readonly calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, (payload: unknown) => void>();

  async invoke<Result>(command: string, args?: Record<string, unknown>): Promise<Result> {
    this.calls.push({ command, args });
    if (command === 'getStatus') {
      return {
        supported: true,
        canSpeak: true,
        voicesAvailable: true,
        voiceCount: 1,
        message: 'ready',
        playback: {
          active: true,
          playing: false,
          paused: true,
          utteranceId: 'sentence-2',
          itemIndex: 1,
          positionMs: 420,
          itemCount: 3,
          updatedAtMs: 1_700_000_000_000,
          trackingJson: JSON.stringify({
            kind: 'reflowable_text',
            bookId: 'book-1',
            chapterId: 'chapter-1',
            blockId: 'paragraph-2',
            blockIndex: 4,
            startOffset: 10,
            endOffset: 20,
          }),
        },
      } as Result;
    }
    if (command === 'listVoices') {
      return { voices: [{ id: 'ko-voice', label: 'Korean', lang: 'ko-KR' }] } as Result;
    }
    return undefined as Result;
  }

  async listen(event: string, handler: (payload: unknown) => void): Promise<() => void> {
    this.listeners.set(event, handler);
    return () => this.listeners.delete(event);
  }

  emit(event: string, payload: unknown): void {
    this.listeners.get(event)?.(payload);
  }
}

describe('Android system TTS provider boundary', () => {
  it('maps native status and voices without leaking Kotlin objects into provider state', async () => {
    const bridge = new FakeSystemTtsBridge();
    const provider = new AndroidSystemTTSProvider(bridge);

    await expect(provider.getStatus()).resolves.toMatchObject({
      canSpeak: true,
      voiceCount: 1,
      playback: {
        active: true,
        paused: true,
        utteranceId: 'sentence-2',
        itemIndex: 1,
        positionMs: 420,
        anchor: { kind: 'reflowable_text', blockId: 'paragraph-2', startOffset: 10, endOffset: 20 },
      },
    });
    await expect(provider.listVoices()).resolves.toEqual([{ id: 'ko-voice', label: 'Korean', lang: 'ko-KR' }]);
  });

  it('routes playback callbacks and controls through one native provider bridge', async () => {
    const bridge = new FakeSystemTtsBridge();
    const provider = new AndroidSystemTTSProvider(bridge);
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    const onPlaybackState = vi.fn();
    const unsubscribe = provider.subscribePlaybackState(onPlaybackState);

    await provider.speak({
      text: '안녕하세요.',
      rate: 1.1,
      voiceURI: 'ko-voice',
      mediaMetadata: { title: '2화', album: '돌아온 밤', artist: '서이레' },
      onStart,
      onEnd,
      onError,
    });
    const speakCall = bridge.calls.find((call) => call.command === 'speak');
    const utteranceId = String(speakCall?.args?.utteranceId);
    expect(speakCall?.args).toMatchObject({
      text: '안녕하세요.',
      rate: 1.1,
      voiceId: 'ko-voice',
      title: '2화',
      album: '돌아온 밤',
      artist: '서이레',
    });

    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, {
      utteranceId,
      phase: 'start',
      playback: {
        active: true,
        playing: true,
        paused: false,
        utteranceId,
        itemIndex: 0,
        positionMs: 0,
        itemCount: 1,
        updatedAtMs: 100,
        trackingJson: JSON.stringify({
          kind: 'fixed_text',
          bookId: 'book-1',
          chapterId: 'chapter-1',
          pageIndex: 2,
          textRevisionId: 'revision-2',
          blockId: 'block-4',
          startOffset: 0,
          endOffset: 10,
        }),
      },
    });
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId, phase: 'end' });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onPlaybackState).toHaveBeenCalledWith(
      expect.objectContaining({
        active: true,
        anchor: expect.objectContaining({ kind: 'fixed_text', pageIndex: 2, blockId: 'block-4' }),
      }),
    );
    unsubscribe();

    provider.pause();
    provider.resume();
    provider.stop();
    await vi.waitFor(() => {
      expect(bridge.calls.map((call) => call.command)).toEqual(
        expect.arrayContaining(['speak', 'pause', 'resume', 'stop']),
      );
    });
  });

  it('hands a sentence window to one native playlist and routes callbacks per item', async () => {
    const bridge = new FakeSystemTtsBridge();
    const provider = new AndroidSystemTTSProvider(bridge);
    const firstStart = vi.fn();
    const firstEnd = vi.fn();
    const secondStart = vi.fn();
    const secondEnd = vi.fn();

    await provider.speakSequence([
      {
        text: '첫 문장.',
        rate: 1,
        pauseAfterMs: 180,
        playbackAnchor: {
          kind: 'reflowable_text',
          bookId: 'book-1',
          chapterId: 'chapter-1',
          blockId: 'paragraph-1',
          blockIndex: 0,
          startOffset: 0,
          endOffset: 5,
        },
        onStart: firstStart,
        onEnd: firstEnd,
      },
      { text: '둘째 문장.', rate: 1, pauseAfterMs: 0, onStart: secondStart, onEnd: secondEnd },
    ]);

    const batch = bridge.calls.find((call) => call.command === 'speakBatch');
    const items = batch?.args?.items as Array<{ utteranceId: string; pauseAfterMs: number; trackingJson?: string }>;
    expect(items).toHaveLength(2);
    expect(items[0].pauseAfterMs).toBe(180);
    expect(JSON.parse(items[0].trackingJson!)).toMatchObject({
      kind: 'reflowable_text',
      blockId: 'paragraph-1',
      endOffset: 5,
    });
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId: items[0].utteranceId, phase: 'start' });
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId: items[0].utteranceId, phase: 'end' });
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId: items[1].utteranceId, phase: 'start' });
    bridge.emit(ANDROID_SYSTEM_TTS_EVENT, { utteranceId: items[1].utteranceId, phase: 'end' });

    expect(firstStart).toHaveBeenCalledOnce();
    expect(firstEnd).toHaveBeenCalledOnce();
    expect(secondStart).toHaveBeenCalledOnce();
    expect(secondEnd).toHaveBeenCalledOnce();
  });

  it('selects the native provider only for the Tauri mobile runtime', () => {
    const mobile = createPlatformSystemTTSProvider({
      kind: 'tauri-mobile',
      hasTauri: true,
      isMobileWebView: true,
      userAgent: 'Android',
    });
    const desktop = createPlatformSystemTTSProvider({
      kind: 'tauri-desktop',
      hasTauri: true,
      isMobileWebView: false,
      userAgent: 'Windows',
    });

    expect(mobile).toBeInstanceOf(AndroidSystemTTSProvider);
    expect(desktop).not.toBeInstanceOf(AndroidSystemTTSProvider);
  });
});
