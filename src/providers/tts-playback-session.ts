import type { Paragraph, VoiceProfile } from '../domain/types';
import type { SpeakInput } from './tts';
import type { PlayableTtsSegment } from './tts-playback';
import { clamp } from '../utils/format';

export type TTSPlaybackSessionPhase =
  'idle' | 'queued' | 'resolving' | 'synthesizing' | 'buffering' | 'playing' | 'fallback' | 'paused' | 'error';

export interface ActiveTTSPlayback {
  readonly paragraphId: string;
  readonly speakerLabel: string;
  readonly segmentIds: string[];
  readonly ranges: Array<{
    readonly start: number;
    readonly end: number;
  }>;
}

export interface TTSPlaybackSessionState {
  readonly sessionId: number;
  readonly phase: TTSPlaybackSessionPhase;
  readonly paragraphIndex?: number;
  readonly playableIndex?: number;
  readonly message?: string;
}

export interface BuildActiveTTSPlaybackInput {
  readonly paragraph: Paragraph;
  readonly playable: PlayableTtsSegment;
}

export interface SelectHostedTTSPrefetchTargetInput {
  readonly currentParagraph: Paragraph;
  readonly currentPlayableIndex: number;
  readonly currentPlayableSegments: PlayableTtsSegment[];
  readonly nextParagraph?: Paragraph;
  readonly nextPlayableSegments?: PlayableTtsSegment[];
}

export interface HostedTTSPrefetchTarget {
  readonly paragraph: Paragraph;
  readonly playable: PlayableTtsSegment;
}

export interface HostedTTSAdaptivePrefetchInput {
  readonly averageResolveLatencyMs?: number;
  readonly currentItemDurationMs: number;
  readonly consecutiveFailures?: number;
  readonly cacheCapacity?: number;
}

export interface PlaybackVoiceProfilesInput {
  readonly hostedReady: boolean;
  readonly hostedVoiceProfiles: VoiceProfile[];
  readonly systemVoiceProfiles: VoiceProfile[];
}

export interface SystemTTSFallbackInput {
  readonly playable: PlayableTtsSegment;
  readonly systemVoiceProfiles: VoiceProfile[];
  readonly fallbackVoiceURI?: string;
  readonly baseRate: number;
  readonly pitch?: number;
  readonly volume?: number;
}

function roleForSpeaker(speakerId: string): VoiceProfile['role'] {
  if (speakerId === 'narrator') return 'narrator';
  if (speakerId === 'system') return 'system';
  if (speakerId === 'unknown') return 'unknown';
  return 'character';
}

export function createTTSPlaybackSessionState(sessionId: number): TTSPlaybackSessionState {
  return { sessionId, phase: 'queued' };
}

export function updateTTSPlaybackSessionPhase(
  state: TTSPlaybackSessionState,
  phase: TTSPlaybackSessionPhase,
  patch: Omit<Partial<TTSPlaybackSessionState>, 'sessionId' | 'phase'> = {},
): TTSPlaybackSessionState {
  return {
    ...state,
    ...patch,
    phase,
  };
}

export function playbackVoiceProfilesForSession(input: PlaybackVoiceProfilesInput): VoiceProfile[] {
  return input.hostedReady ? [...input.hostedVoiceProfiles, ...input.systemVoiceProfiles] : input.systemVoiceProfiles;
}

export function buildActiveTTSPlayback(input: BuildActiveTTSPlaybackInput): ActiveTTSPlayback {
  return {
    paragraphId: input.paragraph.id,
    speakerLabel: input.playable.speakerLabel,
    segmentIds: input.playable.sourceSegmentIds,
    ranges: input.playable.sourceRanges
      .filter((range) => range.paragraphId === input.paragraph.id)
      .map((range) => ({ start: range.startOffset, end: range.endOffset })),
  };
}

export function selectHostedTTSPrefetchTarget(
  input: SelectHostedTTSPrefetchTargetInput,
): HostedTTSPrefetchTarget | undefined {
  const nextInParagraph = input.currentPlayableSegments[input.currentPlayableIndex + 1];
  if (nextInParagraph) {
    return {
      paragraph: input.currentParagraph,
      playable: nextInParagraph,
    };
  }
  const nextParagraphPlayable = input.nextPlayableSegments?.[0];
  if (!input.nextParagraph || !nextParagraphPlayable) return undefined;
  return {
    paragraph: input.nextParagraph,
    playable: nextParagraphPlayable,
  };
}

export function estimatePlayableDurationMs(playable: PlayableTtsSegment): number {
  const charactersPerSecond = Math.max(4, 9 * Math.max(0.25, playable.rate));
  return Math.max(1_500, Math.min(30_000, (playable.text.trim().length / charactersPerSecond) * 1_000));
}

export function adaptiveHostedTTSPrefetchDepth(input: HostedTTSAdaptivePrefetchInput): number {
  const capacity = Math.max(1, Math.min(4, Math.floor(input.cacheCapacity ?? 4)));
  if ((input.consecutiveFailures ?? 0) >= 2) return 1;
  const latency = Math.max(0, input.averageResolveLatencyMs ?? 0);
  const duration = Math.max(500, input.currentItemDurationMs);
  const requested = latency >= duration * 1.4 ? 3 : latency >= duration * 0.65 ? 2 : 1;
  return Math.min(capacity, requested);
}

export function systemVoiceProfileForSpeaker(
  speakerId: string,
  systemVoiceProfiles: VoiceProfile[],
  language?: string,
): VoiceProfile | undefined {
  const role = roleForSpeaker(speakerId);
  const candidates = systemVoiceProfiles.filter(
    (profile) =>
      profile.role === role && (role === 'character' ? profile.characterId === speakerId : !profile.characterId),
  );
  const locale = language?.toLowerCase();
  if (locale) {
    const languageMatch = candidates.find((profile) => {
      const profileLocale = profile.language?.toLowerCase();
      return profileLocale === locale || profileLocale?.split('-')[0] === locale.split('-')[0];
    });
    if (languageMatch) return languageMatch;
  }
  return candidates[0];
}

export function buildSystemTTSFallbackInput(
  input: SystemTTSFallbackInput,
): Pick<SpeakInput, 'text' | 'rate' | 'pitch' | 'volume' | 'voiceURI'> {
  const profile = systemVoiceProfileForSpeaker(
    input.playable.speakerId,
    input.systemVoiceProfiles,
    input.playable.language,
  );
  return {
    text: input.playable.text,
    rate: clamp(input.baseRate * (profile?.speed ?? 1), 0.25, 4),
    voiceURI: profile?.providerVoiceId ?? input.fallbackVoiceURI,
    ...(input.pitch === undefined ? undefined : { pitch: input.pitch }),
    ...(input.volume === undefined ? undefined : { volume: input.volume }),
  };
}
