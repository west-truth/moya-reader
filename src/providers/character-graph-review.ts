import type { Character } from '../domain/types';
import type { CharacterGraph, CharacterRelation } from './ai';
import { normalizeCharacterGraphSnapshot } from './character-graph-snapshot';

export type CharacterGraphCandidateReason =
  | 'new_character'
  | 'existing_id'
  | 'possible_duplicate'
  | 'low_confidence';

export interface CharacterGraphReviewCandidate {
  readonly character: Character;
  readonly reasons: CharacterGraphCandidateReason[];
  readonly matchedExistingCharacter?: Character;
  readonly matchedBy?: 'id' | 'canonical_name' | 'alias' | 'possible_existing_id';
  readonly excluded: boolean;
}

export interface CharacterGraphReviewRelation {
  readonly relation: CharacterRelation;
  readonly valid: boolean;
  readonly reason?: 'excluded_character' | 'missing_character' | 'self_relation';
}

export interface CharacterGraphReviewResult {
  readonly reviewedGraph: CharacterGraph;
  readonly candidates: CharacterGraphReviewCandidate[];
  readonly relations: CharacterGraphReviewRelation[];
  readonly parseError?: string;
  readonly newCandidateCount: number;
  readonly duplicateCandidateCount: number;
  readonly lowConfidenceCount: number;
  readonly excludedCharacterCount: number;
  readonly invalidRelationCount: number;
}

export interface BuildCharacterGraphReviewInput {
  readonly novelId: string;
  readonly discoveredGraph: unknown;
  readonly existingCharacters: readonly Character[];
  readonly excludedCharacterIds?: ReadonlySet<string> | readonly string[];
  readonly lowConfidenceThreshold?: number;
}

const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.55;

export function buildCharacterGraphReview(input: BuildCharacterGraphReviewInput): CharacterGraphReviewResult {
  const emptyGraph: CharacterGraph = { novelId: input.novelId, characters: [], relations: [] };
  let graph: CharacterGraph;
  try {
    graph = normalizeCharacterGraphSnapshot(input.discoveredGraph, input.novelId);
  } catch (error) {
    return {
      reviewedGraph: emptyGraph,
      candidates: [],
      relations: [],
      parseError: error instanceof Error ? error.message : String(error),
      newCandidateCount: 0,
      duplicateCandidateCount: 0,
      lowConfidenceCount: 0,
      excludedCharacterCount: 0,
      invalidRelationCount: 0,
    };
  }

  const excludedIds = excludedIdSet(input.excludedCharacterIds);
  const nameIndex = buildExistingNameIndex(input.existingCharacters);
  const existingById = new Map(input.existingCharacters.map((character) => [character.id, character]));
  const threshold = input.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD;
  const candidates = graph.characters.map((character) =>
    buildReviewCandidate({
      character,
      existingById,
      nameIndex,
      excluded: excludedIds.has(character.id),
      lowConfidenceThreshold: threshold,
    }),
  );
  const includedCharacters = graph.characters.filter((character) => !excludedIds.has(character.id));
  const includedIds = new Set(includedCharacters.map((character) => character.id));
  const relations = graph.relations.map((relation) => reviewRelation(relation, includedIds, excludedIds));
  const includedRelations = relations
    .filter((item) => item.valid)
    .map((item) => item.relation);

  return {
    reviewedGraph: {
      novelId: graph.novelId,
      characters: includedCharacters,
      relations: includedRelations,
    },
    candidates,
    relations,
    newCandidateCount: candidates.filter((item) => item.reasons.includes('new_character')).length,
    duplicateCandidateCount: candidates.filter((item) => item.reasons.includes('possible_duplicate') || item.reasons.includes('existing_id')).length,
    lowConfidenceCount: candidates.filter((item) => item.reasons.includes('low_confidence')).length,
    excludedCharacterCount: candidates.filter((item) => item.excluded).length,
    invalidRelationCount: relations.filter((item) => !item.valid).length,
  };
}

interface BuildReviewCandidateInput {
  readonly character: Character;
  readonly existingById: ReadonlyMap<string, Character>;
  readonly nameIndex: ReadonlyMap<string, { character: Character; matchedBy: 'canonical_name' | 'alias' }>;
  readonly excluded: boolean;
  readonly lowConfidenceThreshold: number;
}

function buildReviewCandidate(input: BuildReviewCandidateInput): CharacterGraphReviewCandidate {
  const byId = input.existingById.get(input.character.id);
  const byHint = byId ? undefined : findPossibleExistingHintMatch(input.character, input.existingById);
  const byName = byId || byHint ? undefined : findExistingNameMatch(input.character, input.nameIndex);
  const reasons: CharacterGraphCandidateReason[] = [];
  if (byId) reasons.push('existing_id');
  if (byHint || byName) reasons.push('possible_duplicate');
  if (!byId && !byHint && !byName) reasons.push('new_character');
  if (input.character.confidence < input.lowConfidenceThreshold) reasons.push('low_confidence');
  return {
    character: input.character,
    reasons,
    matchedExistingCharacter: byId ?? byHint ?? byName?.character,
    matchedBy: byId ? 'id' : byHint ? 'possible_existing_id' : byName?.matchedBy,
    excluded: input.excluded,
  };
}

function reviewRelation(
  relation: CharacterRelation,
  includedIds: ReadonlySet<string>,
  excludedIds: ReadonlySet<string>,
): CharacterGraphReviewRelation {
  if (relation.sourceCharacterId === relation.targetCharacterId) {
    return { relation, valid: false, reason: 'self_relation' };
  }
  if (excludedIds.has(relation.sourceCharacterId) || excludedIds.has(relation.targetCharacterId)) {
    return { relation, valid: false, reason: 'excluded_character' };
  }
  if (!includedIds.has(relation.sourceCharacterId) || !includedIds.has(relation.targetCharacterId)) {
    return { relation, valid: false, reason: 'missing_character' };
  }
  return { relation, valid: true };
}

function excludedIdSet(value: BuildCharacterGraphReviewInput['excludedCharacterIds']): Set<string> {
  if (!value) return new Set();
  return Array.isArray(value)
    ? new Set(value.filter(Boolean))
    : new Set([...value].filter(Boolean));
}

function buildExistingNameIndex(
  existingCharacters: readonly Character[],
): Map<string, { character: Character; matchedBy: 'canonical_name' | 'alias' }> {
  const index = new Map<string, { character: Character; matchedBy: 'canonical_name' | 'alias' }>();
  for (const character of existingCharacters) {
    addNameIndexEntry(index, character.canonicalName, character, 'canonical_name');
    for (const alias of character.aliases) addNameIndexEntry(index, alias, character, 'alias');
  }
  return index;
}

function addNameIndexEntry(
  index: Map<string, { character: Character; matchedBy: 'canonical_name' | 'alias' }>,
  value: string,
  character: Character,
  matchedBy: 'canonical_name' | 'alias',
): void {
  const normalized = normalizedName(value);
  if (normalized && !index.has(normalized)) index.set(normalized, { character, matchedBy });
}

function findExistingNameMatch(
  character: Character,
  nameIndex: ReadonlyMap<string, { character: Character; matchedBy: 'canonical_name' | 'alias' }>,
): { character: Character; matchedBy: 'canonical_name' | 'alias' } | undefined {
  const names = [character.canonicalName, ...character.aliases];
  for (const name of names) {
    const match = nameIndex.get(normalizedName(name));
    if (match) return match;
  }
  return undefined;
}

function findPossibleExistingHintMatch(
  character: Character,
  existingById: ReadonlyMap<string, Character>,
): Character | undefined {
  const possibleIds = possibleExistingCharacterIds(character.description);
  for (const id of possibleIds) {
    const match = existingById.get(id);
    if (match) return match;
  }
  return undefined;
}

function possibleExistingCharacterIds(description: string | undefined): string[] {
  if (!description) return [];
  const match = /^possible_existing:\s*([^\n]+)/im.exec(description);
  if (!match) return [];
  return match[1].split(',').map((id) => id.trim()).filter(Boolean);
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ');
}
