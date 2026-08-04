import { describe, expect, it } from 'vitest';
import type { Character, Paragraph, UserCorrection } from '../domain/types';
import type { CharacterGraph, ChapterLabelingPreviousContext } from '../providers/ai';
import { buildChapterLabelingPromptPayload } from '../providers/chapter-labeling-payload';
import {
  assertLabelingContextPacketAdmitted,
  buildLabelingContextPacket,
  LabelingContextBudgetExceededError,
} from '../providers/labeling-context-packet';
import { backfillCharacterGraphKnowledgeV2 } from '../providers/character-graph-v2';

function paragraph(id: string, index: number, text: string): Paragraph {
  return {
    id,
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index,
    text,
    startOffsetInChapter: index * 100,
    endOffsetInChapter: index * 100 + text.length,
    textHash: `hash_${id}`,
  };
}

function character(id: string, name: string, aliases: string[] = [], confirmed = false): Character {
  return {
    id,
    novelId: 'book_1',
    canonicalName: name,
    aliases,
    color: '#334455',
    confidence: 0.9,
    isUserConfirmed: confirmed,
  };
}

const graph: CharacterGraph = {
  novelId: 'book_1',
  characters: [
    character('char_a', '서윤', ['윤아']),
    character('char_b', '민호', ['팀장님']),
    character('char_c', '지수'),
    character('char_unrelated', '등장하지 않는 사람'),
  ],
  relations: [
    {
      id: 'rel_ab',
      novelId: 'book_1',
      sourceCharacterId: 'char_a',
      targetCharacterId: 'char_b',
      relationLabel: '동료',
      termsUsedBySource: ['팀장님'],
      termsUsedByTarget: ['윤아'],
      confidence: 0.9,
    },
  ],
};

const previousContext: ChapterLabelingPreviousContext = {
  version: 'episode-context-v2',
  chapterId: 'chapter_0',
  summary: '서윤과 민호가 사무실에서 대화 중이다.',
  scene: '사무실',
  activeCharacterIds: ['char_a', 'char_b'],
  unresolved: ['지수가 누구에게 전화했는지 불명'],
  recentTurns: [
    {
      paragraphId: 'previous_1',
      speakerId: 'char_b',
      listenerIds: ['char_a'],
      emotion: 'calm',
      text: '윤아, 지금 괜찮아?',
    },
  ],
};

const corrections: UserCorrection[] = [
  {
    id: 'correction_direct',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    paragraphId: 'p10',
    correctionType: 'speaker',
    beforeJson: JSON.stringify({ speakerId: 'char_b', privateNoise: 'must-not-be-sent' }),
    afterJson: JSON.stringify({ speakerId: 'char_a' }),
    applyScope: 'chapter',
    createdAt: '2026-07-11T01:00:00.000Z',
  },
  {
    id: 'correction_global',
    novelId: 'book_1',
    chapterId: 'chapter_0',
    correctionType: 'speaker',
    afterJson: JSON.stringify({ alias: '지수', characterId: 'char_c' }),
    applyScope: 'global',
    createdAt: '2026-07-10T01:00:00.000Z',
  },
];

describe('LabelingContextPacketV2', () => {
  it('selects deterministic halo, recent turns, graph slice, and normalized corrections', () => {
    const target = [paragraph('p10', 10, '"팀장님, 지수가 연락했어요." 서윤이 말했다.')];
    const halo = [paragraph('p9', 9, '민호는 서윤을 바라봤다.'), paragraph('p11', 11, '전화벨이 다시 울렸다.')];
    const input = {
      novelId: 'book_1',
      chapterId: 'chapter_1',
      targetParagraphs: target,
      haloParagraphs: halo,
      characterGraph: graph,
      previousEpisodeContext: previousContext,
      corrections,
      providerId: 'gemini-vertex',
      modelId: 'model_1',
      providerOptions: { contextWindowTokens: 32_768, maxOutputTokens: 4_096 },
      staticInstructionCharacters: 500,
      schemaCharacters: 500,
    } as const;

    const first = buildLabelingContextPacket(input);
    const second = buildLabelingContextPacket(input);

    expect(second).toEqual(first);
    expect(first.targetParagraphIds).toEqual(['p10']);
    expect(first.halo.map((item) => [item.paragraphId, item.side])).toEqual([
      ['p9', 'before'],
      ['p11', 'after'],
    ]);
    expect(first.sceneContext?.recentTurns?.[0]?.speakerId).toBe('char_b');
    expect(first.relevantCharacterGraph.characters.map((item) => item.id)).toEqual(['char_a', 'char_b', 'char_c']);
    expect(first.relevantCharacterGraph.characters.map((item) => item.id)).not.toContain('char_unrelated');
    expect(first.correctionMemory.map((item) => item.correctionId)).toEqual(['correction_direct', 'correction_global']);
    expect(JSON.stringify(first.correctionMemory)).not.toContain('must-not-be-sent');
    expect(first.budget.admission).toBe('accepted');
    expect(first.capability.tokenCountMode).toBe('estimated_characters');
  });

  it('serializes only the v2 packet instead of repeating full graph and raw corrections', () => {
    const target = [paragraph('p10', 10, '서윤이 팀장님을 불렀다.')];
    const packet = buildLabelingContextPacket({
      novelId: 'book_1',
      chapterId: 'chapter_1',
      targetParagraphs: target,
      characterGraph: graph,
      previousEpisodeContext: previousContext,
      corrections,
      providerId: 'openai',
      modelId: 'model_1',
      staticInstructionCharacters: 100,
      schemaCharacters: 100,
    });
    const payload = buildChapterLabelingPromptPayload(
      {
        novelId: 'book_1',
        chapter: {
          id: 'chapter_1',
          novelId: 'book_1',
          index: 1,
          title: '1화',
          normalizedText: '',
          textHash: 'chapter_hash',
          rawStartOffset: 0,
          rawEndOffset: 20,
          characterCount: 20,
          paragraphCount: 1,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        },
        paragraphs: target,
        knownCharacters: graph.characters,
        characterGraph: graph,
        previousEpisodeContext: previousContext,
        userCorrections: corrections,
        contextPacket: packet,
      },
      { requestProfileId: 'profile', promptVersion: 'prompt', schemaVersion: 'schema' },
    );

    expect(payload.labeling_context_packet).toBeTruthy();
    expect(payload.known_characters).toBeUndefined();
    expect(payload.character_graph).toBeUndefined();
    expect(payload.previous_episode_context).toBeUndefined();
    expect(payload.user_corrections).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('must-not-be-sent');
  });

  it('rejects a minimum target that cannot fit after optional context is removed', () => {
    const packet = buildLabelingContextPacket({
      novelId: 'book_1',
      chapterId: 'chapter_1',
      targetParagraphs: [paragraph('p1', 1, '가'.repeat(2_000))],
      characterGraph: graph,
      previousEpisodeContext: previousContext,
      corrections,
      providerId: 'anthropic',
      providerOptions: {
        contextWindowTokens: 2_000,
        maxOutputTokens: 1_000,
        contextSafetyFactor: 0.8,
      },
      staticInstructionCharacters: 1_000,
      schemaCharacters: 1_000,
    });

    expect(packet.budget.admission).toBe('rejected');
    expect(packet.selectionTrace.warnings).toContain('minimum_target_exceeds_model_input_budget');
    expect(() => assertLabelingContextPacketAdmitted(packet)).toThrow(LabelingContextBudgetExceededError);
  });

  it('applies v2 relation and address facts only inside their chapter validity range', () => {
    const base = backfillCharacterGraphKnowledgeV2(graph);
    const knowledge = {
      ...base,
      relationFacts: [{ ...base.relationFacts[0]!, validity: { fromChapterIndex: 5 } }],
      addressTerms: [
        {
          id: 'address-1',
          novelId: 'book_1',
          speakerCharacterId: 'char_a',
          targetCharacterId: 'char_b',
          surface: '팀장님',
          normalizedSurface: '팀장님',
          direction: 'speaker_to_target' as const,
          confidence: 1,
          status: 'active' as const,
          validity: { fromChapterIndex: 2, toChapterIndex: 4 },
          evidenceIds: [],
        },
      ],
    };
    const early = buildLabelingContextPacket({
      novelId: 'book_1',
      chapterId: 'chapter_1',
      chapterIndex: 3,
      targetParagraphs: [paragraph('p1', 1, '서윤이 팀장님을 불렀다.')],
      characterGraph: graph,
      characterGraphKnowledge: knowledge,
      providerId: 'openai',
    });
    const late = buildLabelingContextPacket({
      novelId: 'book_1',
      chapterId: 'chapter_1',
      chapterIndex: 6,
      targetParagraphs: [paragraph('p1', 1, '서윤과 민호가 대화했다.')],
      characterGraph: graph,
      characterGraphKnowledge: knowledge,
      providerId: 'openai',
    });

    expect(early.characterKnowledge?.addressTerms).toHaveLength(1);
    expect(early.characterKnowledge?.graph.relations).toEqual([]);
    expect(late.characterKnowledge?.addressTerms).toEqual([]);
    expect(late.characterKnowledge?.graph.relations).toHaveLength(1);
  });
});
