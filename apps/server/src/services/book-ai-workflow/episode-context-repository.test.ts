import { describe, expect, it } from 'vitest';
import type { ChapterLabelingResult } from '../../../../../src/providers/ai';
import { episodeContextFromResult } from './episode-context-repository.js';

describe('episodeContextFromResult', () => {
  it('persists scene continuity, recent dialogue turns, interlocutors, and correction cursor', () => {
    const result: ChapterLabelingResult = {
      characters: [],
      segments: [
        {
          id: 'segment_1',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          paragraphId: 'paragraph_1',
          segmentIndex: 0,
          startOffset: 0,
          endOffset: 6,
          segmentTextHash: 'hash_1',
          type: 'quoted_dialogue',
          speakerId: 'char_a',
          candidateSpeakers: [],
          listenerIds: ['char_b'],
          emotion: 'tense',
          confidence: 0.9,
          isUserCorrected: false,
        },
        {
          id: 'segment_2',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          paragraphId: 'paragraph_1',
          segmentIndex: 1,
          startOffset: 6,
          endOffset: 15,
          segmentTextHash: 'hash_2',
          type: 'narration',
          speakerId: 'narrator',
          candidateSpeakers: [],
          listenerIds: [],
          emotion: 'neutral',
          confidence: 1,
          isUserCorrected: false,
        },
      ],
      episodeContextSummary: {
        chapterId: 'chapter_1',
        scene: '회의실',
        activeCharacterIds: ['char_a', 'char_b'],
        unresolved: ['문밖의 인물'],
        summaryForNextChapter: 'char_a와 char_b가 회의실에서 대치한다.',
      },
    };

    const context = episodeContextFromResult('chapter_1', result, {
      paragraphs: [
        {
          id: 'paragraph_1',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          index: 0,
          text: '지금 말해. 두 사람은 멈췄다.',
          startOffsetInChapter: 0,
          endOffsetInChapter: 18,
          textHash: 'paragraph_hash',
        },
      ],
      correctionMemoryCursor: '2026-07-11T00:00:00.000Z',
      sourceWindowId: 'window_1',
      sourceArtifactId: 'artifact_1',
    });

    expect(context).toMatchObject({
      version: 'episode-context-v2',
      scene: '회의실',
      correctionMemoryCursor: '2026-07-11T00:00:00.000Z',
      sourceWindowId: 'window_1',
      sourceArtifactId: 'artifact_1',
      unresolvedReferences: ['문밖의 인물'],
      recentTurns: [
        {
          paragraphId: 'paragraph_1',
          speakerId: 'char_a',
          listenerIds: ['char_b'],
          emotion: 'tense',
          text: '지금 말해.',
        },
      ],
      interlocutorEdges: [{ sourceCharacterId: 'char_a', targetCharacterId: 'char_b' }],
    });
  });

  it('builds deterministic continuity for compact speaker-only results without a free-form summary', () => {
    const result: ChapterLabelingResult = {
      characters: [],
      segments: [
        {
          id: 'segment_2',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          paragraphId: 'paragraph_2',
          segmentIndex: 0,
          startOffset: 0,
          endOffset: 7,
          segmentTextHash: 'hash_2',
          type: 'quoted_dialogue',
          speakerId: 'char_b',
          candidateSpeakers: ['char_a'],
          listenerIds: ['char_a'],
          emotion: 'neutral',
          confidence: 0.82,
          isUserCorrected: false,
        },
      ],
      uncertainties: [
        {
          paragraphId: 'paragraph_2',
          startOffset: 0,
          endOffset: 7,
          reasonCode: 'speaker_review_required',
          candidateIds: ['char_a', 'char_b'],
        },
      ],
    };

    const context = episodeContextFromResult('chapter_1', result, {
      speakerOnly: true,
      previousContext: {
        chapterId: 'chapter_1',
        summary: '기존 장면 요약',
        scene: '복도',
        activeCharacterIds: ['char_a'],
        unresolved: ['earlier_unknown'],
        recentTurns: [
          {
            paragraphId: 'paragraph_1',
            speakerId: 'char_a',
            listenerIds: ['char_b'],
            emotion: 'neutral',
            text: '먼저 가자.',
          },
        ],
      },
      paragraphs: [
        {
          id: 'paragraph_2',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          index: 1,
          text: '잠깐 기다려.',
          startOffsetInChapter: 10,
          endOffsetInChapter: 18,
          textHash: 'paragraph_hash_2',
        },
      ],
      sourceWindowId: 'window_2',
      sourceArtifactId: 'artifact_2',
    });

    expect(context).toMatchObject({
      version: 'episode-context-v2',
      summary: '기존 장면 요약',
      scene: '복도',
      activeCharacterIds: ['char_a', 'char_b'],
      unresolved: ['earlier_unknown', 'speaker_review_required'],
      sourceWindowId: 'window_2',
      sourceArtifactId: 'artifact_2',
      recentTurns: [
        expect.objectContaining({ paragraphId: 'paragraph_1', speakerId: 'char_a' }),
        expect.objectContaining({ paragraphId: 'paragraph_2', speakerId: 'char_b', text: '잠깐 기다려.' }),
      ],
      interlocutorEdges: [
        { sourceCharacterId: 'char_a', targetCharacterId: 'char_b' },
        { sourceCharacterId: 'char_b', targetCharacterId: 'char_a' },
      ],
    });
  });

  it('does not invent an Episode Context for legacy rich output without a summary', () => {
    expect(episodeContextFromResult('chapter_1', { characters: [], segments: [] })).toBeUndefined();
  });
});
