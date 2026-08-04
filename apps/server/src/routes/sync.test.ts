import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appWithSync } from './sync/sync-route-test-harness.js';

describe('sync route composition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers both hosted sync endpoints through the facade', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);

    expect(app.hasRoute({ method: 'GET', url: '/api/sync' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/sync/capabilities' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/api/sync/events' })).toBe(true);

    await app.close();
  });

  it('pulls sync events after a cursor and returns the next cursor', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              sequence: 8,
              id: 'sync_event_00000000000000000000000000000008',
              device_id: 'device_a',
              type: 'settings_updated',
              book_id: null,
              entity_id: 'reader-settings',
              payload: { settings: { theme: 'sepia' } },
              id_contract: 'v2-sha256-128',
              hash_contract: 'v2-sha256-tagged',
              created_at: '2026-07-05T00:00:00.000Z',
            },
            {
              sequence: 9,
              id: 'sync_event_00000000000000000000000000000009',
              device_id: 'device_b',
              type: 'bookmark_created',
              book_id: 'book_1',
              entity_id: 'bookmark_1',
              payload: { bookmark: { id: 'bookmark_1' } },
              id_contract: 'v2-sha256-128',
              hash_contract: 'v2-sha256-tagged',
              created_at: '2026-07-05T00:01:00.000Z',
            },
          ],
        };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);

    const response = await app.inject({
      method: 'GET',
      url: '/api/sync?since=7&contractVersion=2&idContract=v2-sha256-128&hashContract=v2-sha256-tagged',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cursor: 9,
      contractVersion: 2,
      idContract: 'v2-sha256-128',
      hashContract: 'v2-sha256-tagged',
      events: [
        { id: 'sync_event_00000000000000000000000000000008', sequence: 8 },
        { id: 'sync_event_00000000000000000000000000000009', sequence: 9 },
      ],
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('sequence > $2'), ['user_test', 7]);
    expect(client.query).toHaveBeenCalledWith('commit');

    await app.close();
  });
});
