import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { resourceGraphRevision } from '@noveldesk/text-core/identity/sync';
import type { Character, LabeledSegment, VoiceProfile } from '../domain/types';
import type { CharacterGraph, CharacterRelation } from './ai';
import {
  resolveCharacterRedirect,
  type CharacterGraphKnowledgeV2,
  type CharacterIdentityCommandV2,
  type CharacterIdentityOperationResultV2,
  type CharacterIdRedirectV2,
} from './character-graph-v2';

const characterGraphRevision = (characters: readonly Character[], relations: readonly { id: string }[]) =>
  resourceGraphRevision('character_graph', characters, relations);

export class CharacterIdentityConflictError extends Error {
  constructor(
    message: string,
    readonly reason:
      'operation_reused' | 'graph_changed' | 'character_missing' | 'redirect_conflict' | 'invalid_selection',
  ) {
    super(message);
    this.name = 'CharacterIdentityConflictError';
  }
}

export interface CharacterIdentityOperationPlanV2 {
  readonly commandHash: string;
  readonly graph: CharacterGraph;
  readonly knowledge: CharacterGraphKnowledgeV2;
  readonly segments: readonly LabeledSegment[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly result: CharacterIdentityOperationResultV2;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function mergeCharacter(target: Character, source: Character): Character {
  return {
    ...target,
    canonicalName: target.isUserConfirmed ? target.canonicalName : target.canonicalName || source.canonicalName,
    aliases: unique([target.canonicalName, ...target.aliases, source.canonicalName, ...source.aliases]).filter(
      (alias) => alias !== target.canonicalName,
    ),
    description: target.isUserConfirmed ? target.description : (target.description ?? source.description),
    confidence: Math.max(target.confidence, source.confidence),
    isUserConfirmed: target.isUserConfirmed || source.isUserConfirmed,
  };
}

function remapRelation(relation: CharacterRelation, sourceId: string, targetId: string): CharacterRelation | undefined {
  const sourceCharacterId = relation.sourceCharacterId === sourceId ? targetId : relation.sourceCharacterId;
  const targetCharacterId = relation.targetCharacterId === sourceId ? targetId : relation.targetCharacterId;
  if (sourceCharacterId === targetCharacterId) return undefined;
  return { ...relation, sourceCharacterId, targetCharacterId };
}

function dedupeRelations(relations: readonly CharacterRelation[]): CharacterRelation[] {
  const byKey = new Map<string, CharacterRelation>();
  for (const relation of relations) {
    const key = `${relation.sourceCharacterId}:${relation.targetCharacterId}:${relation.relationLabel}`;
    const existing = byKey.get(key);
    if (!existing || relation.confidence > existing.confidence) byKey.set(key, relation);
  }
  return [...byKey.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function remapSegment(segment: LabeledSegment, sourceId: string, targetId: string): LabeledSegment {
  const speakerId = segment.speakerId === sourceId ? targetId : segment.speakerId;
  const candidateSpeakers = unique(segment.candidateSpeakers.map((id) => (id === sourceId ? targetId : id)));
  const listenerIds = unique(segment.listenerIds.map((id) => (id === sourceId ? targetId : id)));
  if (
    speakerId === segment.speakerId &&
    candidateSpeakers.join('\u0000') === [...segment.candidateSpeakers].sort().join('\u0000') &&
    listenerIds.join('\u0000') === [...segment.listenerIds].sort().join('\u0000')
  ) {
    return segment;
  }
  return {
    ...segment,
    speakerId,
    candidateSpeakers,
    listenerIds,
    voiceProfileId: speakerId !== segment.speakerId ? undefined : segment.voiceProfileId,
  };
}

function validityChapterIndexes(knowledge: CharacterGraphKnowledgeV2, ids: ReadonlySet<string>): number[] {
  const values = [
    ...knowledge.facts.filter((item) => ids.has(item.id)).map((item) => item.validity.fromChapterIndex),
    ...knowledge.mentions.filter((item) => ids.has(item.id)).map((item) => item.validity.fromChapterIndex),
    ...knowledge.addressTerms.filter((item) => ids.has(item.id)).map((item) => item.validity.fromChapterIndex),
    ...knowledge.speechTraits.filter((item) => ids.has(item.id)).map((item) => item.validity.fromChapterIndex),
    ...knowledge.relationFacts.filter((item) => ids.has(item.id)).map((item) => item.validity.fromChapterIndex),
  ];
  return [...new Set(values)].sort((a, b) => a - b);
}

function planMerge(input: {
  readonly command: Extract<CharacterIdentityCommandV2, { kind: 'merge_characters_v2' }>;
  readonly graph: CharacterGraph;
  readonly knowledge: CharacterGraphKnowledgeV2;
  readonly segments: readonly LabeledSegment[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly chapterIndexById?: Readonly<Record<string, number>>;
}): CharacterIdentityOperationPlanV2 {
  const { command } = input;
  const sourceId = resolveCharacterRedirect(command.sourceCharacterId, input.knowledge.redirects);
  const targetId = resolveCharacterRedirect(command.targetCharacterId, input.knowledge.redirects);
  if (sourceId === targetId)
    throw new CharacterIdentityConflictError('Characters already resolve to the same id', 'redirect_conflict');
  const source = input.graph.characters.find((character) => character.id === sourceId);
  const target = input.graph.characters.find((character) => character.id === targetId);
  if (!source || !target) throw new CharacterIdentityConflictError('Merge character is missing', 'character_missing');
  const selected = new Set(command.selectedFactIds);
  const invalidFact = input.knowledge.facts.find(
    (fact) => selected.has(fact.id) && ![sourceId, targetId].includes(fact.characterId),
  );
  if (invalidFact)
    throw new CharacterIdentityConflictError('Selected fact is outside the merge pair', 'invalid_selection');

  const characters = input.graph.characters
    .filter((character) => character.id !== sourceId && character.id !== targetId)
    .concat(mergeCharacter(target, source))
    .sort((left, right) => left.id.localeCompare(right.id));
  const relations = dedupeRelations(
    input.graph.relations.flatMap((relation) => {
      const mapped = remapRelation(relation, sourceId, targetId);
      return mapped ? [mapped] : [];
    }),
  );
  const redirect: CharacterIdRedirectV2 = {
    id: persistentId128('character_redirect_v2', [input.graph.novelId, sourceId, targetId]),
    novelId: input.graph.novelId,
    sourceCharacterId: sourceId,
    targetCharacterId: targetId,
    operationId: command.operationId,
    graphRevision: command.expectedGraphRevision,
    createdAt: command.createdAt,
  };
  const moveCharacterId = (characterId: string) => (characterId === sourceId ? targetId : characterId);
  const relationFacts = input.knowledge.relationFacts.flatMap((relation) => {
    const mapped = remapRelation(relation, sourceId, targetId);
    return mapped ? [{ ...relation, ...mapped }] : [];
  });
  const knowledge: CharacterGraphKnowledgeV2 = {
    ...input.knowledge,
    facts: input.knowledge.facts.map((fact) =>
      fact.characterId === sourceId ? { ...fact, characterId: targetId } : fact,
    ),
    mentions: input.knowledge.mentions.map((mention) =>
      mention.characterId === sourceId ? { ...mention, characterId: targetId } : mention,
    ),
    addressTerms: input.knowledge.addressTerms.map((term) => ({
      ...term,
      speakerCharacterId: term.speakerCharacterId ? moveCharacterId(term.speakerCharacterId) : undefined,
      targetCharacterId: moveCharacterId(term.targetCharacterId),
    })),
    speechTraits: input.knowledge.speechTraits.map((trait) =>
      trait.characterId === sourceId ? { ...trait, characterId: targetId } : trait,
    ),
    relationFacts,
    mergeCandidates: input.knowledge.mergeCandidates.map((candidate) =>
      [candidate.sourceCharacterId, candidate.targetCharacterId].includes(sourceId)
        ? { ...candidate, status: 'accepted' }
        : candidate,
    ),
    redirects: [...input.knowledge.redirects, redirect],
  };
  const sourceProfiles = input.voiceProfiles.filter((profile) => profile.characterId === sourceId);
  const targetProfiles = input.voiceProfiles.filter((profile) => profile.characterId === targetId);
  const voiceConflict = sourceProfiles.length > 0 && targetProfiles.length > 0;
  const voiceProfiles = input.voiceProfiles.flatMap((profile) => {
    if (profile.characterId !== sourceId) return [profile];
    if (!voiceConflict) return [{ ...profile, characterId: targetId }];
    return command.voiceConflictPolicy === 'keep_target' ? [] : [{ ...profile, characterId: undefined }];
  });
  const segments = input.segments.map((segment) => remapSegment(segment, sourceId, targetId));
  const affectedChapterIndexes = unique(
    segments
      .filter((segment, index) => segment !== input.segments[index])
      .map((segment) => String(input.chapterIndexById?.[segment.chapterId] ?? '')),
  ).map(Number);
  const graph = { novelId: input.graph.novelId, characters, relations };
  const graphRevision = characterGraphRevision(characters, relations);
  return {
    commandHash: structuredIntegrityHash(command),
    graph,
    knowledge: {
      ...knowledge,
      redirects: knowledge.redirects.map((item) => (item.id === redirect.id ? { ...item, graphRevision } : item)),
    },
    segments,
    voiceProfiles,
    result: {
      operationId: command.operationId,
      graphRevision,
      redirect: { ...redirect, graphRevision },
      affectedCharacterIds: [sourceId, targetId],
      affectedChapterIndexes,
      voiceConflictCharacterIds: voiceConflict ? [sourceId, targetId] : [],
      invalidation: {
        relabelFromChapterIndex: affectedChapterIndexes.at(0),
        staleReviewArtifactIds: [],
        staleTTSCharacterIds: [sourceId, targetId],
      },
    },
  };
}

function planSplit(input: {
  readonly command: Extract<CharacterIdentityCommandV2, { kind: 'split_character_v2' }>;
  readonly graph: CharacterGraph;
  readonly knowledge: CharacterGraphKnowledgeV2;
  readonly segments: readonly LabeledSegment[];
  readonly voiceProfiles: readonly VoiceProfile[];
}): CharacterIdentityOperationPlanV2 {
  const { command } = input;
  const sourceId = resolveCharacterRedirect(command.sourceCharacterId, input.knowledge.redirects);
  if (!input.graph.characters.some((character) => character.id === sourceId)) {
    throw new CharacterIdentityConflictError('Split source character is missing', 'character_missing');
  }
  if (input.graph.characters.some((character) => character.id === command.newCharacter.id)) {
    throw new CharacterIdentityConflictError('Split character id already exists', 'redirect_conflict');
  }
  if (command.newCharacter.novelId !== input.graph.novelId) {
    throw new CharacterIdentityConflictError('Split character is outside the graph', 'invalid_selection');
  }
  const factIds = new Set(command.movedFactIds);
  const mentionIds = new Set(command.movedMentionIds);
  if (
    input.knowledge.facts.some((fact) => factIds.has(fact.id) && fact.characterId !== sourceId) ||
    input.knowledge.mentions.some(
      (mention) => mentionIds.has(mention.id) && mention.characterId !== undefined && mention.characterId !== sourceId,
    )
  ) {
    throw new CharacterIdentityConflictError('Split selection is outside the source character', 'invalid_selection');
  }
  const characters = [...input.graph.characters, command.newCharacter].sort((a, b) => a.id.localeCompare(b.id));
  const knowledge: CharacterGraphKnowledgeV2 = {
    ...input.knowledge,
    facts: input.knowledge.facts.map((fact) =>
      factIds.has(fact.id) ? { ...fact, characterId: command.newCharacter.id } : fact,
    ),
    mentions: input.knowledge.mentions.map((mention) =>
      mentionIds.has(mention.id) ? { ...mention, characterId: command.newCharacter.id } : mention,
    ),
  };
  const affectedChapterIndexes = validityChapterIndexes(knowledge, new Set([...factIds, ...mentionIds]));
  const graphRevision = characterGraphRevision(characters, input.graph.relations);
  return {
    commandHash: structuredIntegrityHash(command),
    graph: { ...input.graph, characters },
    knowledge,
    segments: input.segments,
    voiceProfiles: input.voiceProfiles,
    result: {
      operationId: command.operationId,
      graphRevision,
      createdCharacterId: command.newCharacter.id,
      affectedCharacterIds: [sourceId, command.newCharacter.id],
      affectedChapterIndexes,
      voiceConflictCharacterIds: [],
      invalidation: {
        relabelFromChapterIndex: affectedChapterIndexes.at(0),
        staleReviewArtifactIds: [],
        staleTTSCharacterIds: [sourceId, command.newCharacter.id],
      },
    },
  };
}

export function buildCharacterIdentityOperationPlanV2(input: {
  readonly command: CharacterIdentityCommandV2;
  readonly graph: CharacterGraph;
  readonly knowledge: CharacterGraphKnowledgeV2;
  readonly segments: readonly LabeledSegment[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly chapterIndexById?: Readonly<Record<string, number>>;
}): CharacterIdentityOperationPlanV2 {
  const actualRevision = characterGraphRevision(input.graph.characters, input.graph.relations);
  if (input.command.expectedGraphRevision !== actualRevision) {
    throw new CharacterIdentityConflictError('Character graph changed before identity operation', 'graph_changed');
  }
  return input.command.kind === 'merge_characters_v2'
    ? planMerge({ ...input, command: input.command })
    : planSplit({ ...input, command: input.command });
}
