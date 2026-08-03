import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { ChapterLabelingRecentTurn } from '../ai';
import { resolveCharacterRedirect, type CharacterGraphKnowledgeV2 } from '../character-graph-v2';
import type { SourceMentionInventoryV1, SourceMentionV1 } from './mention-inventory';
import type { SpeakerEntityV1 } from './identity-policy';

export const LOCAL_SPEAKER_CANDIDATE_VIEW_VERSION = 'local-speaker-candidate-view-v1' as const;

export type LocalSpeakerCandidateInclusionReason =
  | 'user_correction'
  | 'explicit_message_sender'
  | 'current_scene_mention'
  | 'recent_accepted_speaker'
  | 'recent_accepted_listener'
  | 'chapter_recent_mention'
  | 'source_entity';

export interface LocalSpeakerCandidateSeedV1 {
  readonly candidateKind: 'canonical_character' | 'source_entity';
  readonly candidateKey: string;
  readonly characterId?: string;
  readonly sourceEntityId?: string;
  readonly inclusionReasons: readonly LocalSpeakerCandidateInclusionReason[];
  readonly observedSurfaces: readonly string[];
  readonly evidenceMentionIds: readonly string[];
  readonly latestMentionOrdinal?: number;
  readonly localRank: number;
}

export interface LocalSpeakerCandidateViewV1 {
  readonly version: typeof LOCAL_SPEAKER_CANDIDATE_VIEW_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly candidates: readonly LocalSpeakerCandidateSeedV1[];
  readonly fingerprint: string;
}

interface MutableSeed {
  readonly candidateKind: LocalSpeakerCandidateSeedV1['candidateKind'];
  readonly candidateKey: string;
  readonly characterId?: string;
  readonly sourceEntityId?: string;
  readonly inclusionReasons: Set<LocalSpeakerCandidateInclusionReason>;
  readonly observedSurfaces: Set<string>;
  readonly evidenceMentionIds: Set<string>;
  latestMentionOrdinal?: number;
}

const reasonPriority: Readonly<Record<LocalSpeakerCandidateInclusionReason, number>> = {
  user_correction: 0,
  explicit_message_sender: 1,
  current_scene_mention: 2,
  recent_accepted_speaker: 3,
  recent_accepted_listener: 4,
  chapter_recent_mention: 5,
  source_entity: 6,
};

function addMention(seed: MutableSeed, mention: SourceMentionV1): void {
  seed.observedSurfaces.add(mention.normalizedSurface);
  seed.evidenceMentionIds.add(mention.id);
  seed.latestMentionOrdinal = Math.max(seed.latestMentionOrdinal ?? -1, mention.ordinal);
  seed.inclusionReasons.add(
    mention.extractionCode === 'message_sender_marker' ? 'explicit_message_sender' : 'current_scene_mention',
  );
}

function sortedReasons(reasons: ReadonlySet<LocalSpeakerCandidateInclusionReason>) {
  return [...reasons].sort((left, right) => reasonPriority[left] - reasonPriority[right] || left.localeCompare(right));
}

function seedPriority(seed: MutableSeed): number {
  return Math.min(...[...seed.inclusionReasons].map((reason) => reasonPriority[reason]));
}

export function buildLocalSpeakerCandidateView(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly mentionInventory: SourceMentionInventoryV1;
  readonly sourceEntities: readonly SpeakerEntityV1[];
  readonly graphKnowledge: CharacterGraphKnowledgeV2;
  readonly sceneOrdinalById?: Readonly<Record<string, number>>;
  readonly recentTurns?: readonly ChapterLabelingRecentTurn[];
  readonly requiredCharacterIds?: readonly string[];
  readonly maxPriorSceneCharacters?: number;
}): LocalSpeakerCandidateViewV1 {
  const seeds = new Map<string, MutableSeed>();
  const canonicalSeed = (characterId: string): MutableSeed => {
    const resolved = resolveCharacterRedirect(characterId, input.graphKnowledge.redirects);
    const key = `character:${resolved}`;
    const current = seeds.get(key);
    if (current) return current;
    const created: MutableSeed = {
      candidateKind: 'canonical_character',
      candidateKey: key,
      characterId: resolved,
      inclusionReasons: new Set(),
      observedSurfaces: new Set(),
      evidenceMentionIds: new Set(),
    };
    seeds.set(key, created);
    return created;
  };

  const currentSceneMentions = input.mentionInventory.mentions.filter((mention) => mention.sceneId === input.sceneId);
  for (const mention of currentSceneMentions) {
    if (mention.characterId) addMention(canonicalSeed(mention.characterId), mention);
  }

  const currentSceneOrdinal = input.sceneOrdinalById?.[input.sceneId];
  if (currentSceneOrdinal !== undefined) {
    const recentCharacterIds: string[] = [];
    const seen = new Set<string>();
    for (const mention of [...input.mentionInventory.mentions].sort((left, right) => right.ordinal - left.ordinal)) {
      if (!mention.characterId) continue;
      const sceneOrdinal = input.sceneOrdinalById?.[mention.sceneId];
      if (sceneOrdinal === undefined || sceneOrdinal >= currentSceneOrdinal) continue;
      const characterId = resolveCharacterRedirect(mention.characterId, input.graphKnowledge.redirects);
      if (seen.has(characterId)) continue;
      seen.add(characterId);
      recentCharacterIds.push(characterId);
      if (recentCharacterIds.length >= (input.maxPriorSceneCharacters ?? 8)) break;
    }
    for (const characterId of recentCharacterIds) {
      const seed = canonicalSeed(characterId);
      seed.inclusionReasons.add('chapter_recent_mention');
      for (const mention of input.mentionInventory.mentions) {
        const sceneOrdinal = input.sceneOrdinalById?.[mention.sceneId];
        if (
          mention.characterId &&
          sceneOrdinal !== undefined &&
          sceneOrdinal < currentSceneOrdinal &&
          resolveCharacterRedirect(mention.characterId, input.graphKnowledge.redirects) === characterId
        ) {
          seed.observedSurfaces.add(mention.normalizedSurface);
          seed.evidenceMentionIds.add(mention.id);
          seed.latestMentionOrdinal = Math.max(seed.latestMentionOrdinal ?? -1, mention.ordinal);
        }
      }
    }
  }

  for (const turn of [...(input.recentTurns ?? [])].slice(-12)) {
    canonicalSeed(turn.speakerId).inclusionReasons.add('recent_accepted_speaker');
    for (const listenerId of turn.listenerIds) {
      canonicalSeed(listenerId).inclusionReasons.add('recent_accepted_listener');
    }
  }
  for (const characterId of input.requiredCharacterIds ?? []) {
    canonicalSeed(characterId).inclusionReasons.add('user_correction');
  }

  const currentMentionById = new Map(currentSceneMentions.map((mention) => [mention.id, mention]));
  for (const entity of input.sourceEntities) {
    if (entity.status === 'rejected') continue;
    const localMentions = entity.evidenceMentionIds
      .map((mentionId) => currentMentionById.get(mentionId))
      .filter((mention): mention is SourceMentionV1 => Boolean(mention));
    if (entity.sceneId !== input.sceneId && localMentions.length === 0) continue;
    const key = `source:${entity.id}`;
    const seed: MutableSeed = {
      candidateKind: 'source_entity',
      candidateKey: key,
      sourceEntityId: entity.id,
      inclusionReasons: new Set(['source_entity']),
      observedSurfaces: new Set(entity.normalizedSurfaces),
      evidenceMentionIds: new Set(localMentions.map((mention) => mention.id)),
      latestMentionOrdinal:
        localMentions.length > 0 ? Math.max(...localMentions.map((mention) => mention.ordinal)) : undefined,
    };
    for (const mention of localMentions) addMention(seed, mention);
    seeds.set(key, seed);
  }

  const sorted = [...seeds.values()]
    .filter((seed) => seed.inclusionReasons.size > 0)
    .sort(
      (left, right) =>
        seedPriority(left) - seedPriority(right) ||
        (right.latestMentionOrdinal ?? -1) - (left.latestMentionOrdinal ?? -1) ||
        left.candidateKey.localeCompare(right.candidateKey),
    );
  const candidates = sorted.map<LocalSpeakerCandidateSeedV1>((seed, localRank) => ({
    candidateKind: seed.candidateKind,
    candidateKey: seed.candidateKey,
    ...(seed.characterId ? { characterId: seed.characterId } : {}),
    ...(seed.sourceEntityId ? { sourceEntityId: seed.sourceEntityId } : {}),
    inclusionReasons: sortedReasons(seed.inclusionReasons),
    observedSurfaces: [...seed.observedSurfaces].filter(Boolean).sort(),
    evidenceMentionIds: [...seed.evidenceMentionIds].sort(),
    ...(seed.latestMentionOrdinal === undefined ? {} : { latestMentionOrdinal: seed.latestMentionOrdinal }),
    localRank,
  }));
  const core = {
    version: LOCAL_SPEAKER_CANDIDATE_VIEW_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    sceneId: input.sceneId,
    candidates,
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('local_speaker_candidate_view', [input.contentRevisionId, input.sceneId, fingerprint]),
    fingerprint,
  };
}
