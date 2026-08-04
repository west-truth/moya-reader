import { describe, expect, it } from 'vitest';
import type { Chapter, Character, LabeledSegment, Paragraph, UserCorrection } from '../domain/types';
import { hashSync } from '../domain/hash';
import type { CharacterGraph, ChapterLabelingResult, RepairChapterLabelsInput } from '../providers/ai';
import {
  buildChapterLabelRepairRequest,
  CHAPTER_LABEL_REPAIR_PROMPT_VERSION,
  DEFAULT_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
  LEGACY_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
  listChapterLabelRepairRequestProfileConfigs,
  providerApiOptionsForChapterLabelRepair,
  resolveChapterLabelRepairRequestProfile,
} from '../providers/chapter-label-repair-request-profile';

const chapter: Chapter = {
  id: 'chapter_1',
  novelId: 'book_1',
  index: 0,
  title: 'Chapter 1',
  normalizedText: '',
  textHash: 'chapter_hash',
  rawStartOffset: 0,
  rawEndOffset: 8,
  characterCount: 8,
  paragraphCount: 1,
  createdAt: '2026-07-06T00:00:00.000Z',
  updatedAt: '2026-07-06T00:00:00.000Z',
};

const paragraphs: Paragraph[] = [
  {
    id: 'paragraph_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index: 0,
    text: '"Hello."',
    startOffsetInChapter: 0,
    endOffsetInChapter: 8,
    textHash: 'paragraph_hash',
  },
];

const knownCharacters: Character[] = [
  {
    id: 'char_1',
    novelId: 'book_1',
    canonicalName: 'Alex',
    aliases: ['Al'],
    color: '#3b82f6',
    description: 'Known protagonist.',
    confidence: 0.92,
    isUserConfirmed: true,
  },
];

const existingSegment: LabeledSegment = {
  id: 'segment_old',
  novelId: 'book_1',
  chapterId: 'chapter_1',
  paragraphId: 'paragraph_1',
  segmentIndex: 0,
  startOffset: 0,
  endOffset: 8,
  segmentTextHash: hashSync('"Hello."'),
  type: 'quoted_dialogue',
  speakerId: 'unknown',
  candidateSpeakers: ['char_1'],
  listenerIds: [],
  emotion: 'neutral',
  confidence: 0.4,
  evidence: 'Existing uncertain dialogue label.',
  voiceProfileId: 'narrator_default',
  isUserCorrected: true,
};

const existingResult: ChapterLabelingResult = {
  characters: knownCharacters,
  segments: [existingSegment],
  episodeContextSummary: {
    chapterId: 'chapter_1',
    scene: 'Opening exchange.',
    activeCharacterIds: ['char_1'],
    unresolved: ['speaker needs confirmation'],
    summaryForNextChapter: 'Alex may be the speaker.',
  },
};

const userCorrections: UserCorrection[] = [
  {
    id: 'correction_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    paragraphId: 'paragraph_1',
    segmentId: 'segment_old',
    correctionType: 'speaker',
    beforeJson: JSON.stringify({ speakerId: 'unknown' }),
    afterJson: JSON.stringify({ speakerId: 'char_1' }),
    applyScope: 'future_pattern',
    createdAt: '2026-07-06T00:01:00.000Z',
  },
];

const characterGraph: CharacterGraph = {
  novelId: 'book_1',
  characters: knownCharacters,
  relations: [
    {
      id: 'rel_1',
      novelId: 'book_1',
      sourceCharacterId: 'char_1',
      targetCharacterId: 'char_1',
      relationLabel: 'self',
      termsUsedBySource: ['Al'],
      termsUsedByTarget: ['Alex'],
      confidence: 0.7,
      evidence: ['Self reference in repair fixture.'],
    },
  ],
};

const repairInput: RepairChapterLabelsInput = {
  novelId: 'book_1',
  chapter,
  paragraphs,
  knownCharacters,
  characterGraph,
  previousEpisodeContext: {
    chapterId: 'chapter_0',
    summary: 'Alex was speaking in the previous scene.',
    activeCharacterIds: ['char_1'],
    unresolved: [],
  },
  userCorrections,
  existingResult,
  validationIssues: [
    {
      severity: 'error',
      code: 'unknown_speaker_id',
      message: 'Segment speaker_id is not in known characters or reserved roles.',
      segmentId: 'segment_old',
      paragraphId: 'paragraph_1',
    },
  ],
};

describe('chapter label repair request profile', () => {
  it('builds a repair request with source anchors, existing labels, validator issues, and correction hints', () => {
    const request = buildChapterLabelRepairRequest(repairInput, {
      repairRequestProfileId: LEGACY_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
      requestProfileId: 'chapter-labeling-v1-strict-tts',
      temperature: 0.05,
      maxOutputTokens: 2048,
    });

    expect(request.profile.id).toBe(LEGACY_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID);
    expect(request.jsonSchemaName).toBe('chapter_labeling_result');
    expect(request.providerOptions).toEqual({ temperature: 0.05, maxOutputTokens: 2048 });
    expect(request.prompt).toContain('Fix only invalid or suspicious segments listed in repair_input.validator_issues');
    expect(request.prompt).toContain(`"prompt_version":"${CHAPTER_LABEL_REPAIR_PROMPT_VERSION}"`);
    expect(request.prompt).toContain('"request_profile_id":"chapter-label-repair-v1"');
    expect(request.prompt).toContain('"character_graph":{"novel_id":"book_1"');
    expect(request.prompt).toContain('"relations":[{"relation_id":"rel_1"');
    expect(request.prompt).toContain('"repair_input"');
    expect(request.prompt).toContain('"paragraph_anchors":[{"paragraph_id":"paragraph_1"');
    expect(request.prompt).toContain('"existing_labeling_result"');
    expect(request.prompt).toContain('"segment_id":"segment_old"');
    expect(request.prompt).toContain('"is_user_corrected":true');
    expect(request.prompt).toContain('"validator_issues":[{"severity":"error","code":"unknown_speaker_id"');
    expect(request.prompt).toContain('"user_corrections":[{"correction_id":"correction_1"');
  });

  it('lists, resolves, and strips repair profile options separately from provider API options', () => {
    expect(listChapterLabelRepairRequestProfileConfigs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileId: LEGACY_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
          displayName: 'Chapter Label Repair v1',
          promptVersion: CHAPTER_LABEL_REPAIR_PROMPT_VERSION,
          schemaVersion: 'chapter-labeling-result-v1',
        }),
        expect.objectContaining({
          profileId: DEFAULT_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
          schemaVersion: 'chapter-label-repair-patch-v2',
        }),
      ]),
    );

    expect(
      resolveChapterLabelRepairRequestProfile({
        promptVersion: CHAPTER_LABEL_REPAIR_PROMPT_VERSION,
      }).id,
    ).toBe(LEGACY_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID);

    expect(
      resolveChapterLabelRepairRequestProfile({
        requestProfileId: 'chapter-labeling-v1-strict-tts',
      }).id,
    ).toBe(DEFAULT_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID);

    expect(() => resolveChapterLabelRepairRequestProfile({ repairRequestProfileId: 'missing-repair-profile' })).toThrow(
      /Unsupported chapter label repair request profile/,
    );

    expect(
      providerApiOptionsForChapterLabelRepair({
        repairRequestProfileId: DEFAULT_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
        requestProfileId: 'chapter-labeling-v1',
        labelingProfileId: 'chapter-labeling-v1',
        promptVersion: 'chapter-labeler-v1',
        autoRepairOnValidationFailure: true,
        temperature: 0.2,
      }),
    ).toEqual({ temperature: 0.2 });
  });

  it('maps repaired provider JSON through the shared chapter labeling result contract', () => {
    const request = buildChapterLabelRepairRequest(repairInput, {
      repairRequestProfileId: LEGACY_CHAPTER_LABEL_REPAIR_REQUEST_PROFILE_ID,
    });
    const response = request.profile.parseResponse(
      JSON.stringify({
        chapter_id: 'chapter_1',
        analysis_version: 2,
        segments: [
          {
            segment_id: 'segment_old',
            paragraph_id: 'paragraph_1',
            start_offset: 0,
            end_offset: 8,
            type: 'quoted_dialogue',
            speaker_id: 'char_1',
            candidate_speakers: [],
            listener_ids: [],
            emotion: 'calm',
            confidence: 0.91,
            evidence: 'User correction identifies Alex as the speaker.',
            tts: { voice_profile_id: 'alex_voice' },
          },
        ],
        episode_context_summary: {
          scene: 'Opening exchange.',
          active_characters: ['char_1'],
          unresolved: [],
          summary_for_next_chapter: 'Alex is confirmed as the speaker.',
        },
      }),
    );

    const result = request.profile.toResult(repairInput, response);

    expect(result.segments).toEqual([
      expect.objectContaining({
        id: 'segment_old',
        paragraphId: 'paragraph_1',
        speakerId: 'char_1',
        emotion: 'calm',
        voiceProfileId: 'alex_voice',
      }),
    ]);
    expect(result.episodeContextSummary).toEqual(
      expect.objectContaining({
        chapterId: 'chapter_1',
        activeCharacterIds: ['char_1'],
        summaryForNextChapter: 'Alex is confirmed as the speaker.',
      }),
    );
  });
});
