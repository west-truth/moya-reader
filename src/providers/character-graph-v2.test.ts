import { describe, expect, it } from 'vitest';
import type { CharacterGraph } from './ai';
import {
  backfillCharacterGraphKnowledgeV2,
  characterFactIsActiveAt,
  deriveCharacterMergeCandidatesV2,
  isGenericCharacterReference,
  resolveCharacterRedirect,
  selectCharacterGraphSliceV2,
} from './character-graph-v2';

const graph: CharacterGraph = {
  novelId: 'book-1',
  characters: [
    {
      id: 'character-a',
      novelId: 'book-1',
      canonicalName: '한서윤',
      aliases: ['서윤', '그녀', '팀장'],
      color: '#123456',
      confidence: 0.9,
      isUserConfirmed: true,
    },
    {
      id: 'character-b',
      novelId: 'book-1',
      canonicalName: '강민호',
      aliases: ['민호'],
      color: '#654321',
      confidence: 0.8,
      isUserConfirmed: false,
    },
  ],
  relations: [
    {
      id: 'relation-1',
      novelId: 'book-1',
      sourceCharacterId: 'character-a',
      targetCharacterId: 'character-b',
      relationLabel: '동료',
      termsUsedBySource: ['민호 씨'],
      termsUsedByTarget: ['팀장님'],
      confidence: 0.8,
    },
  ],
};

describe('Character Graph v2 knowledge model', () => {
  it('quarantines generic references instead of backfilling them as global aliases', () => {
    const knowledge = backfillCharacterGraphKnowledgeV2(graph);
    expect(knowledge.facts.filter((fact) => fact.field === 'typed_alias').map((fact) => fact.value)).toEqual([
      '서윤',
      '민호',
    ]);
    expect(knowledge.mentions.map((mention) => mention.surface)).toEqual(['그녀', '팀장']);
    expect(isGenericCharacterReference('그 남자')).toBe(true);
    expect(isGenericCharacterReference('한서윤')).toBe(false);
  });

  it('selects only facts and relationships active in the target validity range', () => {
    const knowledge = backfillCharacterGraphKnowledgeV2(graph);
    const relation = { ...knowledge.relationFacts[0]!, validity: { fromChapterIndex: 5 } };
    const scoped = { ...knowledge, relationFacts: [relation] };
    expect(
      selectCharacterGraphSliceV2({
        graph,
        knowledge: scoped,
        chapterIndex: 3,
        surfaces: ['서윤', '민호'],
      }).graph.relations,
    ).toEqual([]);
    expect(
      selectCharacterGraphSliceV2({
        graph,
        knowledge: scoped,
        chapterIndex: 5,
        surfaces: ['서윤', '민호'],
      }).graph.relations,
    ).toHaveLength(1);
    expect(characterFactIsActiveAt({ fromChapterIndex: 2, toChapterIndex: 4 }, 5)).toBe(false);
  });

  it('resolves redirect chains and rejects cycles', () => {
    const redirects = [
      {
        id: 'r1',
        novelId: 'book-1',
        sourceCharacterId: 'a',
        targetCharacterId: 'b',
        operationId: 'op-1',
        graphRevision: 'g1',
        createdAt: '2026-07-11T00:00:00.000Z',
      },
      {
        id: 'r2',
        novelId: 'book-1',
        sourceCharacterId: 'b',
        targetCharacterId: 'c',
        operationId: 'op-2',
        graphRevision: 'g2',
        createdAt: '2026-07-11T00:00:00.000Z',
      },
    ];
    expect(resolveCharacterRedirect('a', redirects)).toBe('c');
    expect(() =>
      resolveCharacterRedirect('a', [
        ...redirects,
        { ...redirects[0]!, sourceCharacterId: 'c', targetCharacterId: 'a' },
      ]),
    ).toThrow('cycle');
  });

  it('creates review-only merge candidates for exact typed identity matches with conflict reasons', () => {
    const knowledge = backfillCharacterGraphKnowledgeV2({
      ...graph,
      characters: [
        { ...graph.characters[0]!, canonicalName: 'Alice', aliases: ['Alex'], isUserConfirmed: true },
        { ...graph.characters[1]!, canonicalName: 'Bob', aliases: ['Alex'], isUserConfirmed: true },
      ],
    });
    const candidates = deriveCharacterMergeCandidatesV2(knowledge);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      status: 'open',
      positiveReasons: ['exact_name_or_typed_alias_match'],
      negativeReasons: expect.arrayContaining(['both_characters_user_confirmed', 'canonical_names_differ']),
    });
  });
});
