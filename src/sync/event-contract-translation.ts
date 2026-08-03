import { hashSync } from '../domain/hash';
import { integrityHash, persistentId128 } from '../domain/id-hash-contract';
import { aggregateSyncEntityId, syncPayloadIntegrityHash } from '../domain/identity/sync-identities';
import { SYNC_CONTRACT_V1, SYNC_CONTRACT_V2 } from './contract';
import type { JsonValue, ResolvedSyncContract, SyncEntityType, SyncEvent, SyncEventType } from './types';

export type SyncIdentityEntityType =
  | 'book'
  | 'content_revision'
  | 'chapter'
  | 'paragraph'
  | 'page'
  | 'reading_position'
  | 'listening_position'
  | 'bookmark'
  | 'highlight'
  | 'note'
  | 'document_annotation'
  | 'character'
  | 'character_relation'
  | 'voice_profile'
  | 'labeled_segment'
  | 'user_correction'
  | 'shelf'
  | 'shelf_membership'
  | 'sync_event';

export interface SegmentHashTranslationInput {
  source: Record<string, unknown>;
  translated: Record<string, unknown>;
  sourceEvent: SyncEvent;
  translatedPayload: Record<string, unknown>;
}

export interface ContentHashTranslationInput {
  field: 'rawTextHash' | 'normalizedTextHash' | 'textHash';
  entityType?: SyncIdentityEntityType;
  source: Record<string, unknown>;
  translated: Record<string, unknown>;
}

export interface SyncEventIdentityTranslationAdapter {
  readonly targetContract: ResolvedSyncContract;
  mapId(entityType: SyncIdentityEntityType, value: string): Promise<string>;
  mapEventId(sourceEvent: SyncEvent, translatedEvent: SyncEvent): Promise<string>;
  mapSegmentTextHash(input: SegmentHashTranslationInput): Promise<string>;
  mapContentHash(input: ContentHashTranslationInput): Promise<string>;
}

const singularFieldHints: Readonly<Record<string, SyncIdentityEntityType>> = {
  novelId: 'book',
  novel_id: 'book',
  bookId: 'book',
  book_id: 'book',
  sourceBookId: 'book',
  canonicalBookId: 'book',
  activeContentRevisionId: 'content_revision',
  contentRevisionId: 'content_revision',
  chapterId: 'chapter',
  chapter_id: 'chapter',
  lastReadChapterId: 'chapter',
  paragraphId: 'paragraph',
  paragraph_id: 'paragraph',
  lastReadParagraphId: 'paragraph',
  pageId: 'page',
  page_id: 'page',
  bookmarkId: 'bookmark',
  highlightId: 'highlight',
  noteId: 'note',
  documentAnnotationId: 'document_annotation',
  characterId: 'character',
  character_id: 'character',
  sourceCharacterId: 'character',
  source_character_id: 'character',
  targetCharacterId: 'character',
  target_character_id: 'character',
  speakerId: 'character',
  speaker_id: 'character',
  voiceProfileId: 'voice_profile',
  voice_profile_id: 'voice_profile',
  segmentId: 'labeled_segment',
  segment_id: 'labeled_segment',
  shelfId: 'shelf',
  shelf_id: 'shelf',
};

const arrayFieldHints: Readonly<Record<string, SyncIdentityEntityType>> = {
  novelIds: 'book',
  bookIds: 'book',
  chapterIds: 'chapter',
  chapter_ids: 'chapter',
  paragraphIds: 'paragraph',
  paragraph_ids: 'paragraph',
  pageIds: 'page',
  characterIds: 'character',
  character_ids: 'character',
  activeCharacterIds: 'character',
  active_character_ids: 'character',
  candidateSpeakers: 'character',
  candidate_speakers: 'character',
  listenerIds: 'character',
  listener_ids: 'character',
  voiceProfileIds: 'voice_profile',
  segmentIds: 'labeled_segment',
  segment_ids: 'labeled_segment',
};

const nestedFieldHints: Readonly<Record<string, SyncIdentityEntityType>> = {
  novel: 'book',
  book: 'book',
  chapter: 'chapter',
  paragraph: 'paragraph',
  paragraphPage: 'page',
  position: 'reading_position',
  readingPosition: 'reading_position',
  listeningPosition: 'listening_position',
  bookmark: 'bookmark',
  highlight: 'highlight',
  note: 'note',
  annotation: 'document_annotation',
  character: 'character',
  relation: 'character_relation',
  voiceProfile: 'voice_profile',
  segment: 'labeled_segment',
  correction: 'user_correction',
  shelf: 'shelf',
  membership: 'shelf_membership',
};

const nestedArrayHints: Readonly<Record<string, SyncIdentityEntityType>> = {
  chapters: 'chapter',
  paragraphs: 'paragraph',
  paragraphPages: 'page',
  bookmarks: 'bookmark',
  highlights: 'highlight',
  notes: 'note',
  characters: 'character',
  relations: 'character_relation',
  voiceProfiles: 'voice_profile',
  segments: 'labeled_segment',
  corrections: 'user_correction',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function syncHashForContract(contract: ResolvedSyncContract, value: string): string {
  return contract.contractVersion === 2 ? integrityHash(value) : hashSync(value);
}

export function syncPageHashForContract(contract: ResolvedSyncContract, paragraphHashes: string[]): string {
  return contract.contractVersion === 2
    ? integrityHash(JSON.stringify(paragraphHashes))
    : hashSync(paragraphHashes.join(':'));
}

function payloadRootHint(type: SyncEventType): SyncIdentityEntityType | undefined {
  if (
    type === 'book_imported' ||
    type === 'book_updated' ||
    type === 'book_deleted' ||
    type === 'book_trashed' ||
    type === 'book_restored' ||
    type === 'book_purged'
  )
    return 'book';
  if (type === 'reading_position_updated' || type === 'reading_position_deleted') return 'reading_position';
  if (type === 'listening_position_updated' || type === 'listening_position_deleted') return 'listening_position';
  if (type === 'bookmark_created' || type === 'bookmark_deleted') return 'bookmark';
  if (type === 'highlight_created' || type === 'highlight_deleted') return 'highlight';
  if (type === 'note_created' || type === 'note_updated' || type === 'note_deleted') return 'note';
  if (type === 'document_annotation_updated' || type === 'document_annotation_deleted') {
    return 'document_annotation';
  }
  if (type === 'user_correction_created' || type === 'user_correction_deleted') return 'user_correction';
  if (type === 'shelf_updated' || type === 'shelf_deleted') return 'shelf';
  if (type === 'shelf_membership_added' || type === 'shelf_membership_removed') return 'shelf_membership';
  return undefined;
}

function eventEntityHint(type: SyncEventType): SyncIdentityEntityType | undefined {
  return payloadRootHint(type);
}

function revisionEntityHint(type: SyncEntityType): SyncIdentityEntityType | undefined {
  if (type === 'book') return 'book';
  if (type === 'reading_position') return 'reading_position';
  if (type === 'listening_position') return 'listening_position';
  if (type === 'bookmark' || type === 'highlight' || type === 'note' || type === 'document_annotation') return type;
  if (type === 'user_correction') return 'user_correction';
  if (type === 'shelf' || type === 'shelf_membership') return type;
  return undefined;
}

async function translateStringifiedJson(value: string, adapter: SyncEventIdentityTranslationAdapter): Promise<string> {
  try {
    return JSON.stringify(await translateValue(JSON.parse(value), adapter));
  } catch (error) {
    if (error instanceof SyntaxError) {
      const wrapped = new Error('Sync correction JSON is not valid JSON.') as Error & { cause?: unknown };
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

async function translateRecord(
  source: Record<string, unknown>,
  adapter: SyncEventIdentityTranslationAdapter,
  entityHint?: SyncIdentityEntityType,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'id' && entityHint && typeof value === 'string') {
      result[key] = await adapter.mapId(entityHint, value);
      continue;
    }
    const singularHint = singularFieldHints[key];
    if (singularHint && typeof value === 'string') {
      result[key] = await adapter.mapId(singularHint, value);
      continue;
    }
    const arrayHint = arrayFieldHints[key];
    if (arrayHint && Array.isArray(value)) {
      result[key] = await Promise.all(
        value.map((item) =>
          typeof item === 'string' ? adapter.mapId(arrayHint, item) : translateValue(item, adapter),
        ),
      );
      continue;
    }
    const nestedHint = nestedFieldHints[key];
    if (nestedHint && isRecord(value)) {
      result[key] = await translateRecord(value, adapter, nestedHint);
      continue;
    }
    const nestedArrayHint = nestedArrayHints[key];
    if (nestedArrayHint && Array.isArray(value)) {
      result[key] = await Promise.all(
        value.map((item) =>
          isRecord(item) ? translateRecord(item, adapter, nestedArrayHint) : translateValue(item, adapter),
        ),
      );
      continue;
    }
    if ((key === 'beforeJson' || key === 'afterJson') && typeof value === 'string' && value.trim()) {
      result[key] = await translateStringifiedJson(value, adapter);
      continue;
    }
    result[key] = await translateValue(value, adapter);
  }

  const rawText = stringValue(source.rawText);
  if (typeof source.rawTextHash === 'string') {
    result.rawTextHash = rawText
      ? syncHashForContract(adapter.targetContract, rawText)
      : await adapter.mapContentHash({ field: 'rawTextHash', entityType: entityHint, source, translated: result });
  }
  const normalizedText = stringValue(source.normalizedText);
  if (typeof source.normalizedTextHash === 'string') {
    result.normalizedTextHash = normalizedText
      ? syncHashForContract(adapter.targetContract, normalizedText)
      : await adapter.mapContentHash({
          field: 'normalizedTextHash',
          entityType: entityHint,
          source,
          translated: result,
        });
  }
  const text = stringValue(source.text) ?? normalizedText;
  if (typeof source.textHash === 'string') {
    if (text) {
      result.textHash = syncHashForContract(adapter.targetContract, text);
    } else if (entityHint === 'page' && Array.isArray(result.paragraphs)) {
      const paragraphHashes = result.paragraphs
        .filter(isRecord)
        .map((paragraph) => stringValue(paragraph.textHash))
        .filter((hash): hash is string => Boolean(hash));
      if (paragraphHashes.length !== result.paragraphs.length) {
        throw new Error('A paragraph page hash cannot be translated without every paragraph hash.');
      }
      result.textHash = syncPageHashForContract(adapter.targetContract, paragraphHashes);
    } else {
      result.textHash = await adapter.mapContentHash({
        field: 'textHash',
        entityType: entityHint,
        source,
        translated: result,
      });
    }
  }
  return result;
}

async function translateValue(
  value: unknown,
  adapter: SyncEventIdentityTranslationAdapter,
  entityHint?: SyncIdentityEntityType,
): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => translateValue(item, adapter, entityHint)));
  if (isRecord(value)) return translateRecord(value, adapter, entityHint);
  if (typeof value === 'string' && entityHint) return adapter.mapId(entityHint, value);
  return value;
}

function eventBookId(event: SyncEvent): string | undefined {
  if (event.novelId) return event.novelId;
  if (!isRecord(event.payload)) return undefined;
  const payload = event.payload;
  const direct = stringValue(payload.bookId) ?? stringValue(payload.novelId);
  if (direct) return direct;
  for (const key of ['novel', 'book', 'position', 'bookmark', 'highlight', 'note', 'correction']) {
    const nested = isRecord(payload[key]) ? payload[key] : undefined;
    const nestedBookId = nested ? (stringValue(nested.bookId) ?? stringValue(nested.novelId)) : undefined;
    if (nestedBookId) return nestedBookId;
  }
  return event.revision?.novelId;
}

function documentTextOrderOverridePageIndex(payload: Record<string, unknown>): number | undefined {
  const nested = isRecord(payload.orderOverride) ? payload.orderOverride : undefined;
  const value = nested?.pageIndex ?? payload.pageIndex;
  const pageIndex = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : undefined;
}

function documentTextOrderOverrideId(contract: ResolvedSyncContract, bookId: string, pageIndex: number): string {
  return contract.contractVersion === 2
    ? persistentId128('document_text_order_override', [bookId, String(pageIndex)])
    : `document_text_order_override_${bookId}_${pageIndex}`;
}

export function syncEventSourceBookId(event: SyncEvent): string | undefined {
  return eventBookId(event);
}

async function translatedAggregateEntityId(
  event: SyncEvent,
  payload: Record<string, unknown>,
  mappedBookId: string | undefined,
  adapter: SyncEventIdentityTranslationAdapter,
): Promise<string | undefined> {
  if (!event.entityId) return undefined;
  const directHint = eventEntityHint(event.type);
  if (directHint) return adapter.mapId(directHint, event.entityId);
  if (event.type === 'voice_profiles_updated' && mappedBookId) {
    return adapter.targetContract.contractVersion === 2
      ? aggregateSyncEntityId({ entityType: 'voice_profiles', novelId: mappedBookId })
      : `voice_profiles_${mappedBookId}`;
  }
  if (event.type === 'voice_casting_updated' && mappedBookId) {
    return adapter.targetContract.contractVersion === 2
      ? aggregateSyncEntityId({ entityType: 'voice_casting', novelId: mappedBookId })
      : `voice_casting_${mappedBookId}`;
  }
  if (event.type === 'character_graph_updated' && mappedBookId) {
    return adapter.targetContract.contractVersion === 2
      ? aggregateSyncEntityId({ entityType: 'character_graph', novelId: mappedBookId })
      : `character_graph_${mappedBookId}`;
  }
  if (event.type === 'chapter_segments_updated') {
    const chapterId = stringValue(payload.chapterId);
    if (!chapterId || !mappedBookId) return event.entityId;
    return adapter.targetContract.contractVersion === 2
      ? aggregateSyncEntityId({ entityType: 'chapter_segments', novelId: mappedBookId, chapterId })
      : `chapter_segments_${chapterId}`;
  }
  if (
    (event.type === 'document_text_order_override_updated' || event.type === 'document_text_order_override_deleted') &&
    mappedBookId
  ) {
    const pageIndex = documentTextOrderOverridePageIndex(payload);
    if (pageIndex !== undefined) return documentTextOrderOverrideId(adapter.targetContract, mappedBookId, pageIndex);
  }
  return event.entityId;
}

async function translatedRevision(
  event: SyncEvent,
  payload: JsonValue,
  mappedBookId: string | undefined,
  adapter: SyncEventIdentityTranslationAdapter,
) {
  if (!event.revision) return undefined;
  const hint = revisionEntityHint(event.revision.entityType);
  let entityId = event.revision.entityId;
  if (hint) {
    entityId = await adapter.mapId(hint, entityId);
  } else if (event.revision.entityType === 'voice_profiles' && mappedBookId) {
    entityId =
      adapter.targetContract.contractVersion === 2
        ? aggregateSyncEntityId({ entityType: 'voice_profiles', novelId: mappedBookId })
        : `voice_profiles_${mappedBookId}`;
  } else if (event.revision.entityType === 'voice_casting' && mappedBookId) {
    entityId =
      adapter.targetContract.contractVersion === 2
        ? aggregateSyncEntityId({ entityType: 'voice_casting', novelId: mappedBookId })
        : `voice_casting_${mappedBookId}`;
  } else if (event.revision.entityType === 'character_graph' && mappedBookId) {
    entityId =
      adapter.targetContract.contractVersion === 2
        ? aggregateSyncEntityId({ entityType: 'character_graph', novelId: mappedBookId })
        : `character_graph_${mappedBookId}`;
  } else if (event.revision.entityType === 'chapter_segments') {
    const chapterId = isRecord(payload) ? stringValue(payload.chapterId) : undefined;
    if (chapterId && mappedBookId) {
      entityId =
        adapter.targetContract.contractVersion === 2
          ? aggregateSyncEntityId({ entityType: 'chapter_segments', novelId: mappedBookId, chapterId })
          : `chapter_segments_${chapterId}`;
    }
  } else if (event.revision.entityType === 'document_text_order_override' && mappedBookId && isRecord(payload)) {
    const pageIndex = documentTextOrderOverridePageIndex(payload);
    if (pageIndex !== undefined) {
      entityId = documentTextOrderOverrideId(adapter.targetContract, mappedBookId, pageIndex);
    }
  }
  return {
    ...event.revision,
    entityId,
    novelId: event.revision.novelId && mappedBookId ? mappedBookId : undefined,
    payloadHash:
      adapter.targetContract.contractVersion === 2
        ? syncPayloadIntegrityHash(payload)
        : hashSync(JSON.stringify(payload)),
  };
}

async function translateSegmentHashes(
  sourceEvent: SyncEvent,
  payload: Record<string, unknown>,
  adapter: SyncEventIdentityTranslationAdapter,
): Promise<void> {
  if (sourceEvent.type !== 'chapter_segments_updated' || !isRecord(sourceEvent.payload)) return;
  const sourceSegments = Array.isArray(sourceEvent.payload.segments) ? sourceEvent.payload.segments : [];
  const translatedSegments = Array.isArray(payload.segments) ? payload.segments : [];
  for (let index = 0; index < translatedSegments.length; index += 1) {
    const source = sourceSegments[index];
    const translated = translatedSegments[index];
    if (!isRecord(source) || !isRecord(translated) || typeof source.segmentTextHash !== 'string') continue;
    translated.segmentTextHash = await adapter.mapSegmentTextHash({
      source,
      translated,
      sourceEvent,
      translatedPayload: payload,
    });
  }
}

export async function translateSyncEventIdentity(
  sourceEvent: SyncEvent,
  adapter: SyncEventIdentityTranslationAdapter,
): Promise<SyncEvent> {
  const sourceBookId = eventBookId(sourceEvent);
  const mappedBookId = sourceBookId ? await adapter.mapId('book', sourceBookId) : undefined;
  const payload = (await translateValue(sourceEvent.payload, adapter, payloadRootHint(sourceEvent.type))) as JsonValue;
  const payloadRecord = isRecord(payload) ? payload : {};
  if (
    (sourceEvent.type === 'document_text_order_override_updated' ||
      sourceEvent.type === 'document_text_order_override_deleted') &&
    mappedBookId
  ) {
    const pageIndex = documentTextOrderOverridePageIndex(payloadRecord);
    if (pageIndex !== undefined) {
      const id = documentTextOrderOverrideId(adapter.targetContract, mappedBookId, pageIndex);
      if (isRecord(payloadRecord.orderOverride)) payloadRecord.orderOverride.id = id;
      if (typeof payloadRecord.id === 'string') payloadRecord.id = id;
    }
  }
  await translateSegmentHashes(sourceEvent, payloadRecord, adapter);

  const translated: SyncEvent = {
    ...sourceEvent,
    ...adapter.targetContract,
    novelId: sourceEvent.novelId && mappedBookId ? mappedBookId : undefined,
    entityId: await translatedAggregateEntityId(sourceEvent, payloadRecord, mappedBookId, adapter),
    payload,
    revision: await translatedRevision(sourceEvent, payload, mappedBookId, adapter),
  };
  translated.id = await adapter.mapEventId(sourceEvent, translated);
  return translated;
}

export function isCurrentSyncContract(contract: ResolvedSyncContract): boolean {
  return contract.contractVersion === SYNC_CONTRACT_V2.contractVersion;
}

export function isLegacySyncContract(contract: ResolvedSyncContract): boolean {
  return contract.contractVersion === SYNC_CONTRACT_V1.contractVersion;
}
