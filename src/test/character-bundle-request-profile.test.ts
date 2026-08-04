import { describe, expect, it } from 'vitest';
import type { Chapter, Paragraph, UserCorrection } from '../domain/types';
import type { CharacterGraph } from '../providers/ai';
import {
  buildCharacterBundleAnalysisRequest,
  DEFAULT_CHARACTER_BUNDLE_REQUEST_PROFILE_ID,
  listCharacterBundleAnalysisRequestProfileConfigs,
  providerApiOptionsForCharacterBundleAnalysis,
  resolveCharacterBundleAnalysisRequestProfile,
} from '../providers/character-bundle-request-profile';

const chapter: Chapter = {
  id: 'chapter_1',
  novelId: 'book_1',
  index: 1,
  title: '1화',
  normalizedText: '',
  textHash: 'chapter_hash',
  rawStartOffset: 0,
  rawEndOffset: 24,
  characterCount: 24,
  paragraphCount: 2,
  createdAt: '2026-07-06T00:00:00.000Z',
  updatedAt: '2026-07-06T00:00:00.000Z',
};

const paragraphs: Paragraph[] = [
  {
    id: 'paragraph_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index: 0,
    text: '강현우가 말했다.',
    startOffsetInChapter: 0,
    endOffsetInChapter: 8,
    textHash: 'paragraph_hash_1',
  },
  {
    id: 'paragraph_2',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index: 1,
    text: '박민서는 팀장님이라고 불렸다.',
    startOffsetInChapter: 9,
    endOffsetInChapter: 24,
    textHash: 'paragraph_hash_2',
  },
];

const existingGraph: CharacterGraph = {
  novelId: 'book_1',
  characters: [
    {
      id: 'char_hyunwoo',
      novelId: 'book_1',
      canonicalName: '강현우',
      aliases: ['현우'],
      color: '#3b82f6',
      confidence: 0.9,
      isUserConfirmed: true,
    },
  ],
  relations: [],
};

const userCorrections: UserCorrection[] = [
  {
    id: 'correction_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    paragraphId: 'paragraph_2',
    correctionType: 'speaker',
    beforeJson: JSON.stringify({ speakerId: 'unknown' }),
    afterJson: JSON.stringify({ speakerId: 'char_minseo' }),
    applyScope: 'future_pattern',
    createdAt: '2026-07-06T00:00:00.000Z',
  },
];

describe('character bundle analysis request profile', () => {
  it('builds provider-neutral bundle prompts and strips profile-only options', () => {
    const request = buildCharacterBundleAnalysisRequest(
      {
        novelId: 'book_1',
        bundleId: 'bundle_1',
        chapters: [{ chapter, paragraphs }],
        existingGraph,
        previousBundleSummary: '이전 묶음에서는 강현우가 중심 인물이었다.',
        userCorrections,
      },
      {
        bundleRequestProfileId: DEFAULT_CHARACTER_BUNDLE_REQUEST_PROFILE_ID,
        requestProfileId: 'chapter-labeling-v1-strict-tts',
        temperature: 0.1,
      },
    );

    expect(request.profile.id).toBe(DEFAULT_CHARACTER_BUNDLE_REQUEST_PROFILE_ID);
    expect(request.jsonSchemaName).toBe('character_bundle_analysis_result');
    expect(request.providerOptions).toEqual({ temperature: 0.1 });
    expect(request.prompt).toContain('"prompt_version":"character-bundle-analysis-v1"');
    expect(request.prompt).toContain('"bundle_id":"bundle_1"');
    expect(request.prompt).toContain('"existing_graph":{"novel_id":"book_1"');
    expect(request.prompt).toContain('"paragraph_id":"paragraph_1"');
    expect(request.prompt).toContain('"after_json":{"speakerId":"char_minseo"}');
  });

  it('maps provider bundle output to a discovered graph candidate set', () => {
    const request = buildCharacterBundleAnalysisRequest(
      {
        novelId: 'book_1',
        bundleId: 'bundle_1',
        chapters: [{ chapter, paragraphs }],
      },
      undefined,
    );

    const result = request.profile.toResult(
      {
        novelId: 'book_1',
        bundleId: 'bundle_1',
        chapters: [{ chapter, paragraphs }],
      },
      request.profile.parseResponse(
        JSON.stringify({
          bundle_id: 'bundle_1',
          source_chapter_ids: ['chapter_1'],
          new_or_updated_characters: [
            {
              temporary_id: 'tmp_hyunwoo',
              canonical_name: '강현우',
              aliases: ['현우'],
              honorifics: ['강 대리'],
              possible_existing_character_ids: ['char_hyunwoo'],
              description: '주요 인물 후보',
              inferred_gender: 'male',
              speech_style: '짧은 문장',
              confidence: 0.82,
              evidence: [{ chapter_id: 'chapter_1', paragraph_id: 'paragraph_1', note: '이름 언급' }],
            },
            {
              temporary_id: 'tmp_minseo',
              canonical_name: '박민서',
              aliases: ['민서'],
              honorifics: ['팀장님'],
              confidence: 0.78,
              evidence: [{ chapter_id: 'chapter_1', paragraph_id: 'paragraph_2', note: '호칭 언급' }],
            },
          ],
          relations: [
            {
              source_character_name_or_alias: '강현우',
              target_character_name_or_alias: '팀장님',
              relation: '직장 관계',
              terms_used: ['팀장님'],
              confidence: 0.7,
              evidence: [{ chapter_id: 'chapter_1', paragraph_id: 'paragraph_2', note: '호칭' }],
            },
          ],
          bundle_summary_for_next: '강현우와 박민서가 직장 관계로 등장한다.',
        }),
      ),
    );

    expect(result).toEqual(
      expect.objectContaining({
        novelId: 'book_1',
        bundleId: 'bundle_1',
        sourceChapterIds: ['chapter_1'],
        bundleSummaryForNext: '강현우와 박민서가 직장 관계로 등장한다.',
      }),
    );
    expect(result.discoveredGraph.characters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalName: '강현우',
          aliases: expect.arrayContaining(['현우', '강 대리']),
          description: expect.stringContaining('possible_existing: char_hyunwoo'),
          isUserConfirmed: false,
        }),
        expect.objectContaining({
          canonicalName: '박민서',
          aliases: expect.arrayContaining(['민서', '팀장님']),
        }),
      ]),
    );
    expect(result.discoveredGraph.relations).toEqual([
      expect.objectContaining({
        relationLabel: '직장 관계',
        termsUsedBySource: ['팀장님'],
        confidence: 0.7,
      }),
    ]);
  });

  it('rejects relation aliases outside the returned bundle character set', () => {
    const request = buildCharacterBundleAnalysisRequest(
      {
        novelId: 'book_1',
        bundleId: 'bundle_1',
        chapters: [{ chapter, paragraphs }],
      },
      undefined,
    );

    expect(() =>
      request.profile.toResult(
        {
          novelId: 'book_1',
          bundleId: 'bundle_1',
          chapters: [{ chapter, paragraphs }],
        },
        request.profile.parseResponse(
          JSON.stringify({
            bundle_id: 'bundle_1',
            source_chapter_ids: ['chapter_1'],
            new_or_updated_characters: [
              {
                temporary_id: 'tmp_hyunwoo',
                canonical_name: '강현우',
                aliases: [],
                confidence: 0.82,
                evidence: [{ chapter_id: 'chapter_1', note: '이름 언급' }],
              },
            ],
            relations: [
              {
                source_character_name_or_alias: '강현우',
                target_character_name_or_alias: '없는 인물',
                relation: '관계',
                terms_used: [],
                confidence: 0.7,
                evidence: [{ chapter_id: 'chapter_1', note: '불명확' }],
              },
            ],
          }),
        ),
      ),
    ).toThrow(/relation target does not match/);
  });

  it('lists profile metadata and rejects explicit missing bundle profiles', () => {
    expect(listCharacterBundleAnalysisRequestProfileConfigs()).toEqual([
      expect.objectContaining({
        profileId: DEFAULT_CHARACTER_BUNDLE_REQUEST_PROFILE_ID,
        promptVersion: 'character-bundle-analysis-v1',
        schemaVersion: 'character-bundle-v1',
      }),
    ]);
    expect(
      resolveCharacterBundleAnalysisRequestProfile({
        requestProfileId: 'chapter-labeling-v1-strict-tts',
      }).id,
    ).toBe(DEFAULT_CHARACTER_BUNDLE_REQUEST_PROFILE_ID);
    expect(() =>
      resolveCharacterBundleAnalysisRequestProfile({
        bundleRequestProfileId: 'missing-bundle-profile',
      }),
    ).toThrow(/Unsupported character bundle analysis request profile/);
  });

  it('removes bundle profile keys from provider API options', () => {
    expect(
      providerApiOptionsForCharacterBundleAnalysis({
        bundleRequestProfileId: DEFAULT_CHARACTER_BUNDLE_REQUEST_PROFILE_ID,
        requestProfileId: 'character-bundle-analysis-v1',
        promptVersion: 'character-bundle-analysis-v1',
        temperature: 0.2,
      }),
    ).toEqual({ temperature: 0.2 });
  });
});
