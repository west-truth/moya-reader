import { describe, expect, it, vi } from 'vitest';
import type { LabeledSegment, VoiceProfile } from '../../../domain/types';
import type { BookAIWorkflowPlan } from '../../../providers/book-ai-workflow-plan';
import { evaluateNativeTTSReadiness } from './native-tts-readiness';

const plan: BookAIWorkflowPlan = {
  novelId: 'book-1',
  totalChapters: 1,
  totalCharacters: 10,
  stages: [],
  bundleWindows: [],
  labelingChapters: [],
  labelingWindows: [
    {
      id: 'window-1',
      sequence: 0,
      chapterId: 'chapter-1',
      chapterIndex: 1,
      paragraphIds: ['p1', 'p2'],
      startParagraphIndex: 1,
      endParagraphIndex: 2,
      characterCount: 10,
      textHashFingerprint: 'hash',
      dependsOnGraph: true,
    },
  ],
  ttsReady: { chapterIds: ['chapter-1'], dependsOnLabelingWindowIds: ['window-1'] },
};

function segment(paragraphId: string, speakerId: string): LabeledSegment {
  return {
    id: `segment-${paragraphId}`,
    novelId: 'book-1',
    chapterId: 'chapter-1',
    paragraphId,
    segmentIndex: 0,
    startOffset: 0,
    endOffset: 1,
    segmentTextHash: 'hash',
    type: 'quoted_dialogue',
    speakerId,
    candidateSpeakers: [],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 1,
    isUserCorrected: false,
  };
}

function voice(characterId: string): VoiceProfile {
  return {
    id: `voice-${characterId}`,
    novelId: 'book-1',
    characterId,
    role: 'character',
    providerId: 'openai-tts',
    providerVoiceId: 'alloy',
    label: characterId,
    speed: 1,
    isUserSelected: true,
  };
}

describe('evaluateNativeTTSReadiness', () => {
  it('returns ready only when planned labels and character voices are complete', async () => {
    const repository = {
      listSegments: vi.fn(async () => [segment('p1', 'character-1'), segment('p2', 'narrator')]),
      listVoiceProfiles: vi.fn(async () => [voice('character-1')]),
    };

    await expect(evaluateNativeTTSReadiness({ novelId: 'book-1', plan, repository })).resolves.toMatchObject({
      outcome: 'ready_for_tts',
      reviewItems: [],
      metrics: { missingPlannedParagraphCount: 0, missingCharacterVoiceProfileCount: 0 },
    });
  });

  it('reports bounded missing labels, voices, and excessive unknown speakers', async () => {
    const repository = {
      listSegments: vi.fn(async () => [segment('p1', 'unknown'), segment('extra', 'character-2')]),
      listVoiceProfiles: vi.fn(async () => []),
    };

    const result = await evaluateNativeTTSReadiness({ novelId: 'book-1', plan, repository });

    expect(result.outcome).toBe('needs_review');
    expect(result.reviewItems.map((item) => item.kind)).toEqual([
      'missing_paragraph_labels',
      'missing_voice_profiles',
      'high_unknown_speaker_ratio',
    ]);
    expect(result.missingPlannedParagraphIds).toEqual(['p2']);
    expect(result.missingCharacterVoiceSpeakerIds).toEqual(['character-2']);
  });
});
