import { describe, expect, it } from 'vitest';
import type { Character } from '../domain/types';
import type { CharacterGraph } from '../providers/ai';
import { buildCharacterGraphReview } from '../providers/character-graph-review';

function character(overrides: Partial<Character>): Character {
  return {
    id: 'char_base',
    novelId: 'book_1',
    canonicalName: 'Base',
    aliases: [],
    color: '#3b82f6',
    confidence: 0.9,
    isUserConfirmed: false,
    ...overrides,
  };
}

const existingCharacters: Character[] = [
  character({
    id: 'char_anna',
    canonicalName: 'Anna',
    aliases: ['A. Kim', 'Commander'],
    isUserConfirmed: true,
  }),
];

const discoveredGraph: CharacterGraph = {
  novelId: 'book_1',
  characters: [
    character({
      id: 'candidate_anna',
      canonicalName: 'Commander',
      aliases: ['Anna K.'],
      confidence: 0.82,
    }),
    character({
      id: 'candidate_ben',
      canonicalName: 'Ben',
      aliases: ['B'],
      confidence: 0.76,
    }),
    character({
      id: 'candidate_low',
      canonicalName: 'Low',
      confidence: 0.41,
    }),
  ],
  relations: [
    {
      id: 'rel_anna_ben',
      novelId: 'book_1',
      sourceCharacterId: 'candidate_anna',
      targetCharacterId: 'candidate_ben',
      relationLabel: 'colleague',
      termsUsedBySource: ['Ben'],
      termsUsedByTarget: ['Commander'],
      confidence: 0.7,
      evidence: ['Commander calls Ben by name.'],
    },
    {
      id: 'rel_ben_low',
      novelId: 'book_1',
      sourceCharacterId: 'candidate_ben',
      targetCharacterId: 'candidate_low',
      relationLabel: 'witness',
      termsUsedBySource: ['Low'],
      termsUsedByTarget: ['Ben'],
      confidence: 0.58,
      evidence: ['Ben notices Low.'],
    },
  ],
};

describe('character graph review', () => {
  it('marks likely duplicate and low-confidence discovered characters', () => {
    const review = buildCharacterGraphReview({
      novelId: 'book_1',
      existingCharacters,
      discoveredGraph,
    });

    expect(review.parseError).toBeUndefined();
    expect(review.candidates.map((item) => [item.character.id, item.reasons])).toEqual([
      ['candidate_anna', ['possible_duplicate']],
      ['candidate_ben', ['new_character']],
      ['candidate_low', ['new_character', 'low_confidence']],
    ]);
    expect(review.candidates[0].matchedExistingCharacter?.id).toBe('char_anna');
    expect(review.duplicateCandidateCount).toBe(1);
    expect(review.lowConfidenceCount).toBe(1);
    expect(review.newCandidateCount).toBe(2);
  });

  it('uses possible_existing hints preserved from bundle analysis descriptions', () => {
    const review = buildCharacterGraphReview({
      novelId: 'book_1',
      existingCharacters,
      discoveredGraph: {
        novelId: 'book_1',
        characters: [
          character({
            id: 'candidate_hint',
            canonicalName: 'Field Leader',
            aliases: [],
            confidence: 0.68,
            description: 'Tactical leader.\npossible_existing: char_anna, char_missing',
          }),
        ],
        relations: [],
      },
    });

    expect(review.candidates[0]).toEqual(
      expect.objectContaining({
        reasons: ['possible_duplicate'],
        matchedBy: 'possible_existing_id',
      }),
    );
    expect(review.candidates[0].matchedExistingCharacter?.id).toBe('char_anna');
    expect(review.duplicateCandidateCount).toBe(1);
    expect(review.newCandidateCount).toBe(0);
  });

  it('excludes selected candidates and drops relations that reference them', () => {
    const review = buildCharacterGraphReview({
      novelId: 'book_1',
      existingCharacters,
      discoveredGraph,
      excludedCharacterIds: new Set(['candidate_anna']),
    });

    expect(review.reviewedGraph.characters.map((item) => item.id)).toEqual(['candidate_ben', 'candidate_low']);
    expect(review.reviewedGraph.relations.map((item) => item.id)).toEqual(['rel_ben_low']);
    expect(review.invalidRelationCount).toBe(1);
    expect(review.excludedCharacterCount).toBe(1);
    expect(review.relations.find((item) => item.relation.id === 'rel_anna_ben')?.reason).toBe('excluded_character');
  });

  it('normalizes snake_case provider graph snapshots for review', () => {
    const review = buildCharacterGraphReview({
      novelId: 'book_1',
      existingCharacters: [],
      discoveredGraph: {
        novel_id: 'book_1',
        characters: [
          {
            character_id: 'candidate_snake',
            canonical_name: 'Snake',
            aliases: ['S'],
            confidence: 0.8,
          },
        ],
        relations: [],
      },
    });

    expect(review.reviewedGraph.characters[0]).toEqual(
      expect.objectContaining({
        id: 'candidate_snake',
        canonicalName: 'Snake',
      }),
    );
  });

  it('returns a parse error instead of throwing on invalid graph snapshots', () => {
    const review = buildCharacterGraphReview({
      novelId: 'book_1',
      existingCharacters: [],
      discoveredGraph: { novelId: 'other_book', characters: [], relations: [] },
    });

    expect(review.parseError).toContain('novel id mismatch');
    expect(review.reviewedGraph.characters).toEqual([]);
    expect(review.candidates).toEqual([]);
  });
});
