import {
  SystemTTSProvider,
  type SpeakInput,
  type SpeakSequenceItemInput,
  type TTSProvider,
  type TTSStatus,
  type TTSPlaybackSnapshot,
  type TTSVoice,
} from '../../providers/tts';
import type { PlatformRuntimeInfo } from '../runtime';

const SYSTEM_TTS_PLUGIN = 'noveldesk-system-tts';
export const ANDROID_SYSTEM_TTS_EVENT = 'noveldesk://android/system-tts';

interface AndroidSystemTtsStatusResponse {
  readonly supported: boolean;
  readonly canSpeak: boolean;
  readonly voicesAvailable: boolean;
  readonly voiceCount: number;
  readonly message: string;
  readonly playback?: TTSPlaybackSnapshot & { readonly trackingJson?: string };
}

interface AndroidSystemTtsVoiceResponse {
  readonly id: string;
  readonly label: string;
  readonly lang: string;
}

interface AndroidSystemTtsPlaybackEvent {
  readonly utteranceId?: string;
  readonly phase?: 'start' | 'end' | 'error' | 'stopped';
  readonly message?: string;
  readonly playback?: TTSPlaybackSnapshot & { readonly trackingJson?: string };
}

export interface AndroidSystemTtsBridge {
  invoke<Result>(command: string, args?: Record<string, unknown>): Promise<Result>;
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

async function createDefaultBridge(): Promise<AndroidSystemTtsBridge> {
  const { addPluginListener, invoke } = await import('@tauri-apps/api/core');
  return {
    invoke: (command, args) => invoke(`plugin:${SYSTEM_TTS_PLUGIN}|${command}`, args),
    listen: async (event, handler) => {
      const listener = await addPluginListener(SYSTEM_TTS_PLUGIN, event, handler);
      return () => {
        void listener.unregister();
      };
    },
  };
}

function playbackEvent(payload: unknown): AndroidSystemTtsPlaybackEvent | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const candidate = payload as AndroidSystemTtsPlaybackEvent;
  if (!candidate.utteranceId || !candidate.phase) return undefined;
  return candidate;
}

export class AndroidSystemTTSProvider implements TTSProvider {
  readonly providerId = 'system';
  readonly displayName = 'Android System Speech';
  private readonly fallback = new SystemTTSProvider();
  private readonly callbacks = new Map<string, Pick<SpeakInput, 'onStart' | 'onEnd' | 'onError'>>();
  private readonly sequenceUtteranceIds = new Set<string>();
  private readonly playbackStateListeners = new Set<(snapshot: TTSPlaybackSnapshot | undefined) => void>();
  private bridgePromise: Promise<AndroidSystemTtsBridge>;
  private listenerPromise?: Promise<() => void>;
  private utteranceSequence = 0;
  private activeBackend: 'native' | 'fallback' = 'native';

  constructor(bridge?: AndroidSystemTtsBridge) {
    this.bridgePromise = bridge ? Promise.resolve(bridge) : createDefaultBridge();
  }

  async getStatus(): Promise<TTSStatus> {
    try {
      const bridge = await this.bridgePromise;
      await this.ensurePlaybackListener(bridge);
      const status = await bridge.invoke<AndroidSystemTtsStatusResponse>('getStatus');
      this.activeBackend = 'native';
      return {
        ...status,
        playback: normalizedPlaybackSnapshot(status.playback),
      };
    } catch {
      this.activeBackend = 'fallback';
      return this.fallback.getStatus();
    }
  }

  async listVoices(): Promise<TTSVoice[]> {
    try {
      const bridge = await this.bridgePromise;
      const response = await bridge.invoke<{ voices: AndroidSystemTtsVoiceResponse[] }>('listVoices');
      return response.voices.map((voice) => ({ id: voice.id, label: voice.label, lang: voice.lang }));
    } catch {
      this.activeBackend = 'fallback';
      return this.fallback.listVoices();
    }
  }

  async speak(input: SpeakInput): Promise<void> {
    if (!input.text.trim()) {
      input.onEnd?.();
      return;
    }

    try {
      const bridge = await this.bridgePromise;
      await this.ensurePlaybackListener(bridge);
      this.clearSequenceCallbacks();
      const utteranceId = `noveldesk-${Date.now()}-${++this.utteranceSequence}`;
      this.callbacks.set(utteranceId, input);
      try {
        await bridge.invoke('speak', {
          utteranceId,
          text: input.text,
          rate: input.rate,
          pitch: input.pitch ?? 1,
          volume: input.volume ?? 1,
          voiceId: input.voiceURI,
          title: input.mediaMetadata?.title,
          album: input.mediaMetadata?.album,
          artist: input.mediaMetadata?.artist,
          trackingJson: input.playbackAnchor ? JSON.stringify(input.playbackAnchor) : undefined,
        });
        this.activeBackend = 'native';
      } catch (error) {
        this.callbacks.delete(utteranceId);
        throw error;
      }
    } catch {
      this.activeBackend = 'fallback';
      await this.fallback.speak(input);
    }
  }

  async speakSequence(items: readonly SpeakSequenceItemInput[]): Promise<void> {
    const playable = items.filter((item) => item.text.trim());
    if (playable.length === 0) {
      items.forEach((item) => item.onEnd?.());
      return;
    }
    try {
      const bridge = await this.bridgePromise;
      await this.ensurePlaybackListener(bridge);
      this.clearSequenceCallbacks();
      const requests = playable.map((input) => {
        const utteranceId = `noveldesk-${Date.now()}-${++this.utteranceSequence}`;
        this.callbacks.set(utteranceId, input);
        this.sequenceUtteranceIds.add(utteranceId);
        return {
          utteranceId,
          text: input.text,
          rate: input.rate,
          pitch: input.pitch ?? 1,
          volume: input.volume ?? 1,
          voiceId: input.voiceURI,
          title: input.mediaMetadata?.title,
          album: input.mediaMetadata?.album,
          artist: input.mediaMetadata?.artist,
          trackingJson: input.playbackAnchor ? JSON.stringify(input.playbackAnchor) : undefined,
          pauseAfterMs: Math.max(0, Math.min(5_000, Math.round(input.pauseAfterMs ?? 0))),
        };
      });
      await bridge.invoke('speakBatch', { items: requests });
      this.activeBackend = 'native';
    } catch {
      this.clearSequenceCallbacks();
      this.activeBackend = 'fallback';
      await this.speakFallbackSequence(playable);
    }
  }

  pause(): void {
    if (this.activeBackend === 'fallback') {
      this.fallback.pause();
      return;
    }
    void this.invokeControl('pause');
  }

  resume(): void {
    if (this.activeBackend === 'fallback') {
      this.fallback.resume();
      return;
    }
    void this.invokeControl('resume');
  }

  stop(): void {
    this.callbacks.clear();
    this.sequenceUtteranceIds.clear();
    if (this.activeBackend === 'fallback') {
      this.fallback.stop();
      return;
    }
    void this.invokeControl('stop');
  }

  subscribePlaybackState(listener: (snapshot: TTSPlaybackSnapshot | undefined) => void): () => void {
    this.playbackStateListeners.add(listener);
    void this.bridgePromise.then((bridge) => this.ensurePlaybackListener(bridge)).catch(() => undefined);
    return () => this.playbackStateListeners.delete(listener);
  }

  private async ensurePlaybackListener(bridge: AndroidSystemTtsBridge): Promise<void> {
    if (!this.listenerPromise) {
      this.listenerPromise = bridge.listen(ANDROID_SYSTEM_TTS_EVENT, (payload) => this.handlePlaybackEvent(payload));
    }
    await this.listenerPromise;
  }

  private handlePlaybackEvent(payload: unknown): void {
    const event = playbackEvent(payload);
    if (!event) return;
    const snapshot = normalizedPlaybackSnapshot(event.playback);
    if (event.playback) this.playbackStateListeners.forEach((listener) => listener(snapshot));
    const callbacks = this.callbacks.get(event.utteranceId!);
    if (!callbacks) return;
    if (event.phase === 'start') {
      callbacks.onStart?.();
      return;
    }
    if (event.phase === 'error') {
      callbacks.onError?.(event.message ?? 'Android 시스템 음성을 재생하지 못했습니다.');
      if (this.sequenceUtteranceIds.has(event.utteranceId!)) this.clearSequenceCallbacks();
      else this.callbacks.delete(event.utteranceId!);
      return;
    }
    callbacks.onEnd?.();
    if (!this.sequenceUtteranceIds.has(event.utteranceId!)) this.callbacks.delete(event.utteranceId!);
  }

  private clearSequenceCallbacks(): void {
    this.sequenceUtteranceIds.forEach((utteranceId) => this.callbacks.delete(utteranceId));
    this.sequenceUtteranceIds.clear();
  }

  private async speakFallbackSequence(items: readonly SpeakSequenceItemInput[]): Promise<void> {
    for (const item of items) {
      await new Promise<void>((resolve) => {
        void this.fallback.speak({
          ...item,
          onEnd: () => {
            item.onEnd?.();
            resolve();
          },
          onError: (message) => {
            item.onError?.(message);
            resolve();
          },
        });
      });
    }
  }

  private async invokeControl(command: 'pause' | 'resume' | 'stop'): Promise<void> {
    try {
      const bridge = await this.bridgePromise;
      await bridge.invoke(command);
    } catch {
      // Playback control is best-effort. A following speak call can still use
      // Web Speech fallback if the native engine becomes unavailable.
    }
  }
}

function normalizedPlaybackSnapshot(
  snapshot: (TTSPlaybackSnapshot & { readonly trackingJson?: string }) | undefined,
): TTSPlaybackSnapshot | undefined {
  if (!snapshot) return undefined;
  let anchor: TTSPlaybackSnapshot['anchor'];
  if (snapshot.trackingJson) {
    try {
      anchor = JSON.parse(snapshot.trackingJson) as TTSPlaybackSnapshot['anchor'];
    } catch {
      anchor = undefined;
    }
  }
  return { ...snapshot, anchor };
}

export function createPlatformSystemTTSProvider(runtime: PlatformRuntimeInfo): TTSProvider {
  return runtime.kind === 'tauri-mobile' ? new AndroidSystemTTSProvider() : new SystemTTSProvider();
}
