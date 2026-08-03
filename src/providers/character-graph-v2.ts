import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { Character } from '../domain/types';
import type { CharacterGraph, CharacterRelation } from './ai';

export const CHARACTER_GRAPH_KNOWLEDGE_VERSION = 'character-graph-knowledge-v2' as const;

export interface CharacterFactValidityV2 {
  readonly fromChapterIndex: number;
  readonly toChapterIndex?: number;
  readonly sceneId?: string;
}

export interface CharacterEvidenceRefV2 {
  readonly id: string;
  readonly novelId: string;
  readonly chapterId: string;
  readonly paragraphId?: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly sourceHash: string;
  readonly observationCode: string;
  readonly note?: string;
}

export type CharacterFactFieldV2 =
  'canonical_name' | 'typed_alias' | 'description' | 'gender' | 'role' | 'speech_trait';

export interface CharacterFieldFactV2 {
  readonly id: string;
  readonly novelId: string;
  readonly characterId: string;
  readonly field: CharacterFactFieldV2;
  readonly value: string;
  readonly aliasType?: 'name' | 'title' | 'nickname' | 'untyped';
  readonly confidence: number;
  readonly status: 'active' | 'candidate' | 'rejected';
  readonly source: 'generated' | 'user' | 'legacy_backfill';
  readonly lockedByUser: boolean;
  readonly validity: CharacterFactValidityV2;
  readonly evidenceIds: readonly string[];
}

export interface CharacterMentionV2 {
  readonly id: string;
  readonly novelId: string;
  readonly characterId?: string;
  readonly surface: string;
  readonly normalizedSurface: string;
  readonly kind: 'name' | 'title' | 'generic_reference' | 'pronoun' | 'unknown';
  readonly confidence: number;
  readonly status: 'active' | 'candidate' | 'rejected';
  readonly validity: CharacterFactValidityV2;
  readonly evidenceIds: readonly string[];
}

export interface CharacterAddressTermV2 {
  readonly id: string;
  readonly novelId: string;
  readonly speakerCharacterId?: string;
  readonly targetCharacterId: string;
  readonly surface: string;
  readonly normalizedSurface: string;
  readonly direction: 'speaker_to_target' | 'narrator_reference' | 'unknown';
  readonly formality?: string;
  readonly confidence: number;
  readonly status: 'active' | 'candidate' | 'rejected';
  readonly validity: CharacterFactValidityV2;
  readonly evidenceIds: readonly string[];
}

export interface CharacterSpeechTraitV2 {
  readonly id: string;
  readonly novelId: string;
  readonly characterId: string;
  readonly trait: string;
  readonly value: string;
  readonly confidence: number;
  readonly status: 'active' | 'candidate' | 'rejected';
  readonly validity: CharacterFactValidityV2;
  readonly evidenceIds: readonly string[];
}

export interface CharacterRelationFactV2 extends CharacterRelation {
  readonly status: 'active' | 'candidate' | 'rejected';
  readonly validity: CharacterFactValidityV2;
  readonly evidenceIds: readonly string[];
  readonly lockedByUser: boolean;
}

export interface CharacterIdRedirectV2 {
  readonly id: string;
  readonly novelId: string;
  readonly sourceCharacterId: string;
  readonly targetCharacterId: string;
  readonly operationId: string;
  readonly graphRevision: string;
  readonly createdAt: string;
}

export interface CharacterMergeCandidateV2 {
  readonly id: string;
  readonly novelId: string;
  readonly sourceCharacterId: string;
  readonly targetCharacterId: string;
  readonly positiveReasons: readonly string[];
  readonly negativeReasons: readonly string[];
  readonly confidence: number;
  readonly status: 'open' | 'accepted' | 'rejected';
  readonly evidenceIds: readonly string[];
}

export interface CharacterGraphKnowledgeV2 {
  readonly version: typeof CHARACTER_GRAPH_KNOWLEDGE_VERSION;
  readonly novelId: string;
  readonly facts: readonly CharacterFieldFactV2[];
  readonly mentions: readonly CharacterMentionV2[];
  readonly addressTerms: readonly CharacterAddressTermV2[];
  readonly speechTraits: readonly CharacterSpeechTraitV2[];
  readonly relationFacts: readonly CharacterRelationFactV2[];
  readonly evidence: readonly CharacterEvidenceRefV2[];
  readonly mergeCandidates: readonly CharacterMergeCandidateV2[];
  readonly redirects: readonly CharacterIdRedirectV2[];
}

export interface CharacterGraphSliceV2 {
  readonly graph: CharacterGraph;
  readonly facts: readonly CharacterFieldFactV2[];
  readonly mentions: readonly CharacterMentionV2[];
  readonly addressTerms: readonly CharacterAddressTermV2[];
  readonly speechTraits: readonly CharacterSpeechTraitV2[];
  readonly evidence: readonly CharacterEvidenceRefV2[];
  readonly redirectMap: Readonly<Record<string, string>>;
}

export interface MergeCharactersCommandV2 {
  readonly kind: 'merge_characters_v2';
  readonly operationId: string;
  readonly novelId: string;
  readonly sourceCharacterId: string;
  readonly targetCharacterId: string;
  readonly expectedGraphRevision: string;
  readonly selectedFactIds: readonly string[];
  readonly voiceConflictPolicy: 'require_review' | 'keep_target';
  readonly createdAt: string;
}

export interface SplitCharacterCommandV2 {
  readonly kind: 'split_character_v2';
  readonly operationId: string;
  readonly novelId: string;
  readonly sourceCharacterId: string;
  readonly newCharacter: Character;
  readonly expectedGraphRevision: string;
  readonly movedFactIds: readonly string[];
  readonly movedMentionIds: readonly string[];
  readonly movedEvidenceIds: readonly string[];
  readonly createdAt: string;
}

export type CharacterIdentityCommandV2 = MergeCharactersCommandV2 | SplitCharacterCommandV2;

export interface CharacterIdentityOperationResultV2 {
  readonly operationId: string;
  readonly graphRevision: string;
  readonly redirect?: CharacterIdRedirectV2;
  readonly createdCharacterId?: string;
  readonly affectedCharacterIds: readonly string[];
  readonly affectedChapterIndexes: readonly number[];
  readonly voiceConflictCharacterIds: readonly string[];
  readonly invalidation: {
    readonly relabelFromChapterIndex?: number;
    readonly staleReviewArtifactIds: readonly string[];
    readonly staleTTSCharacterIds: readonly string[];
  };
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

export function parseCharacterIdentityCommandV2(value: unknown): CharacterIdentityCommandV2 {
  const body = recordValue(value, 'character identity command');
  const common = {
    operationId: requiredText(body.operationId, 'operationId'),
    novelId: requiredText(body.novelId, 'novelId'),
    sourceCharacterId: requiredText(body.sourceCharacterId, 'sourceCharacterId'),
    expectedGraphRevision: requiredText(body.expectedGraphRevision, 'expectedGraphRevision'),
    createdAt: new Date(requiredText(body.createdAt, 'createdAt')).toISOString(),
  };
  if (body.kind === 'merge_characters_v2') {
    if (body.voiceConflictPolicy !== 'require_review' && body.voiceConflictPolicy !== 'keep_target') {
      throw new Error('voiceConflictPolicy is invalid');
    }
    return {
      kind: body.kind,
      ...common,
      targetCharacterId: requiredText(body.targetCharacterId, 'targetCharacterId'),
      selectedFactIds: stringList(body.selectedFactIds, 'selectedFactIds'),
      voiceConflictPolicy: body.voiceConflictPolicy,
    };
  }
  if (body.kind !== 'split_character_v2') throw new Error('character identity command kind is invalid');
  const character = recordValue(body.newCharacter, 'newCharacter');
  const confidence = Number(character.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new Error('newCharacter.confidence is invalid');
  return {
    kind: body.kind,
    ...common,
    newCharacter: {
      id: requiredText(character.id, 'newCharacter.id'),
      novelId: requiredText(character.novelId, 'newCharacter.novelId'),
      canonicalName: requiredText(character.canonicalName, 'newCharacter.canonicalName'),
      aliases: stringList(character.aliases, 'newCharacter.aliases'),
      color: requiredText(character.color, 'newCharacter.color'),
      description: typeof character.description === 'string' ? character.description.trim() || undefined : undefined,
      confidence,
      isUserConfirmed: character.isUserConfirmed === true,
    },
    movedFactIds: stringList(body.movedFactIds, 'movedFactIds'),
    movedMentionIds: stringList(body.movedMentionIds, 'movedMentionIds'),
    movedEvidenceIds: stringList(body.movedEvidenceIds, 'movedEvidenceIds'),
  };
}

const GENERIC_REFERENCES = new Set([
  '그',
  '그녀',
  '그 남자',
  '그 여자',
  '남자',
  '여자',
  '아이',
  '소년',
  '소녀',
  '팀장',
  '사장',
  '선생',
  '선생님',
  '아저씨',
  '아줌마',
  'he',
  'she',
  'they',
  'the man',
  'the woman',
  'the child',
]);

export function normalizeCharacterSurface(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function isGenericCharacterReference(value: string): boolean {
  const normalized = normalizeCharacterSurface(value);
  return GENERIC_REFERENCES.has(normalized) || /^(그|저|이)\s*(사람|남자|여자|아이)$/u.test(normalized);
}

export function characterFactIsActiveAt(
  validity: CharacterFactValidityV2,
  chapterIndex: number,
  sceneId?: string,
): boolean {
  if (chapterIndex < validity.fromChapterIndex) return false;
  if (validity.toChapterIndex !== undefined && chapterIndex > validity.toChapterIndex) return false;
  return !validity.sceneId || !sceneId || validity.sceneId === sceneId;
}

export function resolveCharacterRedirect(characterId: string, redirects: readonly CharacterIdRedirectV2[]): string {
  const bySource = new Map(redirects.map((redirect) => [redirect.sourceCharacterId, redirect.targetCharacterId]));
  const visited = new Set<string>();
  let current = characterId;
  while (bySource.has(current)) {
    if (visited.has(current)) throw new Error(`Character redirect cycle detected: ${characterId}`);
    visited.add(current);
    current = bySource.get(current)!;
  }
  return current;
}

export function activeCharacterGraphFingerprintV2(graph: CharacterGraph, knowledge: CharacterGraphKnowledgeV2): string {
  return structuredIntegrityHash({
    graph,
    facts: knowledge.facts.filter((fact) => fact.status === 'active'),
    addressTerms: knowledge.addressTerms.filter((term) => term.status === 'active'),
    speechTraits: knowledge.speechTraits.filter((trait) => trait.status === 'active'),
    relationFacts: knowledge.relationFacts.filter((relation) => relation.status === 'active'),
    redirects: knowledge.redirects,
  });
}

export function backfillCharacterGraphKnowledgeV2(graph: CharacterGraph): CharacterGraphKnowledgeV2 {
  const facts: CharacterFieldFactV2[] = [];
  const mentions: CharacterMentionV2[] = [];
  for (const character of graph.characters) {
    const validity = { fromChapterIndex: 0 };
    facts.push({
      id: persistentId128('character_fact_v2', [character.id, 'canonical_name', character.canonicalName]),
      novelId: graph.novelId,
      characterId: character.id,
      field: 'canonical_name',
      value: character.canonicalName,
      aliasType: 'name',
      confidence: character.confidence,
      status: 'active',
      source: 'legacy_backfill',
      lockedByUser: character.isUserConfirmed,
      validity,
      evidenceIds: [],
    });
    for (const alias of character.aliases) {
      if (isGenericCharacterReference(alias)) {
        mentions.push({
          id: persistentId128('character_mention_v2', [character.id, alias, 'legacy']),
          novelId: graph.novelId,
          characterId: character.id,
          surface: alias,
          normalizedSurface: normalizeCharacterSurface(alias),
          kind: 'generic_reference',
          confidence: character.confidence,
          status: 'candidate',
          validity,
          evidenceIds: [],
        });
      } else {
        facts.push({
          id: persistentId128('character_fact_v2', [character.id, 'typed_alias', alias]),
          novelId: graph.novelId,
          characterId: character.id,
          field: 'typed_alias',
          value: alias,
          aliasType: 'untyped',
          confidence: character.confidence,
          status: 'active',
          source: 'legacy_backfill',
          lockedByUser: character.isUserConfirmed,
          validity,
          evidenceIds: [],
        });
      }
    }
  }
  return {
    version: CHARACTER_GRAPH_KNOWLEDGE_VERSION,
    novelId: graph.novelId,
    facts,
    mentions,
    addressTerms: [],
    speechTraits: [],
    relationFacts: graph.relations.map((relation) => ({
      ...relation,
      status: 'active',
      validity: { fromChapterIndex: 0 },
      evidenceIds: [],
      lockedByUser: false,
    })),
    evidence: [],
    mergeCandidates: [],
    redirects: [],
  };
}

function characterPairKey(leftId: string, rightId: string): string {
  return JSON.stringify([leftId, rightId].sort());
}

export function deriveCharacterMergeCandidatesV2(
  knowledge: CharacterGraphKnowledgeV2,
): readonly CharacterMergeCandidateV2[] {
  const candidates = [...knowledge.mergeCandidates];
  const existingPairs = new Set(
    candidates.map((candidate) => characterPairKey(candidate.sourceCharacterId, candidate.targetCharacterId)),
  );
  const identityFacts = knowledge.facts.filter(
    (fact) =>
      fact.status !== 'rejected' &&
      (fact.field === 'canonical_name' || fact.field === 'typed_alias') &&
      fact.confidence >= 0.6 &&
      !isGenericCharacterReference(fact.value),
  );
  const bySurface = new Map<string, CharacterFieldFactV2[]>();
  for (const fact of identityFacts) {
    const normalized = normalizeCharacterSurface(fact.value);
    if (!normalized) continue;
    bySurface.set(normalized, [...(bySurface.get(normalized) ?? []), fact]);
  }
  const lockedCharacters = new Set(identityFacts.filter((fact) => fact.lockedByUser).map((fact) => fact.characterId));
  const canonicalNames = new Map<string, string>();
  for (const fact of identityFacts
    .filter((item) => item.field === 'canonical_name')
    .sort((left, right) => right.confidence - left.confidence)) {
    if (!canonicalNames.has(fact.characterId))
      canonicalNames.set(fact.characterId, normalizeCharacterSurface(fact.value));
  }
  const relatedPairs = new Set(
    knowledge.relationFacts
      .filter((relation) => relation.status !== 'rejected')
      .map((relation) => characterPairKey(relation.sourceCharacterId, relation.targetCharacterId)),
  );

  for (const facts of bySurface.values()) {
    const byCharacter = [...new Map(facts.map((fact) => [fact.characterId, fact])).values()];
    for (let leftIndex = 0; leftIndex < byCharacter.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < byCharacter.length; rightIndex += 1) {
        const left = byCharacter[leftIndex]!;
        const right = byCharacter[rightIndex]!;
        const pairKey = characterPairKey(left.characterId, right.characterId);
        if (existingPairs.has(pairKey)) continue;
        const leftLocked = lockedCharacters.has(left.characterId);
        const rightLocked = lockedCharacters.has(right.characterId);
        const targetCharacterId =
          leftLocked && !rightLocked
            ? left.characterId
            : rightLocked && !leftLocked
              ? right.characterId
              : [left.characterId, right.characterId].sort()[0]!;
        const sourceCharacterId = targetCharacterId === left.characterId ? right.characterId : left.characterId;
        const negativeReasons: string[] = [];
        if (leftLocked && rightLocked) negativeReasons.push('both_characters_user_confirmed');
        const leftCanonical = canonicalNames.get(left.characterId);
        const rightCanonical = canonicalNames.get(right.characterId);
        if (leftCanonical && rightCanonical && leftCanonical !== rightCanonical)
          negativeReasons.push('canonical_names_differ');
        if (relatedPairs.has(pairKey)) negativeReasons.push('explicit_relation_between_candidates');
        candidates.push({
          id: persistentId128('character_merge_candidate_v2', [left.characterId, right.characterId].sort()),
          novelId: knowledge.novelId,
          sourceCharacterId,
          targetCharacterId,
          positiveReasons: ['exact_name_or_typed_alias_match'],
          negativeReasons,
          confidence: Math.min(left.confidence, right.confidence),
          status: 'open',
          evidenceIds: [...new Set([...left.evidenceIds, ...right.evidenceIds])],
        });
        existingPairs.add(pairKey);
      }
    }
  }
  return candidates;
}

export function selectCharacterGraphSliceV2(input: {
  readonly graph: CharacterGraph;
  readonly knowledge: CharacterGraphKnowledgeV2;
  readonly chapterIndex: number;
  readonly sceneId?: string;
  readonly surfaces?: readonly string[];
  readonly requiredCharacterIds?: readonly string[];
}): CharacterGraphSliceV2 {
  const normalizedSurfaces = new Set((input.surfaces ?? []).map(normalizeCharacterSurface));
  const required = new Set(
    (input.requiredCharacterIds ?? []).map((id) => resolveCharacterRedirect(id, input.knowledge.redirects)),
  );
  const activeFacts = input.knowledge.facts.filter(
    (fact) => fact.status === 'active' && characterFactIsActiveAt(fact.validity, input.chapterIndex, input.sceneId),
  );
  for (const fact of activeFacts) {
    if (normalizedSurfaces.has(normalizeCharacterSurface(fact.value))) required.add(fact.characterId);
  }
  const activeMentions = input.knowledge.mentions.filter(
    (mention) =>
      mention.status === 'active' &&
      characterFactIsActiveAt(mention.validity, input.chapterIndex, input.sceneId) &&
      normalizedSurfaces.has(mention.normalizedSurface),
  );
  activeMentions.forEach((mention) => mention.characterId && required.add(mention.characterId));
  const activeAddresses = input.knowledge.addressTerms.filter(
    (term) =>
      term.status === 'active' &&
      characterFactIsActiveAt(term.validity, input.chapterIndex, input.sceneId) &&
      (normalizedSurfaces.has(term.normalizedSurface) || required.has(term.targetCharacterId)),
  );
  activeAddresses.forEach((term) => {
    required.add(term.targetCharacterId);
    if (term.speakerCharacterId) required.add(term.speakerCharacterId);
  });
  const redirectMap = Object.fromEntries(
    input.knowledge.redirects.map((redirect) => [
      redirect.sourceCharacterId,
      resolveCharacterRedirect(redirect.sourceCharacterId, input.knowledge.redirects),
    ]),
  );
  const characterIds = new Set([...required].map((id) => resolveCharacterRedirect(id, input.knowledge.redirects)));
  const characters = input.graph.characters.filter((character) => characterIds.has(character.id));
  const relations = input.knowledge.relationFacts
    .filter(
      (relation) =>
        relation.status === 'active' &&
        characterFactIsActiveAt(relation.validity, input.chapterIndex, input.sceneId) &&
        characterIds.has(resolveCharacterRedirect(relation.sourceCharacterId, input.knowledge.redirects)) &&
        characterIds.has(resolveCharacterRedirect(relation.targetCharacterId, input.knowledge.redirects)),
    )
    .map(
      ({ status: _status, validity: _validity, evidenceIds: _evidenceIds, lockedByUser: _locked, ...relation }) =>
        relation,
    );
  const selectedEvidenceIds = new Set([
    ...activeFacts.filter((fact) => characterIds.has(fact.characterId)).flatMap((fact) => fact.evidenceIds),
    ...activeMentions.flatMap((mention) => mention.evidenceIds),
    ...activeAddresses.flatMap((term) => term.evidenceIds),
  ]);
  return {
    graph: { novelId: input.graph.novelId, characters, relations },
    facts: activeFacts.filter((fact) => characterIds.has(fact.characterId)),
    mentions: activeMentions,
    addressTerms: activeAddresses,
    speechTraits: input.knowledge.speechTraits.filter(
      (trait) =>
        trait.status === 'active' &&
        characterIds.has(trait.characterId) &&
        characterFactIsActiveAt(trait.validity, input.chapterIndex, input.sceneId),
    ),
    evidence: input.knowledge.evidence.filter((evidence) => selectedEvidenceIds.has(evidence.id)),
    redirectMap,
  };
}
