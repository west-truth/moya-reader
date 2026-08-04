import { describe, expect, it } from 'vitest';
import { characterGraphRevision } from '../domain/resource-revisions';
import type { Character, LabeledSegment, VoiceProfile } from '../domain/types';
import { backfillCharacterGraphKnowledgeV2 } from './character-graph-v2';
import { buildCharacterIdentityOperationPlanV2, CharacterIdentityConflictError } from './character-identity-operation';
import type { CharacterGraph } from './ai';

const source: Character = {
  id: 'character-source',
  novelId: 'book-1',
  canonicalName: '서윤 후보',
  aliases: ['서윤'],
  color: '#111111',
  confidence: 0.7,
  isUserConfirmed: false,
};
const target: Character = {
  id: 'character-target',
  novelId: 'book-1',
  canonicalName: '한서윤',
  aliases: ['팀장님'],
  color: '#222222',
  description: 'confirmed',
  confidence: 1,
  isUserConfirmed: true,
};
const graph: CharacterGraph = {
  novelId: 'book-1',
  characters: [source, target],
  relations: [],
};
const segment: LabeledSegment = {
  id: 'segment-1',
  novelId: 'book-1',
  chapterId: 'chapter-1',
  paragraphId: 'paragraph-1',
  segmentIndex: 0,
  startOffset: 0,
  endOffset: 2,
  segmentTextHash: 'sha256:text',
  type: 'quoted_dialogue',
  speakerId: source.id,
  candidateSpeakers: [source.id],
  listenerIds: [target.id],
  emotion: 'neutral',
  confidence: 0.7,
  voiceProfileId: 'voice-source',
  isUserCorrected: false,
};
const voice = (id: string, characterId: string): VoiceProfile => ({
  id,
  novelId: 'book-1',
  characterId,
  role: 'character',
  providerId: 'openai-tts',
  providerVoiceId: id,
  label: id,
  speed: 1,
  isUserSelected: true,
});

describe('buildCharacterIdentityOperationPlanV2', () => {
  it('merges identity references while preserving the confirmed target and reporting voice conflicts', () => {
    const knowledge = backfillCharacterGraphKnowledgeV2(graph);
    const command = {
      kind: 'merge_characters_v2' as const,
      operationId: 'operation-merge',
      novelId: 'book-1',
      sourceCharacterId: source.id,
      targetCharacterId: target.id,
      expectedGraphRevision: characterGraphRevision(graph.characters, graph.relations),
      selectedFactIds: knowledge.facts.filter((fact) => fact.characterId === source.id).map((fact) => fact.id),
      voiceConflictPolicy: 'require_review' as const,
      createdAt: '2026-07-11T00:00:00.000Z',
    };

    const plan = buildCharacterIdentityOperationPlanV2({
      command,
      graph,
      knowledge,
      segments: [segment],
      voiceProfiles: [voice('voice-source', source.id), voice('voice-target', target.id)],
      chapterIndexById: { 'chapter-1': 4 },
    });

    expect(plan.graph.characters).toEqual([
      expect.objectContaining({
        id: target.id,
        canonicalName: target.canonicalName,
        description: target.description,
        aliases: expect.arrayContaining(['서윤 후보', '서윤', '팀장님']),
        isUserConfirmed: true,
      }),
    ]);
    expect(plan.segments[0]).toMatchObject({ speakerId: target.id, voiceProfileId: undefined });
    expect(plan.result).toMatchObject({
      affectedChapterIndexes: [4],
      voiceConflictCharacterIds: [source.id, target.id],
      redirect: { sourceCharacterId: source.id, targetCharacterId: target.id },
    });
    expect(plan.knowledge.facts.filter((fact) => fact.lockedByUser)).toHaveLength(2);
  });

  it('splits only explicitly selected facts and never redistributes existing labels', () => {
    const knowledge = backfillCharacterGraphKnowledgeV2({ ...graph, characters: [target] });
    const aliasFact = knowledge.facts.find((fact) => fact.field === 'typed_alias')!;
    const newCharacter = { ...source, id: 'character-split', canonicalName: '별도 인물', aliases: [] };
    const plan = buildCharacterIdentityOperationPlanV2({
      command: {
        kind: 'split_character_v2',
        operationId: 'operation-split',
        novelId: 'book-1',
        sourceCharacterId: target.id,
        newCharacter,
        expectedGraphRevision: characterGraphRevision([target], []),
        movedFactIds: [aliasFact.id],
        movedMentionIds: [],
        movedEvidenceIds: [],
        createdAt: '2026-07-11T00:00:00.000Z',
      },
      graph: { novelId: 'book-1', characters: [target], relations: [] },
      knowledge,
      segments: [segment],
      voiceProfiles: [],
    });

    expect(plan.knowledge.facts.find((fact) => fact.id === aliasFact.id)?.characterId).toBe(newCharacter.id);
    expect(plan.segments).toEqual([segment]);
    expect(plan.result.createdCharacterId).toBe(newCharacter.id);
  });

  it('rejects stale graph revisions before planning a mutation', () => {
    expect(() =>
      buildCharacterIdentityOperationPlanV2({
        command: {
          kind: 'merge_characters_v2',
          operationId: 'stale',
          novelId: 'book-1',
          sourceCharacterId: source.id,
          targetCharacterId: target.id,
          expectedGraphRevision: 'stale',
          selectedFactIds: [],
          voiceConflictPolicy: 'require_review',
          createdAt: '2026-07-11T00:00:00.000Z',
        },
        graph,
        knowledge: backfillCharacterGraphKnowledgeV2(graph),
        segments: [],
        voiceProfiles: [],
      }),
    ).toThrow(CharacterIdentityConflictError);
  });
});
