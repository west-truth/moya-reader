import { describe, expect, it } from 'vitest';
import type { VoiceProfile } from '../domain/types';
import { emptyVoiceProductState, updatePronunciationProfile } from './voice-product';
import {
  buildTTSRenderPlanV2,
  inspectTTSAudioIntegrity,
  probeTTSAudioContainer,
  projectAppliedTTSControls,
  retryableTTSRenderItemIds,
  summarizeTTSLifecycle,
} from './tts-lifecycle-v2';
import { resolveTTSCapabilitySnapshot } from './provider-capability';

const profile: VoiceProfile = {
  id: 'voice',
  novelId: 'book',
  characterId: 'character',
  role: 'character',
  providerId: 'openai-tts',
  providerVoiceId: 'alloy',
  label: 'Voice',
  speed: 1.1,
  pitch: 2,
  tone: 'warm',
  isUserSelected: true,
};
const capability = resolveTTSCapabilitySnapshot({
  providerId: 'openai-tts',
  modelId: 'tts',
  providerOptions: { maxInputCharacters: 8, supportedControls: ['voice', 'speed'] },
});
const pronunciation = updatePronunciationProfile(emptyVoiceProductState('book'), [
  {
    id: 'rule',
    sourceTerm: 'AI',
    replacement: '에이아이',
    mode: 'literal',
    userConfirmed: true,
    provenance: 'user',
    enabled: true,
  },
]).pronunciationProfile;

describe('TTS lifecycle v2', () => {
  it('falls back low-confidence emotion and records unsupported controls', () => {
    const controls = projectAppliedTTSControls({
      segment: { emotion: 'angry', confidence: 0.4 },
      voiceProfile: profile,
      capability,
    });
    expect(controls.emotion).toBe('neutral');
    expect(controls.pitch).toBeUndefined();
    expect(controls.ignored.map((item) => item.control)).toEqual(['pitch', 'tone']);
  });

  it('splits within exact source segments before provider limits and fingerprints pronunciation', () => {
    const plan = buildTTSRenderPlanV2({
      novelId: 'book',
      chapterId: 'chapter',
      capability,
      pronunciationProfile: pronunciation,
      sources: [
        {
          segmentId: 'segment',
          paragraphId: 'paragraph',
          startOffset: 10,
          endOffset: 22,
          textHash: 'hash',
          text: 'AI가 말했다.',
          speakerId: 'character',
          segment: { emotion: 'neutral', confidence: 1 },
          voiceProfile: profile,
          voiceEntryFingerprint: 'entry',
        },
      ],
    });
    expect(plan.items.length).toBeGreaterThan(1);
    expect(plan.items.every((item) => item.alignmentMode === 'exact_segment')).toBe(true);
    expect(plan.items.at(-1)?.sourceSegments[0].endOffset).toBe(10 + 'AI가 말했다.'.length);
    expect(plan.items.every((item) => item.estimated.inputBytes <= (capability.maxTextBytes ?? Infinity))).toBe(true);
    expect(plan.items[0].pronunciationFingerprint).toMatch(/^sha256:/);
  });

  it('retries only failed, missing, stale, and corrupt current items', () => {
    const plan = buildTTSRenderPlanV2({
      novelId: 'book',
      chapterId: 'chapter',
      capability: resolveTTSCapabilitySnapshot({
        providerId: 'openai-tts',
        providerOptions: { maxInputCharacters: 100 },
      }),
      pronunciationProfile: pronunciation,
      sources: [
        {
          segmentId: 'segment',
          paragraphId: 'paragraph',
          startOffset: 0,
          endOffset: 2,
          textHash: 'hash',
          text: '대사',
          speakerId: 'character',
          segment: { emotion: 'neutral', confidence: 1 },
          voiceProfile: profile,
          voiceEntryFingerprint: 'entry',
        },
      ],
    });
    const item = plan.items[0];
    const snapshot = summarizeTTSLifecycle({
      plan,
      items: [
        { renderItemId: item.renderItemId, renderFingerprint: item.renderFingerprint, status: 'stale' },
        { renderItemId: 'old', renderFingerprint: 'old', status: 'failed' },
      ],
    });
    expect(snapshot.state).toBe('failed_retryable');
    expect(retryableTTSRenderItemIds(snapshot)).toEqual([item.renderItemId]);
  });

  it('quarantines corrupt or implausible audio', () => {
    const plan = buildTTSRenderPlanV2({
      novelId: 'book',
      chapterId: 'chapter',
      capability: resolveTTSCapabilitySnapshot({ providerId: 'openai-tts', providerOptions: {} }),
      pronunciationProfile: pronunciation,
      sources: [
        {
          segmentId: 'segment',
          paragraphId: 'paragraph',
          startOffset: 0,
          endOffset: 2,
          textHash: 'hash',
          text: '대사',
          speakerId: 'character',
          segment: { emotion: 'neutral', confidence: 1 },
          voiceProfile: profile,
          voiceEntryFingerprint: 'entry',
        },
      ],
    });
    expect(
      inspectTTSAudioIntegrity({
        renderItem: plan.items[0],
        objectExists: true,
        actualByteSize: 0,
        contentType: 'text/plain',
        codecSupported: false,
      }).state,
    ).toBe('quarantined');
    expect(probeTTSAudioContainer(Uint8Array.from([0x49, 0x44, 0x33, 0x04]), 'audio/mpeg').ok).toBe(true);
    expect(probeTTSAudioContainer(Uint8Array.from([1, 2, 3]), 'audio/mpeg').reason).toBe('codec_container_mismatch');
  });
});
