import { describe, expect, it } from 'vitest';
import {
  buildChapterLabelingRequest,
  CHAPTER_LABELING_V2_PROMPT_VERSION,
  DEFAULT_CHAPTER_LABELING_REQUEST_PROFILE_ID,
  LEGACY_CHAPTER_LABELING_REQUEST_PROFILE_ID,
  listChapterLabelingRequestProfileConfigs,
  providerApiOptionsForChapterLabeling,
  resolveChapterLabelingRequestProfile,
  STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID,
  STRICT_TTS_CHAPTER_LABELING_PROMPT_VERSION,
} from '../providers/chapter-labeling-request-profile';
import type { Chapter, Character, Paragraph, UserCorrection } from '../domain/types';
import type { CharacterGraph } from '../providers/ai';

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

const userCorrections: UserCorrection[] = [
  {
    id: 'correction_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    paragraphId: 'paragraph_1',
    segmentId: 'segment_1',
    correctionType: 'speaker',
    beforeJson: JSON.stringify({ speakerId: 'unknown' }),
    afterJson: JSON.stringify({ speakerId: 'char_1' }),
    applyScope: 'future_pattern',
    createdAt: '2026-07-06T00:01:00.000Z',
  },
];

const characterGraph: CharacterGraph = {
  novelId: 'book_1',
  characters: [
    ...knownCharacters,
    {
      id: 'char_2',
      novelId: 'book_1',
      canonicalName: 'Morgan',
      aliases: ['Captain'],
      color: '#ef476f',
      description: 'Alex mentor.',
      confidence: 0.85,
      isUserConfirmed: false,
    },
  ],
  relations: [
    {
      id: 'rel_1',
      novelId: 'book_1',
      sourceCharacterId: 'char_1',
      targetCharacterId: 'char_2',
      relationLabel: 'mentee',
      termsUsedBySource: ['Captain'],
      termsUsedByTarget: ['Al'],
      confidence: 0.8,
      evidence: ['Alex calls Morgan Captain.'],
    },
  ],
};

describe('chapter labeling request profiles', () => {
  it('builds the default request profile while stripping internal provider options', () => {
    const request = buildChapterLabelingRequest(
      {
        novelId: 'book_1',
        chapter,
        paragraphs,
        windowId: 'window_1',
        inputRevisionId: 'revision_1',
      },
      {
        requestProfileId: DEFAULT_CHAPTER_LABELING_REQUEST_PROFILE_ID,
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    );

    expect(request.profile.id).toBe(DEFAULT_CHAPTER_LABELING_REQUEST_PROFILE_ID);
    expect(request.jsonSchemaName).toBe('chapter_labeling_v2_result');
    expect(request.providerOptions).toEqual({ temperature: 0.1, maxOutputTokens: 2048 });
    expect(request.prompt).toContain(`"prompt_version":"${CHAPTER_LABELING_V2_PROMPT_VERSION}"`);
    expect(request.prompt).toContain('"schema_version":"chapter-labeling-v2"');
    expect(request.prompt).toContain('"window_id":"window_1"');
    expect(request.prompt).toContain('"input_revision_id":"revision_1"');
  });

  it('includes known characters, previous context, and corrections in the provider-neutral payload', () => {
    const request = buildChapterLabelingRequest(
      {
        novelId: 'book_1',
        chapter,
        paragraphs,
        knownCharacters,
        characterGraph,
        previousEpisodeContext: {
          chapterId: 'chapter_0',
          summary: 'Alex was introduced in the previous scene.',
          activeCharacterIds: ['char_1'],
          unresolved: ['speaker in paragraph_1 was uncertain'],
        },
        userCorrections,
      },
      { requestProfileId: LEGACY_CHAPTER_LABELING_REQUEST_PROFILE_ID },
    );

    expect(request.prompt).toContain('"known_characters":[{"character_id":"char_1"');
    expect(request.prompt).toContain('"character_graph":{"novel_id":"book_1"');
    expect(request.prompt).toContain('"relations":[{"relation_id":"rel_1"');
    expect(request.prompt).toContain('"terms_used_by_source":["Captain"]');
    expect(request.prompt).toContain('"canonical_name":"Alex"');
    expect(request.prompt).toContain('"previous_episode_context":{"chapter_id":"chapter_0"');
    expect(request.prompt).toContain('"active_character_ids":["char_1"]');
    expect(request.prompt).toContain('"user_corrections":[{"correction_id":"correction_1"');
    expect(request.prompt).toContain('"after_json":{"speakerId":"char_1"}');
  });

  it('lists v2 and builds the legacy strict TTS request profile explicitly', () => {
    expect(listChapterLabelingRequestProfileConfigs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileId: DEFAULT_CHAPTER_LABELING_REQUEST_PROFILE_ID,
          promptVersion: CHAPTER_LABELING_V2_PROMPT_VERSION,
          schemaVersion: 'chapter-labeling-v2',
        }),
        expect.objectContaining({
          profileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID,
          displayName: 'Strict TTS Labeling v1',
          promptVersion: STRICT_TTS_CHAPTER_LABELING_PROMPT_VERSION,
          schemaVersion: 'chapter-labeling-result-v1',
        }),
      ]),
    );

    const request = buildChapterLabelingRequest(
      {
        novelId: 'book_1',
        chapter,
        paragraphs,
      },
      {
        requestProfileId: STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID,
        temperature: 0.05,
      },
    );

    expect(request.profile.id).toBe(STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID);
    expect(request.prompt).toContain(`"prompt_version":"${STRICT_TTS_CHAPTER_LABELING_PROMPT_VERSION}"`);
    expect(request.prompt).toContain('"request_profile_id":"chapter-labeling-v1-strict-tts"');
    expect(request.prompt).toContain(
      'Segments in the same paragraph must be sorted by start_offset and must not overlap.',
    );
    expect(request.prompt).toContain('Every input paragraph must have at least one segment.');
    expect(request.prompt).toContain('unique paragraph_id count in segments equals the number of input paragraphs.');
    expect(request.prompt).toContain('start_offset 0 and end_offset paragraph.length');
    expect(request.prompt).toContain('candidate_speakers and listener_ids may contain only canonical IDs');
    expect(request.prompt).toContain('Emotion must be one of: neutral, calm, tense');
    expect(request.prompt).toContain('Omit segment_id unless it is deterministic');
    expect(request.prompt).toContain('Do not rely on tts.speed or tts.tone');
    expect(request.responseSchema).not.toBe(resolveChapterLabelingRequestProfile(undefined).responseSchema);
    expect(request.responseSchema).toMatchObject({
      properties: {
        segments: {
          items: {
            properties: { emotion: { enum: expect.arrayContaining(['neutral', 'system']) } },
          },
        },
      },
    });
    expect(request.providerOptions).toEqual({ temperature: 0.05 });
  });

  it('resolves profiles by prompt version aliases for legacy/env callers', () => {
    expect(
      resolveChapterLabelingRequestProfile({
        promptVersion: STRICT_TTS_CHAPTER_LABELING_PROMPT_VERSION,
      }).id,
    ).toBe(STRICT_TTS_CHAPTER_LABELING_REQUEST_PROFILE_ID);
  });

  it('rejects unsupported profile ids before provider calls', () => {
    expect(() => resolveChapterLabelingRequestProfile({ requestProfileId: 'experimental-missing' })).toThrow(
      /Unsupported chapter labeling request profile/,
    );
  });

  it('removes profile-only keys from provider API options', () => {
    expect(
      providerApiOptionsForChapterLabeling({
        requestProfileId: DEFAULT_CHAPTER_LABELING_REQUEST_PROFILE_ID,
        labelingProfileId: 'chapter-labeling-v1',
        promptVersion: 'chapter-labeler-v1',
        autoRepairOnValidationFailure: true,
        temperature: 0.2,
      }),
    ).toEqual({ temperature: 0.2 });
  });
});
