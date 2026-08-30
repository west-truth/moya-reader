import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import { IMAGE_SERIES_BOOK_LOCK_NAMESPACE } from '../../services/book-operation-lock.js';
import { lockSyncPushBooks } from './push-route.js';

function event(type: SyncEvent['type'], novelId?: string): SyncEvent {
  return {
    id: `${type}:${novelId ?? 'global'}`,
    type,
    deviceId: 'device-a',
    novelId,
    entityId: novelId,
    payload: {},
    createdAt: '2026-08-31T00:00:00.000Z',
  };
}

describe('sync push lock scope', () => {
  it('does not acquire lifecycle locks for ordinary book-scoped events', async () => {
    const client = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as unknown as pg.PoolClient;

    await lockSyncPushBooks(client, 'user_test', [
      event('bookmark_created', 'book-b'),
      event('highlight_created', 'book-a'),
      event('note_updated', 'book-b'),
      event('book_imported', 'book-a'),
      event('settings_updated'),
    ]);

    expect(client.query).not.toHaveBeenCalled();
  });

  it('locks only lifecycle and reading-position books once in a stable order', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }),
    } as unknown as pg.PoolClient;

    await lockSyncPushBooks(client, 'user_test', [
      event('reading_position_updated', 'reader-b'),
      event('book_updated', 'lifecycle-b'),
      event('bookmark_created', 'unrelated-book'),
      event('book_trashed', 'lifecycle-a'),
      event('reading_position_deleted', 'reader-a'),
      event('book_restored', 'lifecycle-b'),
      event('reading_position_updated', 'reader-b'),
    ]);

    expect(calls).toEqual([
      {
        sql: 'select pg_advisory_xact_lock(hashtextextended($1, $2))',
        params: ['lifecycle-a', IMAGE_SERIES_BOOK_LOCK_NAMESPACE],
      },
      {
        sql: 'select pg_advisory_xact_lock(hashtextextended($1, $2))',
        params: ['lifecycle-b', IMAGE_SERIES_BOOK_LOCK_NAMESPACE],
      },
      {
        sql: 'select pg_advisory_xact_lock(hashtextextended($1, $2))',
        params: ['user_test:reader-a', 8843],
      },
      {
        sql: 'select pg_advisory_xact_lock(hashtextextended($1, $2))',
        params: ['user_test:reader-b', 8843],
      },
    ]);
  });
});
