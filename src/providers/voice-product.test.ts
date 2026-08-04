import { describe, expect, it } from 'vitest';
import type { VoiceProfile } from '../domain/types';
import {
  approveVoiceSamples,
  buildAutomaticVoiceDraft,
  buildVoiceCatalogSnapshot,
  buildVoiceSampleRequest,
  canWarmMajorVoice,
  emptyVoiceProductState,
  projectPronunciation,
  replaceCatalogSnapshot,
  updatePronunciationProfile,
  voiceDraftTargets,
} from './voice-product';

const voices = [
  { id: 'voice-a', label: 'Voice A', lang: 'ko-KR' },
  { id: 'voice-b', label: 'Voice B', lang: 'ko-KR' },
  { id: 'voice-c', label: 'Voice C', lang: 'ko-KR' },
  { id: 'voice-d', label: 'Voice D', lang: 'ko-KR' },
  { id: 'voice-e', label: 'Voice E', lang: 'ko-KR' },
  { id: 'voice-f', label: 'Voice F', lang: 'ko-KR' },
];

describe('voice product', () => {
  it('preserves user selected profiles and rotates major voices deterministically', () => {
    const snapshot = buildVoiceCatalogSnapshot({ novelId: 'book', providerId: 'system', voices });
    const selected: VoiceProfile = {
      id: 'selected',
      novelId: 'book',
      characterId: 'a',
      role: 'character',
      providerId: 'system',
      providerVoiceId: 'voice-b',
      label: 'A',
      speed: 1,
      isUserSelected: true,
    };
    const targets = voiceDraftTargets({
      characters: [
        {
          id: 'a',
          novelId: 'book',
          canonicalName: 'A',
          aliases: [],
          color: '#000',
          confidence: 1,
          isUserConfirmed: true,
        },
        {
          id: 'b',
          novelId: 'book',
          canonicalName: 'B',
          aliases: [],
          color: '#111',
          confidence: 1,
          isUserConfirmed: true,
        },
      ],
      segments: [
        {
          id: 's',
          novelId: 'book',
          chapterId: 'c',
          paragraphId: 'p',
          segmentIndex: 0,
          startOffset: 0,
          endOffset: 20,
          segmentTextHash: 'h',
          type: 'quoted_dialogue',
          speakerId: 'b',
          candidateSpeakers: [],
          listenerIds: [],
          emotion: 'neutral',
          confidence: 1,
          isUserCorrected: false,
        },
      ],
      majorCharacterLimit: 1,
      pinnedCharacterIds: ['a'],
    });
    const draft = buildAutomaticVoiceDraft({
      novelId: 'book',
      snapshot,
      targets,
      existingProfiles: [selected],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(draft.profiles.find((profile) => profile.id === 'selected')?.providerVoiceId).toBe('voice-b');
    expect(draft.profiles.find((profile) => profile.characterId === 'b')?.providerVoiceId).not.toBe('voice-b');
  });

  it('invalidates only approvals whose selected entry or pronunciation revision changed', () => {
    const snapshot = buildVoiceCatalogSnapshot({ novelId: 'book', providerId: 'system', voices });
    let state = replaceCatalogSnapshot(emptyVoiceProductState('book'), snapshot);
    const profile: VoiceProfile = {
      id: 'profile',
      novelId: 'book',
      role: 'narrator',
      providerId: 'system',
      providerVoiceId: 'voice-a',
      label: 'Narrator',
      speed: 1,
      isUserSelected: true,
    };
    const request = buildVoiceSampleRequest({
      state,
      profile,
      kind: 'neutral',
      text: '안녕하세요.',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    state = { ...state, sampleRequests: [request] };
    const approval = approveVoiceSamples({
      state,
      profile,
      decision: 'approved',
      approvedAt: '2026-01-01T00:00:01.000Z',
    });
    state = { ...state, approvals: [approval] };
    expect(canWarmMajorVoice(state, profile, true)).toBe(true);
    const unrelated = buildVoiceCatalogSnapshot({
      novelId: 'book',
      providerId: 'other',
      voices: [{ id: 'x', label: 'X', lang: 'ko-KR' }],
    });
    expect(canWarmMajorVoice(replaceCatalogSnapshot(state, unrelated), profile, true)).toBe(true);
    state = updatePronunciationProfile(state, [
      {
        id: 'r',
        sourceTerm: 'A',
        replacement: '에이',
        mode: 'literal',
        userConfirmed: true,
        provenance: 'user',
        enabled: true,
      },
    ]);
    expect(canWarmMajorVoice(state, profile, true)).toBe(false);
  });

  it('projects literal pronunciation without changing source text', () => {
    const state = updatePronunciationProfile(emptyVoiceProductState('book'), [
      {
        id: 'r',
        sourceTerm: 'AI',
        replacement: '에이아이',
        mode: 'literal',
        userConfirmed: true,
        provenance: 'user',
        enabled: true,
      },
    ]);
    const source = 'AI 소설';
    const projected = projectPronunciation({ text: source, profile: state.pronunciationProfile });
    expect(source).toBe('AI 소설');
    expect(projected.text).toBe('에이아이 소설');
    expect(projected.appliedRuleIds).toEqual(['r']);
  });

  it('keeps automatic drafts inside the preferred locale when matching voices exist', () => {
    const snapshot = buildVoiceCatalogSnapshot({
      novelId: 'book',
      providerId: 'system',
      voices: [
        { id: 'english', label: 'English', lang: 'en-US' },
        { id: 'korean', label: 'Korean', lang: 'ko-KR' },
      ],
    });
    const result = buildAutomaticVoiceDraft({
      novelId: 'book',
      snapshot,
      targets: [{ key: 'role:narrator', role: 'narrator', label: 'Narrator', major: true, spokenCharacters: 0 }],
      existingProfiles: [],
      preferredLocale: 'ko-KR',
    });
    expect(result.profiles[0].providerVoiceId).toBe('korean');
  });
});
