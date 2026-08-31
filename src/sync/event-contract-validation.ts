import { integrityHash, isIntegrityHash, persistentId128, persistentIdVersion } from '@noveldesk/text-core/hash';
import { aggregateSyncEntityId, syncPayloadIntegrityHash } from '../domain/identity/sync-identities';
import { SyncContractError, resolveSyncContract } from './contract';
import { syncPageHashForContract } from './event-contract-translation';
import type { SyncEvent } from './types';
import type { JsonValue } from './types';
import { SYNC_CONTRACT_V2 } from './contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalizeV2PayloadHashes(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeV2PayloadHashes);
  if (!isRecord(value)) return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, canonicalizeV2PayloadHashes(child as JsonValue)]),
  ) as Record<string, JsonValue>;
  if (typeof value.rawTextHash === 'string' && typeof value.rawText === 'string') {
    result.rawTextHash = integrityHash(value.rawText);
  }
  if (typeof value.normalizedTextHash === 'string' && typeof value.normalizedText === 'string') {
    result.normalizedTextHash = integrityHash(value.normalizedText);
  }
  if (typeof value.textHash === 'string') {
    const text =
      typeof value.text === 'string'
        ? value.text
        : typeof value.normalizedText === 'string'
          ? value.normalizedText
          : undefined;
    if (text !== undefined) {
      result.textHash = integrityHash(text);
    } else if (Array.isArray(result.paragraphs)) {
      const paragraphHashes = result.paragraphs
        .map((paragraph) =>
          isRecord(paragraph) && typeof paragraph.textHash === 'string' ? paragraph.textHash : undefined,
        )
        .filter((hash): hash is string => Boolean(hash));
      if (paragraphHashes.length === result.paragraphs.length) {
        result.textHash = syncPageHashForContract(SYNC_CONTRACT_V2, paragraphHashes);
      }
    }
  }
  return result;
}

function validatePayloadHashes(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(validatePayloadHashes);
    return;
  }
  if (!isRecord(value)) return;
  Object.values(value).forEach(validatePayloadHashes);

  const rawTextHash = typeof value.rawTextHash === 'string' ? value.rawTextHash : undefined;
  if (rawTextHash) {
    if (typeof value.rawText !== 'string' || rawTextHash !== integrityHash(value.rawText)) {
      throw new SyncContractError('invalid_v2_hash', 'rawTextHash does not match canonical rawText.');
    }
  }
  const normalizedTextHash = typeof value.normalizedTextHash === 'string' ? value.normalizedTextHash : undefined;
  if (normalizedTextHash) {
    if (typeof value.normalizedText !== 'string' || normalizedTextHash !== integrityHash(value.normalizedText)) {
      throw new SyncContractError('invalid_v2_hash', 'normalizedTextHash does not match canonical normalizedText.');
    }
  }
  const textHash = typeof value.textHash === 'string' ? value.textHash : undefined;
  if (textHash) {
    const text =
      typeof value.text === 'string'
        ? value.text
        : typeof value.normalizedText === 'string'
          ? value.normalizedText
          : undefined;
    if (text !== undefined) {
      if (textHash !== integrityHash(text)) {
        throw new SyncContractError('invalid_v2_hash', 'textHash does not match canonical text.');
      }
    } else if (Array.isArray(value.paragraphs)) {
      const paragraphHashes = value.paragraphs
        .map((paragraph) =>
          isRecord(paragraph) && typeof paragraph.textHash === 'string' ? paragraph.textHash : undefined,
        )
        .filter((hash): hash is string => Boolean(hash));
      const expected = syncPageHashForContract(SYNC_CONTRACT_V2, paragraphHashes);
      if (paragraphHashes.length !== value.paragraphs.length || textHash !== expected) {
        throw new SyncContractError('invalid_v2_hash', 'Page textHash does not match canonical paragraph hashes.');
      }
    } else {
      throw new SyncContractError('unverifiable_v2_hash', 'textHash has no canonical text evidence.');
    }
  }
  if (typeof value.segmentTextHash === 'string' && !isIntegrityHash(value.segmentTextHash)) {
    throw new SyncContractError('invalid_v2_hash', 'segmentTextHash is not a tagged SHA-256 hash.');
  }
}

function aggregateEntityId(event: SyncEvent): string | undefined {
  if (!event.novelId) return undefined;
  if (event.type === 'voice_profiles_updated') {
    return aggregateSyncEntityId({ entityType: 'voice_profiles', novelId: event.novelId });
  }
  if (event.type === 'voice_casting_updated') {
    return aggregateSyncEntityId({ entityType: 'voice_casting', novelId: event.novelId });
  }
  if (event.type === 'character_graph_updated') {
    return aggregateSyncEntityId({ entityType: 'character_graph', novelId: event.novelId });
  }
  if (
    event.type === 'chapter_segments_updated' &&
    isRecord(event.payload) &&
    typeof event.payload.chapterId === 'string'
  ) {
    return aggregateSyncEntityId({
      entityType: 'chapter_segments',
      novelId: event.novelId,
      chapterId: event.payload.chapterId,
    });
  }
  if (event.type === 'document_text_order_override_updated' || event.type === 'document_text_order_override_deleted') {
    if (!isRecord(event.payload)) return undefined;
    const nested = isRecord(event.payload.orderOverride) ? event.payload.orderOverride : undefined;
    const value = nested?.pageIndex ?? event.payload.pageIndex;
    const pageIndex = typeof value === 'number' ? value : Number(value);
    if (Number.isInteger(pageIndex) && pageIndex >= 0) {
      return persistentId128('document_text_order_override', [event.novelId, String(pageIndex)]);
    }
  }
  return undefined;
}

export function validateV2SyncEvent(event: SyncEvent): void {
  if (resolveSyncContract(event).contractVersion !== 2) {
    throw new SyncContractError('not_v2_event', 'The event does not declare the v2 sync contract.');
  }
  if (persistentIdVersion(event.id) !== 'v2-sha256-128') {
    throw new SyncContractError('invalid_v2_event_id', 'A v2 sync event requires a 128-bit persistent event ID.');
  }
  if (event.revision) {
    const expected = syncPayloadIntegrityHash(event.payload);
    if (!isIntegrityHash(event.revision.payloadHash) || event.revision.payloadHash !== expected) {
      throw new SyncContractError('invalid_v2_payload_hash', 'A v2 revision payloadHash must match the event payload.');
    }
  }
  validatePayloadHashes(event.payload);
  const aggregateId = aggregateEntityId(event);
  if (aggregateId && event.entityId !== aggregateId) {
    throw new SyncContractError(
      'invalid_v2_aggregate_id',
      'A v2 aggregate entityId must use the shared sync identity factory.',
    );
  }
  if (aggregateId && event.revision && event.revision.entityId !== aggregateId) {
    throw new SyncContractError(
      'invalid_v2_aggregate_revision_id',
      'A v2 aggregate revision entityId must use the shared sync identity factory.',
    );
  }
}
