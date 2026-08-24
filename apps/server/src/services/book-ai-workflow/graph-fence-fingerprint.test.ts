import { describe, expect, it } from 'vitest';
import type { CharacterGraph } from '../../../../../src/providers/ai';
import { characterGraphFenceFingerprint } from './graph-fence-fingerprint.js';

const graph: CharacterGraph = {
  novelId: 'book-1',
  characters: [
    {
      id: 'character-a',
      novelId: 'book-1',
      canonicalName: '강현우',
      aliases: [],
      color: '#336699',
      confidence: 0.72,
      isUserConfirmed: false,
    },
    {
      id: 'character-b',
      novelId: 'book-1',
      canonicalName: '박민서',
      aliases: [],
      color: '#993366',
      confidence: 0.78,
      isUserConfirmed: true,
    },
  ],
  relations: [
    {
      id: 'relation-b',
      novelId: 'book-1',
      sourceCharacterId: 'character-b',
      targetCharacterId: 'character-a',
      relationLabel: '알고 있음',
      termsUsedBySource: [],
      termsUsedByTarget: [],
      confidence: 0.7,
    },
    {
      id: 'relation-a',
      novelId: 'book-1',
      sourceCharacterId: 'character-a',
      targetCharacterId: 'character-b',
      relationLabel: '알고 있음',
      termsUsedBySource: [],
      termsUsedByTarget: [],
      confidence: 0.7,
    },
  ],
};

describe('character graph promotion fence fingerprint', () => {
  it('ignores database row order for graph entities', () => {
    const reordered: CharacterGraph = {
      ...graph,
      characters: [...graph.characters].reverse(),
      relations: [...graph.relations].reverse(),
    };

    expect(characterGraphFenceFingerprint(reordered)).toBe(characterGraphFenceFingerprint(graph));
  });

  it('still detects material graph changes', () => {
    const changed: CharacterGraph = {
      ...graph,
      characters: graph.characters.map((character) =>
        character.id === 'character-a' ? { ...character, canonicalName: '강현우 2' } : character,
      ),
    };

    expect(characterGraphFenceFingerprint(changed)).not.toBe(characterGraphFenceFingerprint(graph));
  });
});
