import { describe, expect, it } from 'vitest';
import type { Character, UserCorrection } from '../domain/types';
import type { CharacterGraph } from '../providers/ai';
import {
  buildCharacterGraphMergeRequest,
  DEFAULT_CHARACTER_GRAPH_MERGE_REQUEST_PROFILE_ID,
  listCharacterGraphMergeRequestProfileConfigs,
  providerApiOptionsForCharacterGraphMerge,
  resolveCharacterGraphMergeRequestProfile,
} from '../providers/character-graph-request-profile';

const existingCharacter: Character = {
  id: 'char_1',
  novelId: 'book_1',
  canonicalName: '강현우',
  aliases: ['현우'],
  color: '#3b82f6',
  description: '사용자가 확정한 주인공.',
  confidence: 0.95,
  isUserConfirmed: true,
};

const discoveredCharacter: Character = {
  id: 'candidate_hyunwoo',
  novelId: 'book_1',
  canonicalName: '현우',
  aliases: ['강 대리'],
  color: '#ef476f',
  description: '새 번들에서 발견된 후보.',
  confidence: 0.77,
  isUserConfirmed: false,
};

const existingGraph: CharacterGraph = {
  novelId: 'book_1',
  characters: [existingCharacter],
  relations: [],
};

const discoveredGraph: CharacterGraph = {
  novelId: 'book_1',
  characters: [
    discoveredCharacter,
    {
      id: 'char_2',
      novelId: 'book_1',
      canonicalName: '박민서',
      aliases: ['팀장님'],
      color: '#2fbf71',
      description: '새로 발견된 팀장.',
      confidence: 0.84,
      isUserConfirmed: false,
    },
  ],
  relations: [
    {
      id: 'rel_candidate',
      novelId: 'book_1',
      sourceCharacterId: 'candidate_hyunwoo',
      targetCharacterId: 'char_2',
      relationLabel: 'work_colleague',
      termsUsedBySource: ['팀장님'],
      termsUsedByTarget: ['강 대리'],
      confidence: 0.72,
      evidence: ['현우가 박민서를 팀장님이라고 부른다.'],
    },
  ],
};

const userCorrections: UserCorrection[] = [
  {
    id: 'correction_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    correctionType: 'speaker',
    beforeJson: JSON.stringify({ speakerId: 'unknown' }),
    afterJson: JSON.stringify({ speakerId: 'char_1' }),
    applyScope: 'global',
    createdAt: '2026-07-06T00:00:00.000Z',
  },
];

describe('character graph merge request profile', () => {
  it('builds provider-neutral graph merge prompts and strips profile-only options', () => {
    const request = buildCharacterGraphMergeRequest(
      {
        novelId: 'book_1',
        existingGraph,
        discoveredGraph,
        sourceContext: {
          bundleId: 'bundle_1',
          chapterIds: ['chapter_1', 'chapter_2'],
          summary: '현우와 민서가 함께 등장한다.',
        },
        userCorrections,
      },
      {
        graphRequestProfileId: DEFAULT_CHARACTER_GRAPH_MERGE_REQUEST_PROFILE_ID,
        requestProfileId: 'chapter-labeling-v1-strict-tts',
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    );

    expect(request.profile.id).toBe(DEFAULT_CHARACTER_GRAPH_MERGE_REQUEST_PROFILE_ID);
    expect(request.jsonSchemaName).toBe('character_graph_consolidation_result');
    expect(request.providerOptions).toEqual({ temperature: 0.1, maxOutputTokens: 2048 });
    expect(request.prompt).toContain('"prompt_version":"character-graph-consolidation-v2"');
    expect(request.prompt).toContain('"existing_graph":{"novel_id":"book_1"');
    expect(request.prompt).toContain('"discovered_graph":{"novel_id":"book_1"');
    expect(request.prompt).toContain('"after_json":{"speakerId":"char_1"}');
  });

  it('maps validated provider graph output and preserves user-confirmed existing characters', () => {
    const request = buildCharacterGraphMergeRequest(
      {
        novelId: 'book_1',
        existingGraph,
        discoveredGraph,
      },
      undefined,
    );

    const result = request.profile.toResult(
      {
        novelId: 'book_1',
        existingGraph,
        discoveredGraph,
      },
      request.profile.parseResponse(
        JSON.stringify({
          novel_id: 'book_1',
          graph_version: 1,
          characters: [
            {
              character_id: 'char_1',
              canonical_name: '현우',
              aliases: ['강 대리'],
              color: '#ef476f',
              description: 'LLM이 바꾸려 한 설명.',
              confidence: 0.8,
            },
            {
              character_id: 'candidate_hyunwoo',
              canonical_name: '현우',
              aliases: ['강 대리'],
              confidence: 0.77,
            },
            {
              character_id: 'char_2',
              canonical_name: '박민서',
              aliases: ['팀장님'],
              color: '#2fbf71',
              description: '팀장.',
              is_user_confirmed: true,
              confidence: 0.84,
            },
          ],
          relations: [
            {
              source_character_id: 'char_1',
              target_character_id: 'char_2',
              relation_label: 'work_colleague',
              terms_used_by_source: ['팀장님'],
              terms_used_by_target: ['강 대리'],
              confidence: 0.72,
              evidence: ['호칭 근거.'],
            },
          ],
        }),
      ),
    );

    expect(result.characters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'char_1',
          canonicalName: '강현우',
          aliases: ['현우'],
          color: '#3b82f6',
          isUserConfirmed: true,
        }),
        expect.objectContaining({ id: 'candidate_hyunwoo', canonicalName: '현우' }),
        expect.objectContaining({
          id: 'char_2',
          canonicalName: '박민서',
          isUserConfirmed: false,
        }),
      ]),
    );
    expect(result.relations).toEqual([
      expect.objectContaining({
        sourceCharacterId: 'char_1',
        targetCharacterId: 'char_2',
        relationLabel: 'work_colleague',
        termsUsedBySource: ['팀장님'],
      }),
    ]);
  });

  it('rejects identity collapse and invented ids in the v2 consolidation profile', () => {
    const request = buildCharacterGraphMergeRequest({ novelId: 'book_1', existingGraph, discoveredGraph }, undefined);
    const response = (characters: unknown[]) =>
      request.profile.parseResponse(
        JSON.stringify({ novel_id: 'book_1', graph_version: 2, characters, relations: [] }),
      );
    expect(() =>
      request.profile.toResult(
        { novelId: 'book_1', existingGraph, discoveredGraph },
        response([
          { character_id: 'char_1', canonical_name: '강현우', aliases: [], confidence: 0.9 },
          { character_id: 'char_2', canonical_name: '박민서', aliases: [], confidence: 0.8 },
        ]),
      ),
    ).toThrow(/removed input ids/);
    expect(() =>
      request.profile.toResult(
        { novelId: 'book_1', existingGraph, discoveredGraph },
        response([
          ...[existingCharacter, ...discoveredGraph.characters].map((character) => ({
            character_id: character.id,
            canonical_name: character.canonicalName,
            aliases: character.aliases,
            confidence: character.confidence,
          })),
          { character_id: 'invented', canonical_name: '새 인물', aliases: [], confidence: 0.5 },
        ]),
      ),
    ).toThrow(/invented ids/);
  });

  it('rejects graph relations that reference missing characters', () => {
    const request = buildCharacterGraphMergeRequest(
      {
        novelId: 'book_1',
        existingGraph,
        discoveredGraph,
      },
      undefined,
    );

    expect(() =>
      request.profile.toResult(
        {
          novelId: 'book_1',
          existingGraph,
          discoveredGraph,
        },
        request.profile.parseResponse(
          JSON.stringify({
            novel_id: 'book_1',
            graph_version: 1,
            characters: [
              {
                character_id: 'char_1',
                canonical_name: '강현우',
                aliases: [],
                confidence: 0.9,
              },
            ],
            relations: [
              {
                source_character_id: 'char_1',
                target_character_id: 'missing',
                relation_label: 'knows',
                terms_used_by_source: [],
                terms_used_by_target: [],
                confidence: 0.5,
                evidence: [],
              },
            ],
          }),
        ),
      ),
    ).toThrow(/unknown target character/);
  });

  it('lists graph request profile metadata and rejects explicit missing graph profiles', () => {
    expect(listCharacterGraphMergeRequestProfileConfigs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileId: DEFAULT_CHARACTER_GRAPH_MERGE_REQUEST_PROFILE_ID,
          promptVersion: 'character-graph-consolidation-v2',
          schemaVersion: 'character-graph-v1',
        }),
        expect.objectContaining({ profileId: 'character-graph-merge-v1' }),
      ]),
    );
    expect(
      resolveCharacterGraphMergeRequestProfile({
        requestProfileId: 'chapter-labeling-v1-strict-tts',
      }).id,
    ).toBe(DEFAULT_CHARACTER_GRAPH_MERGE_REQUEST_PROFILE_ID);
    expect(() =>
      resolveCharacterGraphMergeRequestProfile({
        characterGraphProfileId: 'missing-graph-profile',
      }),
    ).toThrow(/Unsupported character graph merge request profile/);
  });

  it('removes graph profile keys from provider API options', () => {
    expect(
      providerApiOptionsForCharacterGraphMerge({
        graphRequestProfileId: DEFAULT_CHARACTER_GRAPH_MERGE_REQUEST_PROFILE_ID,
        requestProfileId: 'character-graph-merge-v1',
        promptVersion: 'character-graph-merge-v1',
        temperature: 0.2,
      }),
    ).toEqual({ temperature: 0.2 });
  });
});
