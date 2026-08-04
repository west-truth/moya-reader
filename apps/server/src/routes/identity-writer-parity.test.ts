import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { syncEventId, syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import { createServerRevision, insertServerSyncEvent } from './books/sync-event-repository.js';

describe('server identity writer parity', () => {
  it('uses the shared sync event and payload contracts without a server-only algorithm', async () => {
    const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => ({ rows: [], rowCount: 1 }));
    const pool = { query } as unknown as pg.Pool;
    const payload = { title: 'Book', favorite: true };
    const input = {
      seed: 'book_updated:book_1:2026-01-01T00:00:00.000Z',
      type: 'book_updated' as const,
      bookId: 'book_1',
      entityId: 'book_1',
      deviceId: 'desktop_1',
      payload,
      revision: createServerRevision({
        entityType: 'book',
        entityId: 'book_1',
        novelId: 'book_1',
        updatedAt: '2026-01-01T00:00:00.000Z',
        payload,
      }),
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    await insertServerSyncEvent(pool, 'user_1', input);

    const parameters = query.mock.calls[0]?.[1] ?? [];
    expect(parameters[0]).toBe(
      syncEventId({
        userId: 'user_1',
        deviceId: input.deviceId,
        type: input.type,
        novelId: input.bookId,
        entityId: input.entityId,
        seed: input.seed,
      }),
    );
    expect(input.revision.payloadHash).toBe(syncPayloadIntegrityHash(payload));
  });
});
