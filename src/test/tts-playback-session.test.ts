import { describe, expect, it } from 'vitest';
import type { Paragraph, VoiceProfile } from '../domain/types';
import type { PlayableTtsSegment } from '../providers/tts-playback';
import {
  adaptiveHostedTTSPrefetchDepth,
  buildActiveTTSPlayback,
  buildSystemTTSFallbackInput,
  createTTSPlaybackSessionState,
  estimatePlayableDurationMs,
  playbackVoiceProfilesForSession,
  selectHostedTTSPrefetchTarget,
  updateTTSPlaybackSessionPhase,
} from '../providers/tts-playback-session';

const paragraph: Paragraph = {
  id: 'paragraph_1',
  novelId: 'book_1',
  chapterId: 'chapter_1',
  index: 0,
  text: 'First. Second.',
  startOffsetInChapter: 0,
  endOffsetInChapter: 14,
  textHash: 'paragraph_hash',
};

function playable(patch: Partial<PlayableTtsSegment> = {}): PlayableTtsSegment {
  return {
    paragraphId: paragraph.id,
    text: 'First.',
    speakerId: 'char_1',
    speakerLabel: 'Character One',
    emotion: 'neutral',
    rate: 1,
    sourceSegmentIds: ['seg_1'],
    sourceRanges: [
      {
        segmentId: 'seg_1',
        paragraphId: paragraph.id,
        startOffset: 0,
        endOffset: 6,
      },
    ],
    ...patch,
  };
}

function voiceProfile(patch: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    id: 'voice_1',
    novelId: 'book_1',
    role: 'character',
    characterId: 'char_1',
    providerId: 'system',
    providerVoiceId: 'voice-character',
    label: 'Character voice',
    speed: 1.2,
    providerOptions: {},
    isUserSelected: true,
    ...patch,
  };
}

describe('tts playback session helpers', () => {
  it('creates typed session phase state without touching browser audio APIs', () => {
    const queued = createTTSPlaybackSessionState(12);
    expect(queued).toEqual({ sessionId: 12, phase: 'queued' });

    expect(
      updateTTSPlaybackSessionPhase(queued, 'playing', {
        paragraphIndex: 3,
        playableIndex: 1,
      }),
    ).toEqual({
      sessionId: 12,
      phase: 'playing',
      paragraphIndex: 3,
      playableIndex: 1,
    });
  });

  it('builds active highlight ranges only for the current paragraph', () => {
    expect(
      buildActiveTTSPlayback({
        paragraph,
        playable: playable({
          sourceSegmentIds: ['seg_1', 'seg_other'],
          sourceRanges: [
            { segmentId: 'seg_1', paragraphId: paragraph.id, startOffset: 0, endOffset: 6 },
            { segmentId: 'seg_other', paragraphId: 'paragraph_2', startOffset: 0, endOffset: 4 },
          ],
        }),
      }),
    ).toEqual({
      paragraphId: 'paragraph_1',
      speakerLabel: 'Character One',
      segmentIds: ['seg_1', 'seg_other'],
      ranges: [{ start: 0, end: 6 }],
    });
  });

  it('selects the next playable in the paragraph before falling through to the next paragraph', () => {
    const currentSegments = [
      playable({ text: 'First.', sourceSegmentIds: ['seg_1'] }),
      playable({ text: 'Second.', sourceSegmentIds: ['seg_2'] }),
    ];
    expect(
      selectHostedTTSPrefetchTarget({
        currentParagraph: paragraph,
        currentPlayableIndex: 0,
        currentPlayableSegments: currentSegments,
      }),
    ).toEqual({
      paragraph,
      playable: currentSegments[1],
    });

    const nextParagraph = { ...paragraph, id: 'paragraph_2', index: 1 };
    const nextPlayable = playable({ paragraphId: nextParagraph.id, text: 'Next.', sourceSegmentIds: ['seg_3'] });
    expect(
      selectHostedTTSPrefetchTarget({
        currentParagraph: paragraph,
        currentPlayableIndex: 1,
        currentPlayableSegments: currentSegments,
        nextParagraph,
        nextPlayableSegments: [nextPlayable],
      }),
    ).toEqual({
      paragraph: nextParagraph,
      playable: nextPlayable,
    });
  });

  it('adapts bounded prefetch depth to latency and backs off after repeated failures', () => {
    const itemDuration = estimatePlayableDurationMs(
      playable({ text: '충분히 긴 다음 문장을 미리 준비합니다.', rate: 1 }),
    );
    expect(adaptiveHostedTTSPrefetchDepth({ currentItemDurationMs: itemDuration, averageResolveLatencyMs: 0 })).toBe(1);
    expect(
      adaptiveHostedTTSPrefetchDepth({
        currentItemDurationMs: itemDuration,
        averageResolveLatencyMs: itemDuration,
      }),
    ).toBe(2);
    expect(
      adaptiveHostedTTSPrefetchDepth({
        currentItemDurationMs: itemDuration,
        averageResolveLatencyMs: itemDuration * 2,
      }),
    ).toBe(3);
    expect(
      adaptiveHostedTTSPrefetchDepth({
        currentItemDurationMs: itemDuration,
        averageResolveLatencyMs: itemDuration * 2,
        consecutiveFailures: 2,
      }),
    ).toBe(1);
  });

  it('combines hosted and system profiles only when hosted playback is ready', () => {
    const hosted = voiceProfile({ id: 'hosted_voice', providerId: 'openai-tts', providerVoiceId: 'alloy' });
    const system = voiceProfile({ id: 'system_voice' });

    expect(
      playbackVoiceProfilesForSession({
        hostedReady: false,
        hostedVoiceProfiles: [hosted],
        systemVoiceProfiles: [system],
      }),
    ).toEqual([system]);

    expect(
      playbackVoiceProfilesForSession({
        hostedReady: true,
        hostedVoiceProfiles: [hosted],
        systemVoiceProfiles: [system],
      }),
    ).toEqual([hosted, system]);
  });

  it('builds system fallback speech input from speaker-specific voice profiles', () => {
    const characterFallback = buildSystemTTSFallbackInput({
      playable: playable({ speakerId: 'char_1', text: 'Line.' }),
      systemVoiceProfiles: [voiceProfile({ speed: 1.5 })],
      fallbackVoiceURI: 'fallback-voice',
      baseRate: 1.2,
    });
    expect(characterFallback.text).toBe('Line.');
    expect(characterFallback.voiceURI).toBe('voice-character');
    expect(characterFallback.rate).toBeCloseTo(1.8);

    expect(
      buildSystemTTSFallbackInput({
        playable: playable({ speakerId: 'char_missing', text: 'Line.' }),
        systemVoiceProfiles: [voiceProfile()],
        fallbackVoiceURI: 'fallback-voice',
        baseRate: 5,
      }),
    ).toEqual({
      text: 'Line.',
      rate: 4,
      voiceURI: 'fallback-voice',
    });
  });
});
