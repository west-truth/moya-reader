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
  requireMatchingReplay?: boolean;
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
  const id = syncEventId({
    userId,
    deviceId: input.deviceId,
    type: input.type,
    novelId: input.bookId,
    entityId: input.entityId,
    seed: input.seed,
  });
  const payload = JSON.stringify(input.payload);
  const revision = JSON.stringify(input.revision);
  const inserted = await queryable.query(
    `
      insert into sync_events (id, user_id, device_id, type, book_id, entity_id, payload, revision, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict (id) do nothing
      returning id
    `,
    [
      id,
      userId,
      input.deviceId ?? null,
      input.type,
      input.bookId ?? null,
      input.entityId ?? null,
      payload,
      revision,
      createdAt,
    ],
  );
  if (input.requireMatchingReplay && inserted.rowCount === 0) {
    const existing = await queryable.query<{ matches: boolean }>(
      `select user_id = $2 and device_id is not distinct from $3 and type = $4
              and book_id is not distinct from $5 and entity_id is not distinct from $6
              and payload = $7::jsonb and revision = $8::jsonb and created_at = $9::timestamptz as matches
         from sync_events where id = $1`,
      [
        id,
        userId,
        input.deviceId ?? null,
        input.type,
        input.bookId ?? null,
        input.entityId ?? null,
        payload,
        revision,
        createdAt,
      ],
    );
    if (existing.rows[0]?.matches !== true) {
      throw Object.assign(new Error('같은 시각의 다른 독서 위치 변경이 이미 기록되어 있습니다.'), { statusCode: 409 });
    }
  }
}
