import { describe, expect, it } from 'vitest';
import type { LabelChapterSegmentsInput } from '../../../providers/ai';
import { resolveNativeLabelingContract } from './labeling-contract';
import { parseNativeLabelingCheckpoint } from './native-workflow-dependencies';

const labelingInput: LabelChapterSegmentsInput = {
  novelId: 'book_1',
  windowId: 'window_1',
  inputRevisionId: 'workflow_1:window_1',
  chapter: {
    id: 'chapter_1',
    novelId: 'book_1',
    index: 0,
    title: '1화',
    normalizedText: '',
    textHash: 'chapter_hash',
    rawStartOffset: 0,
    rawEndOffset: 4,
    characterCount: 4,
    paragraphCount: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  },
  paragraphs: [
    {
      id: 'paragraph_1',
      novelId: 'book_1',
      chapterId: 'chapter_1',
      index: 0,
      text: '안녕!',
      startOffsetInChapter: 0,
      endOffsetInChapter: 3,
      textHash: 'paragraph_hash',
    },
  ],
  knownCharacters: [
    {
      id: 'char_a',
      novelId: 'book_1',
      canonicalName: 'A',
      aliases: [],
      color: '#111111',
      description: '',
      confidence: 1,
      isUserConfirmed: true,
    },
  ],
  previousEpisodeContext: {
    chapterId: 'chapter_0',
    summary: '이전 장면',
    activeCharacterIds: [],
    unresolved: ['문밖의 사람'],
  },
};

describe('native workflow labeling checkpoint parsing', () => {
  it('uses the pinned v2 profile and reconstructs context delta after restart', () => {
    const result = parseNativeLabelingCheckpoint({
      providerOptions: {},
      labelingInput,
      output: {
        schema_version: 'chapter-labeling-v2',
        chapter_id: 'chapter_1',
        window_id: 'window_1',
        input_revision_id: 'workflow_1:window_1',
        paragraph_results: [
          {
            paragraph_id: 'paragraph_1',
            coverage_complete: true,
            segments: [
              {
                start_offset: 0,
                end_offset: 3,
                type: 'quoted_dialogue',
                speaker_id: 'char_a',
                candidate_speakers: [],
                listener_ids: [],
                emotion: 'happy',
                confidence: 0.9,
                evidence_codes: ['explicit_turn'],
              },
            ],
          },
        ],
        context_delta: {
          summary: '인사를 했다.',
          location: '복도',
          active_add: ['char_a'],
          active_remove: [],
          interlocutor_upserts: [],
          unresolved_add: [],
          unresolved_resolve: ['문밖의 사람'],
        },
        uncertainties: [],
      },
    });

    expect(result.segments[0]).toMatchObject({ speakerId: 'char_a', emotion: 'happy' });
    expect(result.segmentAnnotations?.[result.segments[0].id]).toEqual({
      evidenceCodes: ['explicit_turn'],
      prosodyIntent: undefined,
    });
    expect(result.episodeContextSummary).toMatchObject({
      scene: '복도',
      activeCharacterIds: ['char_a'],
      unresolved: [],
    });
  });

  it('retains explicit v1 checkpoint compatibility', () => {
    const result = parseNativeLabelingCheckpoint({
      providerOptions: {
        requestProfileId: 'speaker-attribution-v3-compact',
        compactSpeakerAttributionV3: true,
      },
      labelingContract: resolveNativeLabelingContract({ requestProfileId: 'chapter-labeling-v1' }),
      labelingInput,
      output: {
        chapter_id: 'chapter_1',
        analysis_version: 1,
        segments: [
          {
            paragraph_id: 'paragraph_1',
            start_offset: 0,
            end_offset: 3,
            type: 'quoted_dialogue',
            speaker_id: 'char_a',
            candidate_speakers: [],
            listener_ids: [],
            emotion: 'happy',
            confidence: 0.9,
            evidence: 'explicit turn',
          },
        ],
      },
    });

    expect(result.segments[0].speakerId).toBe('char_a');
  });
});
