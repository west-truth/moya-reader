import type { SpeakerSpanV1 } from '@noveldesk/text-core/speaker-attribution';
import type { CandidateMemoryViewV2 } from './candidate-memory';
import type { SourceMentionInventoryV1 } from './mention-inventory';

export const CandidateEvidenceBits = {
  exactMention: 1 << 0,
  explicitSpeechMarker: 1 << 1,
  recentAcceptedTurn: 1 << 2,
  userCorrection: 1 << 3,
  sceneActive: 1 << 4,
  addressSignal: 1 << 5,
  speechTrait: 1 << 6,
  provisionalEvidence: 1 << 7,
  adjacentSpeechAttribution: 1 << 8,
  distantSceneMention: 1 << 9,
} as const;

const LOCAL_CANDIDATE_SPAN_RADIUS = 12;

export interface CandidateEvidenceV1 {
  readonly entityId: string;
  readonly bits: number;
  readonly score: number;
  readonly hardReasons: readonly string[];
  readonly softReasons: readonly string[];
  readonly supportingSourceMentionIds: readonly string[];
}

function addSignal(
  byEntity: Map<
    string,
    {
      bits: number;
      scoreByReason: Map<string, number>;
      hard: Set<string>;
      soft: Set<string>;
      supportingMentions: Set<string>;
    }
  >,
  entityId: string,
  bit: number,
  score: number,
  reason: string,
  hard: boolean,
  supportingSourceMentionIds: readonly string[] = [],
): void {
  const current = byEntity.get(entityId) ?? {
    bits: 0,
    scoreByReason: new Map<string, number>(),
    hard: new Set<string>(),
    soft: new Set<string>(),
    supportingMentions: new Set<string>(),
  };
  current.bits |= bit;
  current.scoreByReason.set(reason, Math.max(score, current.scoreByReason.get(reason) ?? 0));
  (hard ? current.hard : current.soft).add(reason);
  supportingSourceMentionIds.forEach((mentionId) => current.supportingMentions.add(mentionId));
  byEntity.set(entityId, current);
}

export function mineCandidateEvidence(input: {
  readonly targetSpan: SpeakerSpanV1;
  readonly memory: CandidateMemoryViewV2;
  readonly mentionInventory: SourceMentionInventoryV1;
  readonly lockedCharacterId?: string;
}): readonly CandidateEvidenceV1[] {
  const byEntity = new Map<
    string,
    {
      bits: number;
      scoreByReason: Map<string, number>;
      hard: Set<string>;
      soft: Set<string>;
      supportingMentions: Set<string>;
    }
  >();
  const byCharacterId = new Map(
    input.memory.entities.filter((entity) => entity.characterId).map((entity) => [entity.characterId!, entity]),
  );
  const targetMentions = input.mentionInventory.mentions.filter((mention) => mention.spanId === input.targetSpan.id);
  const shouldRetrieveDistantSceneCandidates =
    targetMentions.some((mention) => mention.type === 'address_term') &&
    targetMentions.some((mention) => ['name', 'name_variant', 'title_name', 'address_name'].includes(mention.type));
  const availableMention = (mention: SourceMentionInventoryV1['mentions'][number]) =>
    mention.sceneId === input.targetSpan.sceneId &&
    ((mention.spanIndex <= input.targetSpan.spanIndex &&
      input.targetSpan.spanIndex - mention.spanIndex <= LOCAL_CANDIDATE_SPAN_RADIUS) ||
      (mention.spanIndex === input.targetSpan.spanIndex + 1 && mention.extractionCode === 'speech_verb_subject'));
  const distantMentionsByEntityId = new Map(
    (shouldRetrieveDistantSceneCandidates ? input.memory.entities : [])
      .flatMap((entity) => {
        if (!entity.characterId) return [];
        if (
          input.mentionInventory.mentions.some(
            (mention) => entity.evidenceMentionIds.includes(mention.id) && availableMention(mention),
          )
        ) {
          return [];
        }
        const mentions = input.mentionInventory.mentions
          .filter(
            (mention) =>
              entity.evidenceMentionIds.includes(mention.id) &&
              mention.sceneId === input.targetSpan.sceneId &&
              mention.spanIndex < input.targetSpan.spanIndex - LOCAL_CANDIDATE_SPAN_RADIUS,
          )
          .sort((left, right) => right.spanIndex - left.spanIndex || right.ordinal - left.ordinal);
        if (mentions.length === 0) return [];
        const distinctSpans = new Set<string>();
        const supportingMentions = mentions.filter((mention) => {
          if (distinctSpans.has(mention.spanId)) return false;
          distinctSpans.add(mention.spanId);
          return true;
        });
        return [{ entityId: entity.entityId, latestSpanIndex: mentions[0]!.spanIndex, supportingMentions }];
      })
      .sort(
        (left, right) => right.latestSpanIndex - left.latestSpanIndex || left.entityId.localeCompare(right.entityId),
      )
      .slice(0, 2)
      .map((item) => [item.entityId, item.supportingMentions.slice(0, 1)] as const),
  );
  for (const mention of targetMentions) {
    if (mention.characterId) {
      const entity = byCharacterId.get(mention.characterId);
      if (entity) {
        const explicitSender = mention.extractionCode === 'message_sender_marker';
        addSignal(
          byEntity,
          entity.entityId,
          CandidateEvidenceBits.exactMention | (explicitSender ? CandidateEvidenceBits.explicitSpeechMarker : 0),
          explicitSender ? 120 : 12,
          explicitSender ? 'explicit_message_sender' : 'target_surface_mention',
          explicitSender,
        );
      }
    }
  }
  if (input.lockedCharacterId) {
    const entity = byCharacterId.get(input.lockedCharacterId);
    if (entity)
      addSignal(byEntity, entity.entityId, CandidateEvidenceBits.userCorrection, 1_000, 'user_correction', true);
  }
  for (const turn of input.memory.recentTurns) {
    const entity = byCharacterId.get(turn.speakerId);
    if (entity)
      addSignal(byEntity, entity.entityId, CandidateEvidenceBits.recentAcceptedTurn, 18, 'recent_turn', false);
  }
  for (const entity of input.memory.entities) {
    const entityMentions = input.mentionInventory.mentions.filter(
      (mention) => entity.evidenceMentionIds.includes(mention.id) && availableMention(mention),
    );
    const adjacentAttribution = entityMentions.some(
      (mention) =>
        mention.spanIndex === input.targetSpan.spanIndex + 1 && mention.extractionCode === 'speech_verb_subject',
    );
    const distantMentions = entityMentions.length === 0 ? (distantMentionsByEntityId.get(entity.entityId) ?? []) : [];
    if (adjacentAttribution) {
      addSignal(
        byEntity,
        entity.entityId,
        CandidateEvidenceBits.adjacentSpeechAttribution,
        110,
        'adjacent_speech_attribution',
        true,
      );
    } else if (entity.inclusionReasons.includes('current_scene_mention') && entityMentions.length > 0) {
      addSignal(byEntity, entity.entityId, CandidateEvidenceBits.sceneActive, 12, 'current_scene_mention', false);
    } else if (distantMentions.length > 0) {
      addSignal(
        byEntity,
        entity.entityId,
        CandidateEvidenceBits.distantSceneMention,
        4,
        'distant_scene_mention',
        false,
        distantMentions.map((mention) => mention.id),
      );
    } else if (entity.inclusionReasons.includes('chapter_recent_mention')) {
      addSignal(byEntity, entity.entityId, CandidateEvidenceBits.sceneActive, 6, 'chapter_recent_mention', false);
    }
    if (entity.inclusionReasons.includes('recent_accepted_listener')) {
      addSignal(byEntity, entity.entityId, CandidateEvidenceBits.recentAcceptedTurn, 10, 'recent_listener', false);
    }
    if (entity.speechTraitCount > 0 && byEntity.has(entity.entityId)) {
      addSignal(
        byEntity,
        entity.entityId,
        CandidateEvidenceBits.speechTrait,
        Math.min(6, entity.speechTraitCount),
        'speech_trait',
        false,
      );
    }
    if (entity.entityKind === 'provisional' || entity.entityKind === 'ephemeral') {
      const targetEntityMentions = targetMentions.filter((mention) => entity.evidenceMentionIds.includes(mention.id));
      if (targetEntityMentions.length > 0) {
        const explicitSender = targetEntityMentions.some(
          (mention) => mention.extractionCode === 'message_sender_marker',
        );
        addSignal(
          byEntity,
          entity.entityId,
          CandidateEvidenceBits.provisionalEvidence | (explicitSender ? CandidateEvidenceBits.explicitSpeechMarker : 0),
          explicitSender ? 120 : 12,
          explicitSender ? 'explicit_message_sender' : 'source_entity_mention',
          explicitSender,
        );
      } else if (
        !adjacentAttribution &&
        entity.inclusionReasons.includes('current_scene_mention') &&
        entityMentions.length > 0
      ) {
        addSignal(byEntity, entity.entityId, CandidateEvidenceBits.sceneActive, 8, 'local_source_entity', false);
      }
    }
  }
  return [...byEntity.entries()]
    .map<CandidateEvidenceV1>(([entityId, value]) => ({
      entityId,
      bits: value.bits,
      score: [...value.scoreByReason.values()].reduce((total, score) => total + score, 0),
      hardReasons: [...value.hard].sort(),
      softReasons: [...value.soft].sort(),
      supportingSourceMentionIds: [...value.supportingMentions].sort(),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftRank =
        input.memory.entities.find((entity) => entity.entityId === left.entityId)?.localRank ?? 1_000_000;
      const rightRank =
        input.memory.entities.find((entity) => entity.entityId === right.entityId)?.localRank ?? 1_000_000;
      return leftRank - rightRank || left.entityId.localeCompare(right.entityId);
    });
}
