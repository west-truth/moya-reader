import { persistentId128 } from '../domain/id-hash-contract';
import { aggregateSyncEntityId, syncEventId, syncPayloadIntegrityHash } from '../domain/identity/sync-identities';
import { SYNC_CONTRACT_V2 } from '../sync/contract';
import { canonicalizeV2PayloadHashes, validateV2SyncEvent } from '../sync/event-contract-validation';
import type {
  Device,
  JsonValue,
  SyncEntityRevision,
  SyncEntityType,
  SyncEventType,
  SyncOutboxItem,
  SyncOutboxQueryOptions,
  SyncState,
} from '../sync/types';
import { openReaderDb } from './reader-database';
import { getItem, requestToPromise, transactionDone } from './indexeddb-transaction';
import {
  countQueuedSyncOutboxInDatabase,
  listSyncOutboxInDatabase,
  updateSyncOutboxItemsInDatabase,
} from './sync-outbox-store';

export const LOCAL_DEVICE_ID = 'device_local';

export type SyncTombstoneEntity =
  | 'book'
  | 'cover'
  | 'bookmark'
  | 'highlight'
  | 'note'
  | 'document_annotation'
  | 'document_text_order_override'
  | 'reading_position'
  | 'listening_position'
  | 'user_correction'
  | 'shelf'
  | 'shelf_membership';

export interface SyncTombstone {
  id: string;
  entityType: SyncTombstoneEntity;
  entityId: string;
  novelId?: string;
  /** Stable Cloud Vault identity retained even after the local book is purged. */
  vaultBookId?: string;
  /** Legacy v1 fallback retained for older Vault manifests. */
  bookHash?: string;
  pageIndex?: number;
  deletedAt: string;
  createdAt: string;
}

const defaultSyncState: SyncState = {
  id: 'sync-state',
  mode: 'local_only',
  status: 'local_only',
  pendingCount: 0,
  nextSequence: 1,
  updatedAt: new Date(0).toISOString(),
};

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}

function stringField(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function syncEntityType(type: SyncEventType): SyncEntityType {
  if (type === 'shelf_updated' || type === 'shelf_deleted') return 'shelf';
  if (type === 'shelf_membership_added' || type === 'shelf_membership_removed') return 'shelf_membership';
  if (type === 'reading_position_updated' || type === 'reading_position_deleted') return 'reading_position';
  if (type === 'listening_position_updated' || type === 'listening_position_deleted') return 'listening_position';
  if (type === 'bookmark_created' || type === 'bookmark_deleted') return 'bookmark';
  if (type === 'highlight_created' || type === 'highlight_deleted') return 'highlight';
  if (type === 'note_created' || type === 'note_updated' || type === 'note_deleted') return 'note';
  if (type === 'document_annotation_updated' || type === 'document_annotation_deleted') {
    return 'document_annotation';
  }
  if (type === 'document_text_order_override_updated' || type === 'document_text_order_override_deleted') {
    return 'document_text_order_override';
  }
  if (type === 'settings_updated') return 'settings';
  if (type === 'voice_profiles_updated') return 'voice_profiles';
  if (type === 'voice_casting_updated') return 'voice_casting';
  if (type === 'user_correction_created' || type === 'user_correction_deleted') return 'user_correction';
  if (type === 'character_graph_updated') return 'character_graph';
  if (type === 'chapter_segments_updated') return 'chapter_segments';
  return 'book';
}

function syncRevisionEntityRecord(type: SyncEventType, payload: Record<string, JsonValue>): Record<string, JsonValue> {
  if (type === 'book_imported' || type === 'book_updated') return recordValue(payload.novel);
  if (type === 'shelf_updated') return recordValue(payload.shelf);
  if (type === 'shelf_membership_added') return recordValue(payload.membership);
  if (type === 'reading_position_updated') return recordValue(payload.position);
  if (type === 'listening_position_updated') return recordValue(payload.listeningPosition);
  if (type === 'bookmark_created') return recordValue(payload.bookmark);
  if (type === 'highlight_created') return recordValue(payload.highlight);
  if (type === 'note_created' || type === 'note_updated') return recordValue(payload.note);
  if (type === 'document_annotation_updated') return recordValue(payload.annotation);
  if (type === 'document_text_order_override_updated') return recordValue(payload.orderOverride);
  if (type === 'settings_updated') return recordValue(payload.settings);
  if (type === 'user_correction_created') return recordValue(payload.correction);
  if (type === 'user_correction_deleted') return payload;
  if (type === 'voice_casting_updated' || type === 'character_graph_updated' || type === 'chapter_segments_updated') {
    return payload;
  }
  return {};
}

function isDeletionSyncEvent(type: SyncEventType): boolean {
  return (
    type === 'book_deleted' ||
    type === 'shelf_deleted' ||
    type === 'shelf_membership_removed' ||
    type === 'reading_position_deleted' ||
    type === 'listening_position_deleted' ||
    type === 'bookmark_deleted' ||
    type === 'highlight_deleted' ||
    type === 'note_deleted' ||
    type === 'document_annotation_deleted' ||
    type === 'document_text_order_override_deleted' ||
    type === 'user_correction_deleted'
  );
}

function syncEventRevision(
  type: SyncEventType,
  payloadValue: JsonValue,
  options: { novelId?: string; entityId?: string },
  localSequence: number,
  createdAt: string,
): SyncEntityRevision {
  const payload = recordValue(payloadValue);
  const entity = syncRevisionEntityRecord(type, payload);
  const entityType = syncEntityType(type);
  const novelId =
    options.novelId ||
    stringField(entity.novelId) ||
    stringField(entity.bookId) ||
    stringField(payload.novelId) ||
    stringField(payload.bookId) ||
    undefined;
  const entityId = options.entityId || stringField(entity.id) || stringField(payload.id) || novelId || entityType;
  const updatedAt =
    stringField(entity.updatedAt) || stringField(entity.createdAt) || stringField(payload.updatedAt) || createdAt;
  const deletedAt = stringField(payload.deletedAt) || (isDeletionSyncEvent(type) ? createdAt : '');

  return {
    entityType,
    entityId,
    novelId,
    localSequence,
    updatedAt: deletedAt ? undefined : updatedAt,
    deletedAt: deletedAt || undefined,
    payloadHash: syncPayloadIntegrityHash(payloadValue),
  };
}

function localDevice(now: string): Device {
  return {
    id: LOCAL_DEVICE_ID,
    label: 'Local browser',
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
}

function canonicalSyncEntityId(
  type: SyncEventType,
  payloadValue: JsonValue,
  novelId: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (!novelId) return fallback;
  if (type === 'voice_profiles_updated') {
    return aggregateSyncEntityId({ entityType: 'voice_profiles', novelId });
  }
  if (type === 'voice_casting_updated') {
    return aggregateSyncEntityId({ entityType: 'voice_casting', novelId });
  }
  if (type === 'character_graph_updated') {
    return aggregateSyncEntityId({ entityType: 'character_graph', novelId });
  }
  if (type === 'chapter_segments_updated') {
    const chapterId = stringField(recordValue(payloadValue).chapterId);
    if (chapterId) return aggregateSyncEntityId({ entityType: 'chapter_segments', novelId, chapterId });
  }
  if (type === 'document_text_order_override_updated' || type === 'document_text_order_override_deleted') {
    const payload = recordValue(payloadValue);
    const override = recordValue(payload.orderOverride);
    const value = override.pageIndex ?? payload.pageIndex;
    const pageIndex = typeof value === 'number' ? value : Number(value);
    if (Number.isInteger(pageIndex) && pageIndex >= 0) {
      return persistentId128('document_text_order_override', [novelId, String(pageIndex)]);
    }
  }
  return fallback;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function jsonValue<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function tombstoneId(entityType: SyncTombstoneEntity, entityId: string): string {
  return `${entityType}:${entityId}`;
}

export function tombstoneEntity(
  entityType: SyncTombstoneEntity,
  entityId: string,
  deletedAt: string,
  novelId?: string,
): SyncTombstone {
  return {
    id: tombstoneId(entityType, entityId),
    entityType,
    entityId,
    novelId,
    deletedAt,
    createdAt: deletedAt,
  };
}

export function queueSyncEventInTransaction(
  tx: IDBTransaction,
  type: SyncEventType,
  payload: JsonValue,
  options: { novelId?: string; entityId?: string } = {},
): Promise<SyncOutboxItem> {
  const now = nowIso();
  const device = localDevice(now);
  const syncStateStore = tx.objectStore('sync_state');
  const request = syncStateStore.get(defaultSyncState.id);
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      try {
        const stored = request.result as SyncState | undefined;
        const nextSequence = stored?.nextSequence ?? defaultSyncState.nextSequence;
        const eventSeed = `${nextSequence}:${now}`;
        const versionedPayload = canonicalizeV2PayloadHashes(payload);
        const entityId = canonicalSyncEntityId(type, versionedPayload, options.novelId, options.entityId);
        const event = {
          id: syncEventId({
            userId: 'local',
            deviceId: device.id,
            type,
            novelId: options.novelId,
            entityId,
            seed: eventSeed,
          }),
          ...SYNC_CONTRACT_V2,
          type,
          deviceId: device.id,
          novelId: options.novelId,
          entityId,
          payload: versionedPayload,
          revision: syncEventRevision(type, versionedPayload, { ...options, entityId }, nextSequence, now),
          createdAt: now,
        };
        validateV2SyncEvent(event);
        const item: SyncOutboxItem = {
          id: persistentId128('sync_outbox', [event.id]),
          event,
          status: 'pending',
          localSequence: nextSequence,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        };

        tx.objectStore('devices').put(device);
        tx.objectStore('sync_outbox').put(item);
        syncStateStore.put({
          ...defaultSyncState,
          ...stored,
          status: stored?.status ?? 'local_only',
          pendingCount: (stored?.pendingCount ?? 0) + 1,
          nextSequence: nextSequence + 1,
          updatedAt: now,
        });
        resolve(item);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
  });
}

export async function enqueueSyncEvent(
  type: SyncEventType,
  payload: JsonValue,
  options: { novelId?: string; entityId?: string } = {},
): Promise<SyncOutboxItem> {
  const db = await openReaderDb();
  const tx = db.transaction(['devices', 'sync_outbox', 'sync_state'], 'readwrite');
  const item = await queueSyncEventInTransaction(tx, type, payload, options);
  await transactionDone(tx);
  return item;
}

export async function listSyncOutbox(
  status?: SyncOutboxItem['status'],
  options?: SyncOutboxQueryOptions,
): Promise<SyncOutboxItem[]> {
  return listSyncOutboxInDatabase(await openReaderDb(), status, options);
}

async function queuedSyncCount(): Promise<number> {
  return countQueuedSyncOutboxInDatabase(await openReaderDb());
}

export async function getSyncState(): Promise<SyncState> {
  const pendingCount = await queuedSyncCount();
  const stored = await getItem<SyncState>('sync_state', defaultSyncState.id);
  return {
    ...defaultSyncState,
    ...stored,
    pendingCount,
    status: stored?.status ?? 'local_only',
    nextSequence: stored?.nextSequence ?? defaultSyncState.nextSequence,
  };
}

export async function saveSyncState(patch: Partial<Omit<SyncState, 'id' | 'nextSequence'>>): Promise<SyncState> {
  const db = await openReaderDb();
  const tx = db.transaction(['sync_state', 'sync_outbox'], 'readwrite');
  const done = transactionDone(tx);
  const syncStateStore = tx.objectStore('sync_state');
  const statusIndex = tx.objectStore('sync_outbox').index('status');
  const storedRequest = requestToPromise<SyncState | undefined>(syncStateStore.get(defaultSyncState.id));
  const countRequests = (['pending', 'sending', 'failed'] as const).map((status) =>
    requestToPromise<number>(statusIndex.count(status)),
  );
  const [stored, ...counts] = await Promise.all([storedRequest, ...countRequests]);
  const pendingCount = counts.reduce((total, count) => total + count, 0);
  const current: SyncState = {
    ...defaultSyncState,
    ...stored,
    pendingCount,
    status: stored?.status ?? 'local_only',
    nextSequence: stored?.nextSequence ?? defaultSyncState.nextSequence,
  };
  const next: SyncState = {
    ...current,
    ...patch,
    id: defaultSyncState.id,
    pendingCount,
    nextSequence: current.nextSequence,
    updatedAt: nowIso(),
  };
  syncStateStore.put(next);
  await done;
  return next;
}

export async function updateSyncOutboxItems(
  ids: string[],
  status: SyncOutboxItem['status'],
  lastError?: string,
): Promise<void> {
  await updateSyncOutboxItemsInDatabase(await openReaderDb(), ids, status, lastError, nowIso());
}

export async function discardSyncOutboxItems(ids: string[]): Promise<SyncState> {
  if (!ids.length) return getSyncState();

  await updateSyncOutboxItems(ids, 'sent');
  const state = await getSyncState();
  if (state.mode === 'connected' && state.pendingCount === 0) {
    return saveSyncState({ status: 'idle', lastError: undefined });
  }
  return state;
}
