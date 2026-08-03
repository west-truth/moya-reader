import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { SourceMentionInventoryV1 } from './mention-inventory';

export const ADDRESS_USE_EVENT_VERSION = 'address-use-event-v2' as const;

export type AddressClassV1 =
  | 'kinship'
  | 'romantic'
  | 'organizational'
  | 'status_title'
  | 'name_based'
  | 'generic_social'
  | 'hostile_mock'
  | 'unknown';

export interface AddressUseEventV1 {
  readonly version: typeof ADDRESS_USE_EVENT_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly sceneId: string;
  readonly spanId: string;
  readonly mentionId: string;
  readonly narrativeOrder: number;
  readonly timelineId?: string;
  readonly storyTimeBucket?: string;
  readonly surfaceHash: string;
  readonly normalizedSurface: string;
  readonly addressClass: AddressClassV1;
  readonly contextType: 'direct' | 'inner_quote' | 'reported' | 'roleplay' | 'unknown';
  readonly evidenceStartOffset: number;
  readonly evidenceEndOffset: number;
  readonly speakerCandidateIds: readonly string[];
  readonly addresseeCandidateIds: readonly string[];
  readonly status: 'observed' | 'reconciled' | 'rejected' | 'superseded';
  readonly relationStatus: 'unresolved' | 'candidate' | 'confirmed' | 'rejected';
  readonly confidenceKind: 'rule' | 'model_score' | 'calibrated' | 'human_verified';
  readonly confidence: number;
  readonly revision: string;
  readonly supersedesEventId?: string;
  readonly supersededBy?: string;
  readonly extractionCode: string;
  readonly fingerprint: string;
}

function addressClass(surface: string, mentionType: string): AddressClassV1 {
  if (mentionType === 'address_name') return 'name_based';
  if (/^(?:여보|자기|darling|honey)$/iu.test(surface)) return 'romantic';
  if (/^(?:엄마|아빠|어머니|아버지|언니|누나|오빠|형|동생|mother|father)$/iu.test(surface)) return 'kinship';
  if (/^(?:선배|후배|사장님|팀장님|부장님|교수님|스승님)$/u.test(surface)) return 'organizational';
  if (/^(?:폐하|전하|각하|성하|sir|maam)$/iu.test(surface)) return 'status_title';
  if (/^(?:이놈|네놈|자식)$/u.test(surface)) return 'hostile_mock';
  return surface ? 'generic_social' : 'unknown';
}

export function buildAddressUseEvents(input: {
  readonly mentionInventory: SourceMentionInventoryV1;
  readonly observedSpeakerEntityIdBySpan?: Readonly<Record<string, string>>;
  readonly speakerEntityIdByCharacterId?: Readonly<Record<string, string>>;
  readonly narrativeOrderByScene?: Readonly<Record<string, number>>;
  readonly timelineIdByScene?: Readonly<Record<string, string>>;
  readonly storyTimeBucketByScene?: Readonly<Record<string, string>>;
  readonly contextTypeBySpan?: Readonly<Record<string, AddressUseEventV1['contextType']>>;
  readonly revision?: string;
}): readonly AddressUseEventV1[] {
  return input.mentionInventory.mentions
    .filter((mention) => mention.type === 'address_term' || mention.type === 'address_name')
    .map((mention) => {
      const observedSpeaker = input.observedSpeakerEntityIdBySpan?.[mention.spanId];
      const core = {
        version: ADDRESS_USE_EVENT_VERSION,
        bookId: mention.bookId,
        contentRevisionId: mention.contentRevisionId,
        chapterId: mention.chapterId,
        sceneId: mention.sceneId,
        spanId: mention.spanId,
        mentionId: mention.id,
        narrativeOrder: input.narrativeOrderByScene?.[mention.sceneId] ?? 0,
        timelineId: input.timelineIdByScene?.[mention.sceneId],
        storyTimeBucket: input.storyTimeBucketByScene?.[mention.sceneId],
        surfaceHash: mention.surfaceHash,
        normalizedSurface: mention.normalizedSurface,
        addressClass: addressClass(mention.normalizedSurface, mention.type),
        contextType: input.contextTypeBySpan?.[mention.spanId] ?? ('direct' as const),
        evidenceStartOffset: mention.startOffset,
        evidenceEndOffset: mention.endOffset,
        speakerCandidateIds: observedSpeaker ? [observedSpeaker] : [],
        addresseeCandidateIds: mention.characterId
          ? [input.speakerEntityIdByCharacterId?.[mention.characterId] ?? mention.characterId]
          : [],
        status: 'observed' as const,
        relationStatus: 'unresolved' as const,
        confidenceKind: 'rule' as const,
        confidence: 1,
        revision: input.revision ?? `${mention.contentRevisionId}:source`,
        extractionCode: mention.extractionCode,
      };
      const fingerprint = structuredIntegrityHash(core);
      return {
        ...core,
        id: persistentId128('address_use_event', [mention.contentRevisionId, mention.id, fingerprint]),
        fingerprint,
      };
    });
}
