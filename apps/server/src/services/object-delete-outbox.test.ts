import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import {
  drainObjectDeleteOutbox,
  enqueueObjectDeletions,
  releaseObjectDeletionReservations,
  reserveObjectDeletions,
} from './object-delete-outbox.js';

const config = { s3: { bucket: 'test' } } as ServerConfig;

describe('object delete outbox', () => {
  it('persists unique cleanup keys in the caller transaction', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 2 }));
    await expect(
      enqueueObjectDeletions({ query } as unknown as pg.PoolClient, ['old/a', 'old/a', 'old/b'], 'purged_book'),
    ).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('object_delete_outbox'), [
      ['old/a', 'old/b'],
      'purged_book',
    ]);
  });

  it('supports delayed crash reservations that are released by the publishing transaction', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const client = { query } as unknown as pg.PoolClient;

    await expect(reserveObjectDeletions(client, ['restore/staged'], 'backup_restore_staging')).resolves.toBe(1);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("now() + ($3::bigint * interval '1 millisecond')"),
      [['restore/staged'], 'backup_restore_staging', 24 * 60 * 60 * 1_000],
    );

    await expect(releaseObjectDeletionReservations(client, ['restore/staged'])).resolves.toBe(1);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('delete from object_delete_outbox'), [
      ['restore/staged'],
    ]);
  });

  it('drops the cleanup request without deleting a key that became referenced again', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('with candidates')) {
        return { rows: [{ id: '1', storage_key: 'books/reused', attempts: 1 }], rowCount: 1 };
      }
      if (sql.startsWith('select 1 where')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.startsWith('delete from object_delete_outbox')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const remove = vi.fn(async () => undefined);

    await expect(
      drainObjectDeleteOutbox({ query } as unknown as pg.Pool, config, 25, { deleteStoredObject: remove }),
    ).resolves.toEqual({ deleted: 0, failed: 0 });

    expect(remove).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('exists (select 1 from book_assets'), ['books/reused']);
  });

  it('deletes unreferenced objects and completes their outbox row', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('with candidates')) {
        return { rows: [{ id: '2', storage_key: 'books/orphan', attempts: 1 }], rowCount: 1 };
      }
      if (sql.startsWith('select 1 where')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('delete from object_delete_outbox')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const remove = vi.fn(async () => undefined);

    await expect(
      drainObjectDeleteOutbox({ query } as unknown as pg.Pool, config, 25, { deleteStoredObject: remove }),
    ).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(remove).toHaveBeenCalledWith('books/orphan');
  });
});
