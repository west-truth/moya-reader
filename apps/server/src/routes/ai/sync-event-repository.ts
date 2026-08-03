import pg from 'pg';
import { aggregateSyncEntityId, syncEventId, syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import type { SyncEntityRevision, SyncEntityType, SyncEventType } from '@noveldesk/contracts/sync';

export type QueryRunner = Pick<pg.Pool, 'query'>;

export function serverRevision(input: {
  entityType: SyncEntityType;
  entityId: string;
  novelId?: string;
  updatedAt?: string;
  payload: unknown;
}): SyncEntityRevision {
  return {
    entityType: input.entityType,
    entityId: input.entityId,
    novelId: input.novelId,
    localSequence: 0,
    updatedAt: input.updatedAt,
    payloadHash: syncPayloadIntegrityHash(input.payload),
  };
}

export async function insertServerSyncEvent(
  db: QueryRunner,
  userId: string,
  input: {
    seed: string;
    type: SyncEventType;
    bookId: string;
    entityId: string;
    payload: unknown;
    revision: SyncEntityRevision;
    createdAt?: string;
  },
): Promise<void> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const payload = input.payload as Record<string, unknown>;
  const entityId =
    input.type === 'voice_profiles_updated'
      ? aggregateSyncEntityId({ entityType: 'voice_profiles', novelId: input.bookId })
      : input.type === 'character_graph_updated'
        ? aggregateSyncEntityId({ entityType: 'character_graph', novelId: input.bookId })
        : input.type === 'chapter_segments_updated' && typeof payload.chapterId === 'string'
          ? aggregateSyncEntityId({
              entityType: 'chapter_segments',
              novelId: input.bookId,
              chapterId: payload.chapterId,
            })
          : input.entityId;
  const revision = { ...input.revision, entityId };
  await db.query(
    `
      insert into sync_events (id, user_id, device_id, type, book_id, entity_id, payload, revision, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict (id) do nothing
    `,
    [
      syncEventId({
        userId,
        type: input.type,
        novelId: input.bookId,
        entityId,
        seed: input.seed,
      }),
      userId,
      null,
      input.type,
      input.bookId,
      entityId,
      JSON.stringify(input.payload),
      JSON.stringify(revision),
      createdAt,
    ],
  );
}

export async function withTransaction<T>(pool: pg.Pool, task: (runner: QueryRunner) => Promise<T>): Promise<T> {
  const maybePool = pool as pg.Pool & { connect?: () => Promise<pg.PoolClient> };
  if (typeof maybePool.connect !== 'function') return task(pool);

  const client = await maybePool.connect();
  try {
    await client.query('begin');
    const result = await task(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
