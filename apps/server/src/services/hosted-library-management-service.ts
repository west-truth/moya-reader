import pg from 'pg';
import type { Shelf } from '@noveldesk/contracts';
import { normalizeBookMetadataPatch } from '@noveldesk/text-core/library-metadata';
import { persistentId128 } from '@noveldesk/text-core/hash';
import type { ServerConfig } from '../config.js';
import type {
  BatchLibraryCommand,
  BatchLibraryItemResult,
  BatchLibraryReceipt,
  BatchLibraryTarget,
} from '../../../../src/repositories/library-catalog-repository.js';
import { createServerRevision, insertServerSyncEvent } from '../routes/books/sync-event-repository.js';
import { lockImageSeriesBookLifecycle } from './book-operation-lock.js';

function name(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 80) throw new Error('Shelf name must be between 1 and 80 characters');
  return normalized;
}

function color(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Shelf color must be a 6-digit HEX value');
  return value.toLowerCase();
}

function mapShelf(row: Record<string, unknown>): Shelf {
  return {
    id: String(row.id),
    name: String(row.name),
    color: typeof row.color === 'string' ? row.color : undefined,
    sortOrder: Number(row.sort_order),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    revision: Number(row.revision),
  };
}

async function emitShelfEvent(
  client: pg.PoolClient,
  userId: string,
  type: 'shelf_updated' | 'shelf_deleted',
  shelfId: string,
  payload: Record<string, unknown>,
  changedAt: string,
) {
  await insertServerSyncEvent(client, userId, {
    seed: `${type}:${shelfId}:${changedAt}`,
    type,
    entityId: shelfId,
    payload,
    revision: createServerRevision({
      entityType: 'shelf',
      entityId: shelfId,
      updatedAt: type === 'shelf_deleted' ? undefined : changedAt,
      deletedAt: type === 'shelf_deleted' ? changedAt : undefined,
      payload,
    }),
    createdAt: changedAt,
  });
}

async function emitMembershipEvent(
  client: pg.PoolClient,
  userId: string,
  type: 'shelf_membership_added' | 'shelf_membership_removed',
  id: string,
  bookId: string,
  payload: Record<string, unknown>,
  changedAt: string,
) {
  await insertServerSyncEvent(client, userId, {
    seed: `${type}:${id}:${changedAt}`,
    type,
    bookId,
    entityId: id,
    payload,
    revision: createServerRevision({
      entityType: 'shelf_membership',
      entityId: id,
      novelId: bookId,
      updatedAt: type === 'shelf_membership_added' ? changedAt : undefined,
      deletedAt: type === 'shelf_membership_removed' ? changedAt : undefined,
      payload,
    }),
    createdAt: changedAt,
  });
}

export async function listHostedShelves(pool: pg.Pool, config: ServerConfig) {
  const [shelves, memberships] = await Promise.all([
    pool.query('select * from shelves where user_id = $1 order by sort_order, name', [config.defaultUserId]),
    pool.query('select * from shelf_memberships where user_id = $1 order by created_at', [config.defaultUserId]),
  ]);
  return { shelves: shelves.rows, memberships: memberships.rows };
}

export async function createHostedShelf(pool: pg.Pool, config: ServerConfig, input: { name: string; color?: string }) {
  const shelfName = name(input.name);
  const shelfColor = color(input.color);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const order = await client.query<{ next: number }>(
      'select coalesce(max(sort_order), -1) + 1 as next from shelves where user_id = $1',
      [config.defaultUserId],
    );
    const now = new Date().toISOString();
    const id = persistentId128('shelf', [config.defaultUserId, shelfName, now]);
    const result = await client.query(
      `insert into shelves (id, user_id, name, color, sort_order, revision, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 1, $6, $6) returning *`,
      [id, config.defaultUserId, shelfName, shelfColor ?? null, Number(order.rows[0]?.next ?? 0), now],
    );
    const shelf = mapShelf(result.rows[0]);
    await emitShelfEvent(client, config.defaultUserId, 'shelf_updated', id, { shelf }, now);
    await client.query('commit');
    return shelf;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateHostedShelf(
  pool: pg.Pool,
  config: ServerConfig,
  shelfId: string,
  patch: { name?: string; color?: string | null; sortOrder?: number; expectedRevision?: number },
) {
  const nextName = patch.name === undefined ? undefined : name(patch.name);
  const nextColor = color(patch.color);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `update shelves set name = coalesce($1, name),
         color = case when $2 then $3 else color end,
         sort_order = coalesce($4, sort_order), revision = revision + 1, updated_at = now()
       where id = $5 and user_id = $6 and ($7::bigint is null or revision = $7) returning *`,
      [
        nextName ?? null,
        nextColor !== undefined,
        nextColor ?? null,
        patch.sortOrder === undefined ? null : Math.max(0, Math.trunc(patch.sortOrder)),
        shelfId,
        config.defaultUserId,
        patch.expectedRevision ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error('Shelf was not found or changed');
    const shelf = mapShelf(result.rows[0]);
    await emitShelfEvent(client, config.defaultUserId, 'shelf_updated', shelfId, { shelf }, shelf.updatedAt);
    await client.query('commit');
    return shelf;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteHostedShelf(
  pool: pg.Pool,
  config: ServerConfig,
  shelfId: string,
  expectedRevision?: number,
) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `delete from shelves where id = $1 and user_id = $2 and ($3::bigint is null or revision = $3) returning *`,
      [shelfId, config.defaultUserId, expectedRevision ?? null],
    );
    if (!result.rows[0]) throw new Error('Shelf was not found or changed');
    const deletedAt = new Date().toISOString();
    const shelf = { ...mapShelf(result.rows[0]), revision: Number(result.rows[0].revision) + 1, updatedAt: deletedAt };
    await emitShelfEvent(
      client,
      config.defaultUserId,
      'shelf_deleted',
      shelfId,
      { shelfId, revision: shelf.revision, deletedAt },
      deletedAt,
    );
    await client.query('commit');
    return shelf;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function setMembership(
  client: pg.PoolClient,
  userId: string,
  shelfId: string,
  bookId: string,
  included: boolean,
) {
  const id = persistentId128('shelf_membership', [shelfId, bookId]);
  const now = new Date().toISOString();
  const ownership = await client.query(
    `select
       exists(select 1 from shelves where id = $1 and user_id = $3) as shelf_exists,
       exists(select 1 from library_books where id = $2 and user_id = $3) as book_exists`,
    [shelfId, bookId, userId],
  );
  if (!ownership.rows[0]?.shelf_exists) throw new Error('Shelf was not found');
  if (!ownership.rows[0]?.book_exists) throw new Error('Book was not found');
  if (included) {
    const result = await client.query(
      `insert into shelf_memberships (id, shelf_id, book_id, user_id, created_at)
       select $1, shelf.id, book.id, $2, $5
       from shelves shelf join library_books book on book.id = $4 and book.user_id = $2
       where shelf.id = $3 and shelf.user_id = $2
       on conflict (shelf_id, book_id) do nothing returning *`,
      [id, userId, shelfId, bookId, now],
    );
    if (result.rows[0]) {
      const membership = { id, shelfId, bookId, createdAt: now };
      await emitMembershipEvent(client, userId, 'shelf_membership_added', id, bookId, { membership }, now);
    }
  } else {
    const result = await client.query(
      'delete from shelf_memberships where id = $1 and user_id = $2 returning id, shelf_id, book_id',
      [id, userId],
    );
    if (result.rows[0]) {
      await emitMembershipEvent(
        client,
        userId,
        'shelf_membership_removed',
        id,
        bookId,
        { id, shelfId, bookId, removedAt: now },
        now,
      );
    }
  }
}

export async function setHostedShelfMembership(
  pool: pg.Pool,
  config: ServerConfig,
  shelfId: string,
  bookId: string,
  included: boolean,
) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await setMembership(client, config.defaultUserId, shelfId, bookId, included);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function applyBookBatchCommand(
  client: pg.PoolClient,
  userId: string,
  command: BatchLibraryCommand,
  target: BatchLibraryTarget,
): Promise<BatchLibraryItemResult> {
  const bookResult = await client.query(
    `select book.*,
            exists(
              select 1 from book_id_generations identity
               where identity.user_id = $2 and identity.book_id = book.id and identity.generation > 1
            ) as has_prior_purge
       from library_books book
      where book.id = $1 and book.user_id = $2
      for update of book`,
    [target.bookId, userId],
  );
  const book = bookResult.rows[0];
  if (!book) return { bookId: target.bookId, status: 'failed', reason: 'book_not_found' };
  if (target.expectedRevision !== undefined && Number(book.metadata_revision) !== target.expectedRevision) {
    return { bookId: target.bookId, status: 'failed', reason: 'metadata_revision_changed' };
  }
  if (
    target.expectedContentRevisionId !== undefined &&
    String(book.active_content_revision_id) !== target.expectedContentRevisionId
  ) {
    return { bookId: target.bookId, status: 'failed', reason: 'content_revision_changed' };
  }
  if (target.expectedContentRevisionId === undefined && Boolean(book.has_prior_purge)) {
    return { bookId: target.bookId, status: 'failed', reason: 'content_revision_required' };
  }
  if (command.kind === 'add_to_shelf' || command.kind === 'remove_from_shelf') {
    await setMembership(client, userId, command.shelfId, target.bookId, command.kind === 'add_to_shelf');
    return { bookId: target.bookId, status: 'applied', metadataRevision: Number(book.metadata_revision) };
  }
  const now = new Date().toISOString();
  if (command.kind === 'add_tag' || command.kind === 'remove_tag') {
    const currentTags = Array.isArray(book.tags) ? book.tags.filter((tag: unknown) => typeof tag === 'string') : [];
    const normalizedTag = normalizeBookMetadataPatch({ tags: [command.tag] }).tags?.[0];
    if (!normalizedTag) return { bookId: target.bookId, status: 'failed', reason: 'invalid_tag' };
    const tags =
      command.kind === 'add_tag'
        ? [...new Set([...currentTags, normalizedTag])]
        : currentTags.filter((tag: string) => tag.toLocaleLowerCase() !== normalizedTag.toLocaleLowerCase());
    if (JSON.stringify(tags) === JSON.stringify(currentTags)) {
      return { bookId: target.bookId, status: 'skipped', metadataRevision: Number(book.metadata_revision) };
    }
    const updated = await client.query(
      `update library_books set tags = $1, metadata_revision = metadata_revision + 1, updated_at = $2
       where id = $3 returning metadata_revision`,
      [JSON.stringify(tags), now, target.bookId],
    );
    const novel = {
      id: target.bookId,
      tags,
      metadataRevision: Number(updated.rows[0].metadata_revision),
      updatedAt: now,
    };
    const payload = { novel, contentRevisionId: String(book.active_content_revision_id) };
    const revision = createServerRevision({
      entityType: 'book',
      entityId: target.bookId,
      novelId: target.bookId,
      updatedAt: now,
      payload,
    });
    await insertServerSyncEvent(client, userId, {
      seed: `batch_metadata:${target.bookId}:${now}:${revision.payloadHash}`,
      type: 'book_updated',
      bookId: target.bookId,
      entityId: target.bookId,
      payload,
      revision,
      createdAt: now,
    });
    return { bookId: target.bookId, status: 'applied', metadataRevision: novel.metadataRevision };
  }
  if (command.kind === 'set_favorite') {
    if (Boolean(book.favorite) === command.favorite) {
      return { bookId: target.bookId, status: 'skipped', metadataRevision: Number(book.metadata_revision) };
    }
    const updated = await client.query(
      `update library_books set favorite = $1, metadata_revision = metadata_revision + 1, updated_at = $2
       where id = $3 returning metadata_revision`,
      [command.favorite, now, target.bookId],
    );
    const novel = {
      id: target.bookId,
      favorite: command.favorite,
      metadataRevision: Number(updated.rows[0].metadata_revision),
      updatedAt: now,
    };
    const payload = { novel, contentRevisionId: String(book.active_content_revision_id) };
    const revision = createServerRevision({
      entityType: 'book',
      entityId: target.bookId,
      novelId: target.bookId,
      updatedAt: now,
      payload,
    });
    await insertServerSyncEvent(client, userId, {
      seed: `batch_favorite:${target.bookId}:${now}:${revision.payloadHash}`,
      type: 'book_updated',
      bookId: target.bookId,
      entityId: target.bookId,
      payload,
      revision,
      createdAt: now,
    });
    return { bookId: target.bookId, status: 'applied', metadataRevision: novel.metadataRevision };
  }
  const movingToTrash = command.kind === 'move_to_trash';
  if (movingToTrash === Boolean(book.deleted_at)) {
    return { bookId: target.bookId, status: 'skipped', metadataRevision: Number(book.metadata_revision) };
  }
  const updated = await client.query(
    `update library_books set deleted_at = $1, deleted_by_device_id = $2,
       metadata_revision = metadata_revision + 1, updated_at = $3 where id = $4 returning metadata_revision`,
    [movingToTrash ? now : null, movingToTrash ? 'server-batch' : null, now, target.bookId],
  );
  const metadataRevision = Number(updated.rows[0].metadata_revision);
  const type = movingToTrash ? ('book_trashed' as const) : ('book_restored' as const);
  const payload = movingToTrash
    ? {
        bookId: target.bookId,
        deletedAt: now,
        deletedByDeviceId: 'server-batch',
        metadataRevision,
        contentRevisionId: String(book.active_content_revision_id),
      }
    : {
        bookId: target.bookId,
        restoredAt: now,
        metadataRevision,
        contentRevisionId: String(book.active_content_revision_id),
      };
  await insertServerSyncEvent(client, userId, {
    seed: `${type}:${target.bookId}:${now}`,
    type,
    bookId: target.bookId,
    entityId: target.bookId,
    payload,
    revision: createServerRevision({
      entityType: 'book',
      entityId: target.bookId,
      novelId: target.bookId,
      updatedAt: now,
      payload,
    }),
    createdAt: now,
  });
  return { bookId: target.bookId, status: 'applied', metadataRevision };
}

export async function applyHostedLibraryBatch(
  pool: pg.Pool,
  config: ServerConfig,
  command: BatchLibraryCommand,
  targets: readonly BatchLibraryTarget[],
  idempotencyKey: string,
): Promise<BatchLibraryReceipt> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const existing = await client.query(
      'select * from library_operation_receipts where user_id = $1 and idempotency_key = $2',
      [config.defaultUserId, idempotencyKey],
    );
    if (existing.rows[0]) {
      await client.query('commit');
      return {
        id: String(existing.rows[0].id),
        idempotencyKey,
        command: existing.rows[0].command,
        results: existing.rows[0].results,
        createdAt: new Date(existing.rows[0].created_at).toISOString(),
      };
    }
    const bookIds = [...new Set(targets.map((target) => target.bookId))].sort();
    for (const bookId of bookIds) await lockImageSeriesBookLifecycle(client, bookId);
    if (bookIds.length > 0) {
      await client.query(
        `select id from library_books
          where user_id = $1 and id = any($2::text[])
          order by id
          for update`,
        [config.defaultUserId, bookIds],
      );
    }
    const results: BatchLibraryItemResult[] = [];
    for (const target of targets) {
      await client.query('savepoint library_batch_item');
      try {
        results.push(await applyBookBatchCommand(client, config.defaultUserId, command, target));
        await client.query('release savepoint library_batch_item');
      } catch (error) {
        await client.query('rollback to savepoint library_batch_item');
        results.push({
          bookId: target.bookId,
          status: 'failed',
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      }
    }
    const createdAt = new Date().toISOString();
    const receipt: BatchLibraryReceipt = {
      id: persistentId128('library_batch_receipt', [config.defaultUserId, idempotencyKey]),
      idempotencyKey,
      command,
      results,
      createdAt,
    };
    await client.query(
      `insert into library_operation_receipts (id, user_id, idempotency_key, command, results, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [receipt.id, config.defaultUserId, idempotencyKey, JSON.stringify(command), JSON.stringify(results), createdAt],
    );
    await client.query('commit');
    return receipt;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
