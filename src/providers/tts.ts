import type { VoiceProfile } from '../domain/types';

export interface TTSVoice {
  id: string;
  label: string;
  lang: string;
  nativeVoice?: SpeechSynthesisVoice;
}

export interface TTSStatus {
  supported: boolean;
  canSpeak: boolean;
  voicesAvailable: boolean;
  voiceCount: number;
  message: string;
  /** Native media-service state, present only when the platform owns background playback. */
  playback?: TTSPlaybackSnapshot;
}

export interface TTSPlaybackSnapshot {
  active: boolean;
  playing: boolean;
  paused: boolean;
  utteranceId?: string;
  itemIndex: number;
  positionMs: number;
  itemCount: number;
  updatedAtMs: number;
  anchor?: TTSPlaybackTrackingAnchor;
}

export type TTSPlaybackTrackingAnchor =
  | {
      kind: 'reflowable_text';
      bookId: string;
      chapterId: string;
      blockId: string;
      blockIndex: number;
      startOffset: number;
      endOffset: number;
      queueItemFingerprint?: string;
    }
  | {
      kind: 'fixed_text';
      bookId: string;
      chapterId: string;
      pageIndex: number;
      textRevisionId: string;
      blockId: string;
      startOffset: number;
      endOffset: number;
      queueItemFingerprint?: string;
    };

export interface SpeakInput {
  text: string;
  rate: number;
  pitch?: number;
  volume?: number;
  voiceURI?: string;
  mediaMetadata?: {
    title: string;
    album?: string;
    artist?: string;
  };
  /** Opaque-to-native cursor metadata. It must never contain source document text. */
  playbackAnchor?: TTSPlaybackTrackingAnchor;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
}

export interface SpeakSequenceItemInput extends SpeakInput {
  /** Native playlist gap after this item. Browser providers may ignore it. */
  pauseAfterMs?: number;
}

export interface TTSProvider {
  readonly providerId: string;
  readonly displayName: string;
  getStatus(): Promise<TTSStatus>;
  listVoices(): Promise<TTSVoice[]>;
  speak(input: SpeakInput): Promise<void>;
  speakSequence?(items: readonly SpeakSequenceItemInput[]): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  subscribePlaybackState?(listener: (snapshot: TTSPlaybackSnapshot | undefined) => void): () => void;
}

export interface TTSSynthesisInput {
  readonly text: string;
  readonly voiceProfile: VoiceProfile;
  readonly emotion?: string;
  readonly tone?: string;
  readonly speed?: number;
  readonly format?: 'mp3' | 'wav' | 'pcm' | 'ogg' | 'opus' | 'aac' | 'flac';
  readonly providerOptions?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface TTSSynthesisResult {
  readonly audio: ArrayBuffer;
  readonly contentType: string;
  readonly durationMs?: number;
  readonly providerRequestId?: string;
  readonly providerMetadata?: Record<string, unknown>;
}

export interface TTSSynthesisProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly supportsStreaming: boolean;
  readonly supportsAudioCache: boolean;
  readonly supportsPerCharacterVoice: boolean;
  listVoices?(): Promise<TTSVoice[]>;
  synthesize(input: TTSSynthesisInput): Promise<TTSSynthesisResult>;
}

function getSpeechSynthesis(): SpeechSynthesis | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.speechSynthesis;
}

function getUtteranceConstructor(): typeof SpeechSynthesisUtterance | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.SpeechSynthesisUtterance;
}

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const synthesis = getSpeechSynthesis();
  if (!synthesis) return Promise.resolve([]);

  const existing = synthesis.getVoices();
  if (existing.length) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timeout);
      synthesis.removeEventListener('voiceschanged', finish);
      resolve(synthesis.getVoices());
    };
    const timeout = window.setTimeout(finish, 500);
    synthesis.addEventListener('voiceschanged', finish, { once: true });
  });
}

function systemSpeechErrorMessage(code: string): string {
  if (code === 'not-allowed') return '시스템 음성 재생 권한이 없습니다.';
  if (code === 'audio-busy') return '다른 오디오가 사용 중이라 재생하지 못했습니다.';
  if (code === 'network') return '시스템 음성 데이터를 불러오지 못했습니다.';
  if (code === 'language-unavailable' || code === 'voice-unavailable') {
    return '선택한 시스템 음성을 사용할 수 없습니다.';
  }
  if (code === 'interrupted' || code === 'canceled') return '시스템 음성 재생이 중단되었습니다.';
  return code ? `시스템 음성 오류: ${code}` : '시스템 음성을 재생하지 못했습니다.';
}

export class SystemTTSProvider implements TTSProvider {
  readonly providerId = 'system';
  readonly displayName = 'System Speech';
  private generation = 0;

  async getStatus(): Promise<TTSStatus> {
    const synthesis = getSpeechSynthesis();
    const Utterance = getUtteranceConstructor();
    if (!synthesis || !Utterance) {
      return {
        supported: false,
        canSpeak: false,
        voicesAvailable: false,
        voiceCount: 0,
        message: '이 환경에서는 시스템 TTS를 사용할 수 없습니다. 브라우저/WebView 또는 OS 음성 설정을 확인하세요.',
      };
    }

    const voices = await loadVoices();
    if (!voices.length) {
      return {
        supported: true,
        canSpeak: true,
        voicesAvailable: false,
        voiceCount: 0,
        message: '시스템 TTS는 지원되지만 음성 목록을 읽지 못했습니다. 기본 음성으로 재생을 시도합니다.',
      };
    }

    return {
      supported: true,
      canSpeak: true,
      voicesAvailable: true,
      voiceCount: voices.length,
      message: `사용 가능한 시스템 음성 ${voices.length}개를 불러왔습니다.`,
    };
  }

  async listVoices(): Promise<TTSVoice[]> {
    const voices = await loadVoices();
    return voices.map((voice) => ({
      id: voice.voiceURI,
      label: `${voice.name} (${voice.lang})`,
      lang: voice.lang,
      nativeVoice: voice,
    }));
  }

  async speak(input: SpeakInput): Promise<void> {
    const generation = this.generation + 1;
    this.generation = generation;
    const synthesis = getSpeechSynthesis();
    const Utterance = getUtteranceConstructor();
    if (!synthesis || !Utterance) {
      input.onError?.('이 환경에서는 시스템 TTS를 사용할 수 없습니다.');
      return;
    }

    if (!input.text.trim()) {
      input.onEnd?.();
      return;
    }

    const voices = await loadVoices();
    if (generation !== this.generation) return;
    const utterance = new Utterance(input.text);
    utterance.rate = input.rate;
    utterance.pitch = input.pitch ?? 1;
    utterance.volume = input.volume ?? 1;
    utterance.lang = 'ko-KR';
    utterance.voice =
      voices.find((voice) => voice.voiceURI === input.voiceURI) ??
      voices.find((voice) => voice.lang.toLowerCase().startsWith('ko')) ??
      null;
    utterance.onstart = () => input.onStart?.();
    utterance.onend = () => input.onEnd?.();
    utterance.onerror = (event) => input.onError?.(systemSpeechErrorMessage(event.error));

    synthesis.cancel();
    synthesis.speak(utterance);
  }

  pause(): void {
    getSpeechSynthesis()?.pause();
  }

  resume(): void {
    getSpeechSynthesis()?.resume();
  }

  stop(): void {
    this.generation += 1;
    getSpeechSynthesis()?.cancel();
  }
}
