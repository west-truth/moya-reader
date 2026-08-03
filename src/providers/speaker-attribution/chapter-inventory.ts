import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import {
  DIALOGUE_BURST_INVENTORY_VERSION,
  SPEAKER_SCENE_INVENTORY_VERSION,
  SPEAKER_SPAN_INVENTORY_VERSION,
  type DialogueBurstInventoryV1,
  type DialogueBurstV1,
  type SpeakerSceneInventoryV1,
  type SpeakerSceneV1,
  type SpeakerSpanInventoryV1,
  type SpeakerSpanV1,
} from '@noveldesk/text-core/speaker-attribution';
import type { AddressUseEventV1 } from './address-event';
import type { SpeakerEntityV1 } from './identity-policy';
import {
  SOURCE_MENTION_INVENTORY_VERSION,
  type SourceMentionInventoryV1,
  type SourceMentionV1,
} from './mention-inventory';

export const SPEAKER_ATTRIBUTION_CHAPTER_INVENTORY_VERSION = 'speaker-attribution-chapter-inventory-v1' as const;

export interface SpeakerAttributionChapterInventoryV1 {
  readonly version: typeof SPEAKER_ATTRIBUTION_CHAPTER_INVENTORY_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly sceneInventory: SpeakerSceneInventoryV1;
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly dialogueBurstInventory: DialogueBurstInventoryV1;
  readonly mentionInventory: SourceMentionInventoryV1;
  readonly entities: readonly SpeakerEntityV1[];
  readonly addressEvents: readonly AddressUseEventV1[];
  readonly fingerprint: string;
}

interface InventoryReferenceV1 {
  readonly id: string;
  readonly fingerprint: string;
  readonly detectorVersion: string;
}

export interface SpeakerAttributionChapterInventoryMetaV1 {
  readonly version: typeof SPEAKER_ATTRIBUTION_CHAPTER_INVENTORY_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly sceneInventory: InventoryReferenceV1;
  readonly spanInventory: InventoryReferenceV1;
  readonly dialogueBurstInventory: InventoryReferenceV1;
  readonly mentionInventory: InventoryReferenceV1;
  readonly fingerprint: string;
}

function assertAggregateIdentity(
  aggregate: Pick<SpeakerAttributionChapterInventoryV1, 'bookId' | 'contentRevisionId' | 'chapterId'>,
  row: { readonly bookId: string; readonly contentRevisionId: string; readonly chapterId: string },
  kind: string,
): void {
  if (
    row.bookId !== aggregate.bookId ||
    row.contentRevisionId !== aggregate.contentRevisionId ||
    row.chapterId !== aggregate.chapterId
  ) {
    throw new Error(`${kind} does not belong to the speaker chapter inventory`);
  }
}

export function createSpeakerAttributionChapterInventory(input: {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly sceneInventory: SpeakerSceneInventoryV1;
  readonly spanInventory: SpeakerSpanInventoryV1;
  readonly dialogueBurstInventory: DialogueBurstInventoryV1;
  readonly mentionInventory: SourceMentionInventoryV1;
  readonly entities: readonly SpeakerEntityV1[];
  readonly addressEvents: readonly AddressUseEventV1[];
}): SpeakerAttributionChapterInventoryV1 {
  for (const inventory of [
    input.sceneInventory,
    input.spanInventory,
    input.dialogueBurstInventory,
    input.mentionInventory,
  ]) {
    assertAggregateIdentity(input, inventory, 'Nested inventory');
  }
  const sceneIds = new Set(input.sceneInventory.scenes.map((scene) => scene.id));
  const spanIds = new Set(input.spanInventory.spans.map((span) => span.id));
  const mentionIds = new Set(input.mentionInventory.mentions.map((mention) => mention.id));
  for (const span of input.spanInventory.spans) {
    if (!sceneIds.has(span.sceneId)) throw new Error(`Speaker span ${span.id} references an unknown scene`);
  }
  for (const mention of input.mentionInventory.mentions) {
    if (!spanIds.has(mention.spanId) || !sceneIds.has(mention.sceneId)) {
      throw new Error(`Source mention ${mention.id} has a stale source anchor`);
    }
  }
  for (const event of input.addressEvents) {
    assertAggregateIdentity(input, event, 'Address event');
    if (!mentionIds.has(event.mentionId) || !spanIds.has(event.spanId)) {
      throw new Error(`Address event ${event.id} has a stale source anchor`);
    }
  }
  for (const entity of input.entities) {
    assertAggregateIdentity(input, entity, 'Speaker entity');
    if (entity.evidenceMentionIds.some((id) => !mentionIds.has(id))) {
      throw new Error(`Speaker entity ${entity.id} has missing mention evidence`);
    }
  }
  const core = {
    version: SPEAKER_ATTRIBUTION_CHAPTER_INVENTORY_VERSION,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    chapterId: input.chapterId,
    chapterIndex: input.chapterIndex,
    sceneInventory: input.sceneInventory,
    spanInventory: input.spanInventory,
    dialogueBurstInventory: input.dialogueBurstInventory,
    mentionInventory: input.mentionInventory,
    entities: [...input.entities].sort((left, right) => left.id.localeCompare(right.id)),
    addressEvents: [...input.addressEvents].sort((left, right) => left.id.localeCompare(right.id)),
  };
  const fingerprint = structuredIntegrityHash(core);
  return {
    ...core,
    id: persistentId128('speaker_chapter_inventory', [input.contentRevisionId, input.chapterId, fingerprint]),
    fingerprint,
  };
}

export function speakerAttributionChapterInventoryMeta(
  inventory: SpeakerAttributionChapterInventoryV1,
): SpeakerAttributionChapterInventoryMetaV1 {
  const reference = (value: {
    readonly id: string;
    readonly fingerprint: string;
    readonly detectorVersion: string;
  }) => ({
    id: value.id,
    fingerprint: value.fingerprint,
    detectorVersion: value.detectorVersion,
  });
  return {
    version: inventory.version,
    id: inventory.id,
    bookId: inventory.bookId,
    contentRevisionId: inventory.contentRevisionId,
    chapterId: inventory.chapterId,
    chapterIndex: inventory.chapterIndex,
    sceneInventory: reference(inventory.sceneInventory),
    spanInventory: reference(inventory.spanInventory),
    dialogueBurstInventory: reference(inventory.dialogueBurstInventory),
    mentionInventory: reference(inventory.mentionInventory),
    fingerprint: inventory.fingerprint,
  };
}

export function reassembleSpeakerAttributionChapterInventory(input: {
  readonly meta: SpeakerAttributionChapterInventoryMetaV1;
  readonly scenes: readonly SpeakerSceneV1[];
  readonly spans: readonly SpeakerSpanV1[];
  readonly dialogueBursts: readonly DialogueBurstV1[];
  readonly mentions: readonly SourceMentionV1[];
  readonly entities: readonly SpeakerEntityV1[];
  readonly addressEvents: readonly AddressUseEventV1[];
}): SpeakerAttributionChapterInventoryV1 {
  const spans = [...input.spans].sort((left, right) => left.spanIndex - right.spanIndex);
  const base = {
    bookId: input.meta.bookId,
    contentRevisionId: input.meta.contentRevisionId,
    chapterId: input.meta.chapterId,
  };
  const inventory = createSpeakerAttributionChapterInventory({
    ...base,
    chapterIndex: input.meta.chapterIndex,
    sceneInventory: {
      version: SPEAKER_SCENE_INVENTORY_VERSION,
      ...base,
      ...input.meta.sceneInventory,
      scenes: [...input.scenes].sort((left, right) => left.sceneIndex - right.sceneIndex),
    },
    spanInventory: {
      version: SPEAKER_SPAN_INVENTORY_VERSION,
      ...base,
      ...input.meta.spanInventory,
      spans,
      boundaryReviewSpanIds: spans.filter((span) => span.boundaryReview).map((span) => span.id),
    },
    dialogueBurstInventory: {
      version: DIALOGUE_BURST_INVENTORY_VERSION,
      ...base,
      ...input.meta.dialogueBurstInventory,
      bursts: [...input.dialogueBursts].sort((left, right) => left.burstIndex - right.burstIndex),
    },
    mentionInventory: {
      version: SOURCE_MENTION_INVENTORY_VERSION,
      ...base,
      ...input.meta.mentionInventory,
      mentions: [...input.mentions].sort((left, right) => left.ordinal - right.ordinal),
    },
    entities: input.entities,
    addressEvents: input.addressEvents,
  });
  if (inventory.id !== input.meta.id || inventory.fingerprint !== input.meta.fingerprint) {
    throw new Error('Persisted speaker chapter inventory fingerprint does not match its rows');
  }
  return inventory;
}
