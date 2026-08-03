import pg from 'pg';
import { syncEventId, syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import type { SyncEntityRevision, SyncEntityType, SyncEventType } from '@noveldesk/contracts/sync';

export interface ServerSyncEventInput {
  seed: string;
  type: SyncEventType;
  bookId?: string;
  entityId?: string;
  deviceId?: string;
  payload: unknown;
  revision: SyncEntityRevision;
  createdAt?: string;
}

export function createServerRevision(input: {
  entityType: SyncEntityType;
  entityId: string;
  novelId?: string;
  updatedAt?: string;
  deletedAt?: string;
  payload: unknown;
}): SyncEntityRevision {
  return {
    entityType: input.entityType,
    entityId: input.entityId,
    novelId: input.novelId,
    localSequence: 0,
    updatedAt: input.deletedAt ? undefined : input.updatedAt,
    deletedAt: input.deletedAt,
    payloadHash: syncPayloadIntegrityHash(input.payload),
  };
}

export async function insertServerSyncEvent(
  queryable: pg.Pool | pg.PoolClient,
  userId: string,
  input: ServerSyncEventInput,
): Promise<void> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  await queryable.query(
    `
      insert into sync_events (id, user_id, device_id, type, book_id, entity_id, payload, revision, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict (id) do nothing
    `,
    [
      syncEventId({
        userId,
        deviceId: input.deviceId,
        type: input.type,
        novelId: input.bookId,
        entityId: input.entityId,
        seed: input.seed,
      }),
      userId,
      input.deviceId ?? null,
      input.type,
      input.bookId ?? null,
      input.entityId ?? null,
      JSON.stringify(input.payload),
      JSON.stringify(input.revision),
      createdAt,
    ],
  );
}
