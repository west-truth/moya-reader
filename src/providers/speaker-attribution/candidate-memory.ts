import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { Character, UserCorrection } from '../../domain/types';
import type { CharacterGraphKnowledgeV2 } from '../character-graph-v2';
import { characterFactIsActiveAt, normalizeCharacterSurface, resolveCharacterRedirect } from '../character-graph-v2';
import type { ChapterLabelingRecentTurn } from '../ai';
import type { AddressUseEventV1 } from './address-event';
import {
  buildLocalSpeakerCandidateView,
  type LocalSpeakerCandidateInclusionReason,
  type LocalSpeakerCandidateViewV1,
} from './local-candidate-view';
import type { SourceMentionInventoryV1 } from './mention-inventory';
import { canonicalSpeakerEntityId, type SpeakerEntitySourceAnchorV1, type SpeakerEntityV1 } from './identity-policy';

export const CANDIDATE_MEMORY_VIEW_VERSION = 'candidate-memory-view-v6' as const;

export interface CandidateMemoryEntityV1 {
  readonly entityId: string;
  readonly entityKind: SpeakerEntityV1['entityKind'];
  readonly characterId?: string;
  readonly displayName: string;
  readonly normalizedSurfaces: readonly string[];
  readonly trustLevel: SpeakerEntityV1['trustLevel'];
  readonly sceneId?: string;
  readonly evidenceMentionIds: readonly string[];
  readonly firstEvidence?: SpeakerEntitySourceAnchorV1;
  readonly inclusionReasons: readonly LocalSpeakerCandidateInclusionReason[];
  readonly localRank: number;
  readonly speechTraitCount: number;
  readonly userConfirmed: boolean;
}

export interface CandidateMemoryViewV2 {
  readonly version: typeof CANDIDATE_MEMORY_VIEW_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly sceneId: string;
  readonly entities: readonly CandidateMemoryEntityV1[];
  readonly mentionInventoryHash: string;
  readonly mentionIds: readonly string[];
  readonly addressEventIds: readonly string[];
  readonly recentTurns: readonly ChapterLabelingRecentTurn[];
  readonly correctionIds: readonly string[];
  readonly localCandidateViewHash: string;
  readonly graphKnowledgeHash: string;
  readonly fingerprint: string;
}

function canonicalMemoryEntities(
  characters: readonly Character[],
  knowledge: CharacterGraphKnowledgeV2,
  chapterIndex: number,
  sceneId: string,
  localView: LocalSpeakerCandidateViewV1,
  mentionInventory: SourceMentionInventoryV1,
): CandidateMemoryEntityV1[] {
  const localByCharacterId = new Map(
    localView.candidates
      .filter((candidate) => candidate.candidateKind === 'canonical_character' && candidate.characterId)
      .map((candidate) => [candidate.characterId!, candidate]),
  );
  const activeIdentityFacts = knowledge.facts.filter(
    (fact) =>
      fact.status === 'active' &&
      ['canonical_name', 'typed_alias'].includes(fact.field) &&
      characterFactIsActiveAt(fact.validity, chapterIndex, sceneId),
  );
  const factOwnersBySurface = new Map<string, Set<string>>();
  for (const fact of activeIdentityFacts) {
    const characterId = resolveCharacterRedirect(fact.characterId, knowledge.redirects);
    const surface = normalizeCharacterSurface(fact.value);
    const owners = factOwnersBySurface.get(surface) ?? new Set<string>();
    owners.add(characterId);
    factOwnersBySurface.set(surface, owners);
  }
  const factsByCharacter = new Map<string, string[]>();
  for (const fact of activeIdentityFacts) {
    const characterId = resolveCharacterRedirect(fact.characterId, knowledge.redirects);
    if (
      !localByCharacterId.has(characterId) ||
      factOwnersBySurface.get(normalizeCharacterSurface(fact.value))?.size !== 1
    ) {
      continue;
    }
    factsByCharacter.set(characterId, [...(factsByCharacter.get(characterId) ?? []), fact.value]);
  }
  const traitsByCharacter = new Map<string, number>();
  for (const trait of knowledge.speechTraits) {
    if (trait.status === 'active' && characterFactIsActiveAt(trait.validity, chapterIndex, sceneId)) {
      const characterId = resolveCharacterRedirect(trait.characterId, knowledge.redirects);
      if (!localByCharacterId.has(characterId)) continue;
      traitsByCharacter.set(characterId, (traitsByCharacter.get(characterId) ?? 0) + 1);
    }
  }
  const grouped = new Map<string, Character[]>();
  for (const character of characters) {
    const characterId = resolveCharacterRedirect(character.id, knowledge.redirects);
    if (!localByCharacterId.has(characterId)) continue;
    grouped.set(characterId, [...(grouped.get(characterId) ?? []), character]);
  }
  const mentionById = new Map(mentionInventory.mentions.map((mention) => [mention.id, mention]));
  const firstEvidenceFor = (mentionIds: readonly string[]): SpeakerEntitySourceAnchorV1 | undefined => {
    const mention = mentionIds
      .flatMap((mentionId) => {
        const found = mentionById.get(mentionId);
        return found ? [found] : [];
      })
      .sort(
        (left, right) =>
          left.paragraphIndex - right.paragraphIndex ||
          left.spanIndex - right.spanIndex ||
          left.startOffset - right.startOffset ||
          left.id.localeCompare(right.id),
      )[0];
    return mention
      ? {
          mentionId: mention.id,
          chapterId: mention.chapterId,
          sceneId: mention.sceneId,
          paragraphId: mention.paragraphId,
          paragraphIndex: mention.paragraphIndex,
          spanId: mention.spanId,
          spanIndex: mention.spanIndex,
          startOffset: mention.startOffset,
          endOffset: mention.endOffset,
        }
      : undefined;
  };
  return [...grouped.entries()]
    .map<CandidateMemoryEntityV1>(([characterId, rows]) => {
      const local = localByCharacterId.get(characterId)!;
      const representative = rows.find((character) => character.id === characterId) ?? rows[0]!;
      const userConfirmed = rows.some((character) => character.isUserConfirmed);
      const confidence = Math.max(...rows.map((character) => character.confidence));
      const activeFactValues = factsByCharacter.get(characterId) ?? [];
      const displayCandidates = [
        ...rows.flatMap((character) => [character.canonicalName, ...character.aliases]),
        ...activeFactValues,
      ];
      const observedDisplay = local.observedSurfaces
        .map(
          (surface) =>
            displayCandidates.find((candidate) => normalizeCharacterSurface(candidate) === surface) ?? surface,
        )
        .find(Boolean);
      const readableDisplays = [
        ...new Set([observedDisplay, ...activeFactValues].filter((value): value is string => Boolean(value))),
      ].slice(0, 4);
      const normalizedSurfaces = [
        ...new Set([...local.observedSurfaces, ...activeFactValues.map(normalizeCharacterSurface)].filter(Boolean)),
      ].sort();
      if (normalizedSurfaces.length === 0)
        normalizedSurfaces.push(normalizeCharacterSurface(representative.canonicalName));
      return {
        entityId: canonicalSpeakerEntityId(representative.novelId, characterId),
        entityKind: 'canonical_character',
        characterId,
        displayName: readableDisplays.join(' / ') || representative.canonicalName,
        normalizedSurfaces,
        trustLevel: userConfirmed ? 'high' : confidence >= 0.75 ? 'medium' : 'low',
        sceneId,
        evidenceMentionIds: local.evidenceMentionIds,
        firstEvidence: firstEvidenceFor(local.evidenceMentionIds),
        inclusionReasons: local.inclusionReasons,
        localRank: local.localRank,
        speechTraitCount: traitsByCharacter.get(characterId) ?? 0,
        userConfirmed,
      };
    })
    .sort((left, right) => left.localRank - right.localRank || left.entityId.localeCompare(right.entityId));
}

export function buildCandidateMemoryView(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly sceneId: string;
  readonly characters: readonly Character[];
  readonly graphKnowledge: CharacterGraphKnowledgeV2;
  readonly mentionInventory: SourceMentionInventoryV1;
  readonly sourceEntities: readonly SpeakerEntityV1[];
  readonly addressEvents: readonly AddressUseEventV1[];
  readonly recentTurns?: readonly ChapterLabelingRecentTurn[];
  readonly userCorrections?: readonly UserCorrection[];
  readonly localCandidateView?: LocalSpeakerCandidateViewV1;
}): CandidateMemoryViewV2 {
  const localCandidateView =
    input.localCandidateView ??
    buildLocalSpeakerCandidateView({
      ...input,
      sourceEntities: input.sourceEntities,
    });
  if (
    localCandidateView.bookId !== input.bookId ||
    localCandidateView.contentRevisionId !== input.contentRevisionId ||
    localCandidateView.chapterId !== input.chapterId ||
    localCandidateView.sceneId !== input.sceneId
  ) {
    throw new Error('Local speaker candidate view does not match Candidate Memory source');
  }
  const canonical = canonicalMemoryEntities(
    input.characters,
    input.graphKnowledge,
    input.chapterIndex,
    input.sceneId,
    localCandidateView,
    input.mentionInventory,
  );
  const sourceById = new Map(input.sourceEntities.map((entity) => [entity.id, entity]));
  const source = localCandidateView.candidates
    .filter((candidate) => candidate.candidateKind === 'source_entity' && candidate.sourceEntityId)
    .map<CandidateMemoryEntityV1>((candidate) => {
      const entity = sourceById.get(candidate.sourceEntityId!);
      if (!entity || entity.status === 'rejected') {
        throw new Error(`Local source speaker candidate is missing: ${candidate.sourceEntityId}`);
      }
      return {
        entityId: entity.id,
        entityKind: entity.entityKind,
        characterId: entity.characterId,
        displayName: entity.displayName,
        normalizedSurfaces: candidate.observedSurfaces,
        trustLevel: entity.trustLevel,
        sceneId: input.sceneId,
        evidenceMentionIds: candidate.evidenceMentionIds,
        firstEvidence: entity.firstEvidence,
        inclusionReasons: candidate.inclusionReasons,
        localRank: candidate.localRank,
        speechTraitCount: 0,
        userConfirmed: false,
      };
    });
  const entities = [...canonical, ...source].sort(
    (left, right) => left.localRank - right.localRank || left.entityId.localeCompare(right.entityId),
  );
  if (entities.some((entity) => entity.inclusionReasons.length === 0)) {
    throw new Error('Candidate Memory contains an entity without a local inclusion reason');
  }
  const mentionIds = input.mentionInventory.mentions
    .filter((mention) => mention.sceneId === input.sceneId)
    .map((mention) => mention.id);
  const addressEventIds = input.addressEvents
    .filter((event) => event.sceneId === input.sceneId && event.status !== 'rejected')
    .map((event) => event.id);
  const correctionIds = (input.userCorrections ?? [])
    .filter((correction) => correction.chapterId === input.chapterId)
    .map((correction) => correction.id)
    .sort();
  const graphKnowledgeHash = structuredIntegrityHash({
    facts: input.graphKnowledge.facts,
    mentions: input.graphKnowledge.mentions,
    addressTerms: input.graphKnowledge.addressTerms,
    speechTraits: input.graphKnowledge.speechTraits,
    relationFacts: input.graphKnowledge.relationFacts,
    redirects: input.graphKnowledge.redirects,
  });
  const core = {
    version: CANDIDATE_MEMORY_VIEW_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    chapterIndex: input.chapterIndex,
    sceneId: input.sceneId,
    entities,
    mentionInventoryHash: input.mentionInventory.fingerprint,
    mentionIds,
    addressEventIds,
    recentTurns: [...(input.recentTurns ?? [])].slice(-12),
    correctionIds,
    localCandidateViewHash: localCandidateView.fingerprint,
    graphKnowledgeHash,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('candidate_memory_view', [input.contentRevisionId, input.sceneId, fingerprint]),
    fingerprint,
  };
}
