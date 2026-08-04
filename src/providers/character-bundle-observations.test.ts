import { describe, expect, it } from 'vitest';
import type { AnalyzeCharacterBundleInput, CharacterBundleAnalysisResult } from './ai';
import { characterBundleObservationsV2 } from './character-bundle-observations';
import type { CharacterBundleLLMResponse } from './character-bundle-contract';

describe('characterBundleObservationsV2', () => {
  it('keeps evidence anchors and models generic aliases and directional terms separately', () => {
    const source = {
      novelId: 'book-1',
      bundleId: 'bundle-1',
      chapters: [
        {
          chapter: { id: 'chapter-1', index: 3, textHash: 'chapter-hash' },
          paragraphs: [{ id: 'paragraph-1', textHash: 'paragraph-hash' }],
        },
      ],
    } as AnalyzeCharacterBundleInput;
    const response: CharacterBundleLLMResponse = {
      bundle_id: 'bundle-1',
      source_chapter_ids: ['chapter-1'],
      new_or_updated_characters: [
        {
          temporary_id: 'candidate-a',
          canonical_name: '한서윤',
          aliases: ['서윤', '그녀'],
          honorifics: ['팀장님'],
          possible_existing_character_ids: ['character-existing'],
          inferred_gender: 'female',
          speech_style: 'formal',
          confidence: 0.8,
          evidence: [{ chapter_id: 'chapter-1', paragraph_id: 'paragraph-1', note: 'explicit name' }],
        },
        {
          temporary_id: 'candidate-b',
          canonical_name: '강민호',
          aliases: ['민호'],
          confidence: 0.7,
          evidence: [{ chapter_id: 'chapter-1', paragraph_id: 'paragraph-1', note: 'reply' }],
        },
      ],
      relations: [
        {
          source_character_name_or_alias: '한서윤',
          target_character_name_or_alias: '강민호',
          relation: '동료',
          terms_used: ['민호 씨'],
          confidence: 0.7,
          evidence: [{ chapter_id: 'chapter-1', paragraph_id: 'paragraph-1', note: 'address' }],
        },
      ],
    };
    const characterA = {
      id: 'character-a',
      novelId: 'book-1',
      canonicalName: '한서윤',
      aliases: ['서윤'],
      color: '#111111',
      confidence: 0.8,
      isUserConfirmed: false,
    };
    const characterB = { ...characterA, id: 'character-b', canonicalName: '강민호', aliases: ['민호'] };
    const result: CharacterBundleAnalysisResult = {
      novelId: 'book-1',
      bundleId: 'bundle-1',
      sourceChapterIds: ['chapter-1'],
      discoveredGraph: {
        novelId: 'book-1',
        characters: [characterA, characterB],
        relations: [
          {
            id: 'relation-1',
            novelId: 'book-1',
            sourceCharacterId: characterA.id,
            targetCharacterId: characterB.id,
            relationLabel: '동료',
            termsUsedBySource: ['민호 씨'],
            termsUsedByTarget: [],
            confidence: 0.7,
          },
        ],
      },
    };

    const knowledge = characterBundleObservationsV2({ source, response, result });

    expect(knowledge.facts.some((fact) => fact.field === 'typed_alias' && fact.value === '서윤')).toBe(true);
    expect(knowledge.mentions).toEqual([expect.objectContaining({ surface: '그녀', kind: 'generic_reference' })]);
    expect(knowledge.addressTerms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: '팀장님', direction: 'unknown', targetCharacterId: 'character-a' }),
        expect.objectContaining({
          surface: '민호 씨',
          direction: 'speaker_to_target',
          speakerCharacterId: 'character-a',
          targetCharacterId: 'character-b',
        }),
      ]),
    );
    expect(knowledge.evidence.every((item) => item.sourceHash === 'paragraph-hash')).toBe(true);
    expect(knowledge.mergeCandidates[0]).toMatchObject({
      sourceCharacterId: 'character-a',
      targetCharacterId: 'character-existing',
      status: 'open',
    });
    expect(knowledge.relationFacts[0]).toMatchObject({ status: 'candidate', validity: { fromChapterIndex: 3 } });
  });
});
