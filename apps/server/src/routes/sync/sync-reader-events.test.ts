import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import { validateSyncEventPayload } from './event-contracts.js';
import { persistReaderSyncEvent } from './reader-entity-persistence.js';
import {
  appWithSync,
  bookmarkCreatedEvent,
  deletedEvent,
  highlightCreatedEvent,
  noteUpdatedEvent,
  readingPositionEvent,
  successfulInsertClient,
  syncRoundTripPool,
  V2_SYNC_CONTRACT,
  v2PullEvent,
  v2PullUrl,
  v2PushEnvelope,
} from './sync-route-test-harness.js';

describe('sync reader event routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('materializes a validated book analysis status patch', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }),
    } as unknown as pg.PoolClient;
    const event: SyncEvent = {
      id: 'event_book_ready',
      type: 'book_updated',
      deviceId: 'device_a',
      novelId: 'book_1',
      entityId: 'book_1',
      payload: { novel: { analysisStatus: 'ready' } },
      createdAt: '2026-07-05T00:01:00.000Z',
    };

    await expect(persistReaderSyncEvent(client, 'user_test', event)).resolves.toBe(true);

    expect(queries[0].params?.slice(0, 7)).toEqual([
      null,
      null,
      'ready',
      '2026-07-05T00:01:00.000Z',
      'book_1',
      'user_test',
      0,
    ]);
    expect(queries[0].params?.slice(7)).toEqual([
      false,
      null,
      false,
      null,
      false,
      Number.NaN,
      false,
      '[]',
      false,
      null,
      false,
      null,
      null,
      null,
      null,
    ]);
  });

  it('materializes fixed-document annotation updates and tombstones', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }),
    } as unknown as pg.PoolClient;
    const updatedAt = '2026-08-01T00:03:00.000Z';
    const annotation = {
      id: 'document-annotation-1',
      bookId: 'book_1',
      pageIndex: 2,
      type: 'text_note',
      anchor: {
        kind: 'fixed_text',
        bookId: 'book_1',
        pageIndex: 2,
        textRevisionId: 'revision-1',
        blockId: 'block-1',
        startOffset: 1,
        endOffset: 5,
        quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
      },
      body: 'memo',
      color: 'yellow',
      createdAt: updatedAt,
      updatedAt,
    };
    const update: SyncEvent = {
      id: 'event-document-annotation-update',
      type: 'document_annotation_updated',
      deviceId: 'device_a',
      novelId: 'book_1',
      entityId: annotation.id,
      payload: { annotation },
      createdAt: updatedAt,
    };
    const deletion: SyncEvent = {
      ...update,
      id: 'event-document-annotation-delete',
      type: 'document_annotation_deleted',
      payload: { id: annotation.id, deletedAt: '2026-08-01T00:04:00.000Z' },
      createdAt: '2026-08-01T00:04:00.000Z',
    };

    await expect(persistReaderSyncEvent(client, 'user_test', update)).resolves.toBe(true);
    await expect(persistReaderSyncEvent(client, 'user_test', deletion)).resolves.toBe(true);

    expect(queries[0]?.params).toEqual([
      annotation.id,
      'book_1',
      'user_test',
      2,
      'text_note',
      JSON.stringify(annotation.anchor),
      'memo',
      'yellow',
      updatedAt,
      updatedAt,
    ]);
    expect(queries[1]?.params).toEqual([annotation.id, 'user_test', '2026-08-01T00:04:00.000Z']);
  });

  it('validates fixed-document annotation page ownership before accepting sync', async () => {
    const client = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [{ page_hash: 'page-hash' }] })),
    } as unknown as pg.PoolClient;
    const event: SyncEvent = {
      id: 'event-document-annotation-validation',
      type: 'document_annotation_updated',
      deviceId: 'device_a',
      novelId: 'book_1',
      entityId: 'document-annotation-1',
      payload: {
        annotation: {
          id: 'document-annotation-1',
          bookId: 'book_1',
          pageIndex: 2,
          type: 'region_highlight',
          anchor: {
            kind: 'fixed_region',
            bookId: 'book_1',
            pageIndex: 2,
            pageHash: 'page-hash',
            quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
          },
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      },
      createdAt: '2026-08-01T00:00:00.000Z',
    };

    await expect(validateSyncEventPayload(client, event)).resolves.toEqual({ ok: true });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('document_pages'), ['book_1', 2]);
    await expect(
      validateSyncEventPayload(client, {
        ...event,
        payload: {
          annotation: {
            ...(event.payload as { annotation: Record<string, unknown> }).annotation,
            pageIndex: 3,
          },
        },
      }),
    ).resolves.toEqual({ ok: false, message: 'document annotation requires a matching non-negative page index' });
  });

  it('validates and materializes PDF reading-order overrides without source text', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('select page_hash from document_pages')) {
          return { rowCount: 1, rows: [{ page_hash: 'page-hash' }] };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as unknown as pg.PoolClient;
    const updatedAt = '2026-08-01T01:00:00.000Z';
    const orderOverride = {
      id: 'document-order-1',
      bookId: 'book_1',
      pageIndex: 2,
      pageHash: 'page-hash',
      sourceRevisionId: 'revision-hash',
      orderedBlockFingerprints: ['block-b', 'block-a'],
      excludedBlockFingerprints: ['footer'],
      createdAt: updatedAt,
      updatedAt,
    };
    const update: SyncEvent = {
      id: 'event-document-order-update',
      type: 'document_text_order_override_updated',
      deviceId: 'device_a',
      novelId: 'book_1',
      entityId: orderOverride.id,
      payload: { orderOverride },
      createdAt: updatedAt,
    };
    const deletion: SyncEvent = {
      ...update,
      id: 'event-document-order-delete',
      type: 'document_text_order_override_deleted',
      payload: { id: orderOverride.id, pageIndex: 2, deletedAt: '2026-08-01T01:01:00.000Z' },
      createdAt: '2026-08-01T01:01:00.000Z',
    };

    await expect(validateSyncEventPayload(client, update)).resolves.toEqual({ ok: true });
    await expect(persistReaderSyncEvent(client, 'user_test', update)).resolves.toBe(true);
    await expect(persistReaderSyncEvent(client, 'user_test', deletion)).resolves.toBe(true);

    expect(queries[1]?.params).toEqual([
      orderOverride.id,
      'book_1',
      'user_test',
      2,
      'page-hash',
      'revision-hash',
      JSON.stringify(orderOverride.orderedBlockFingerprints),
      JSON.stringify(orderOverride.excludedBlockFingerprints),
      updatedAt,
      updatedAt,
    ]);
    expect(queries[2]?.params).toEqual([orderOverride.id, 'user_test', '2026-08-01T01:01:00.000Z']);
    await expect(
      validateSyncEventPayload(client, {
        ...update,
        payload: { orderOverride: { ...orderOverride, pageHash: 'wrong-page' } },
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'document text order override page hash does not match the synced source',
    });
    expect(JSON.stringify(update.payload)).not.toContain('text');
  });

  it('materializes versioned trash and restore lifecycle events without deleting child rows', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }),
    } as unknown as pg.PoolClient;
    const trashed: SyncEvent = {
      id: 'event_book_trash',
      type: 'book_trashed',
      deviceId: 'device_a',
      novelId: 'book_1',
      entityId: 'book_1',
      payload: {
        bookId: 'book_1',
        deletedAt: '2026-07-13T00:00:00.000Z',
        deletedByDeviceId: 'device_a',
        metadataRevision: 3,
      },
      createdAt: '2026-07-13T00:00:00.000Z',
    };
    const restored: SyncEvent = {
      ...trashed,
      id: 'event_book_restore',
      type: 'book_restored',
      payload: { bookId: 'book_1', restoredAt: '2026-07-13T00:01:00.000Z', metadataRevision: 4 },
      createdAt: '2026-07-13T00:01:00.000Z',
    };

    await persistReaderSyncEvent(client, 'user_test', trashed);
    await persistReaderSyncEvent(client, 'user_test', restored);

    expect(queries[0].sql).toContain('set deleted_at = $3');
    expect(queries[0].params).toEqual(['book_1', 'user_test', '2026-07-13T00:00:00.000Z', 'device_a', 3]);
    expect(queries[1].sql).toContain('set deleted_at = null');
    expect(queries[1].params).toEqual(['book_1', 'user_test', '2026-07-13T00:01:00.000Z', 4]);
  });

  it('pushes and materializes reading position events', async () => {
    const materializedParams: unknown[][] = [];
    const syncEventParams: unknown[][] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rowCount: 0, rows: [] };
        if (sql.includes('from library_books') && sql.includes('for share')) {
          return { rowCount: 1, rows: [{ exists: true }] };
        }
        if (sql.includes('select exists(select 1 from chapters')) return { rowCount: 1, rows: [{ exists: true }] };
        if (sql.includes('select exists(select 1 from paragraph_search'))
          return { rowCount: 1, rows: [{ exists: true }] };
        if (sql.includes('join book_content_revisions')) return { rowCount: 1, rows: [{ should_accept: true }] };
        if (sql.includes('from reading_positions') && sql.includes('should_accept')) {
          return { rowCount: 1, rows: [{ should_accept: true }] };
        }
        if (sql.includes('insert into sync_events')) {
          syncEventParams.push(params ?? []);
          return { rowCount: 1, rows: [{ id: params?.[0] }] };
        }
        if (sql.includes('insert into reading_positions')) {
          materializedParams.push(params ?? []);
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const event = readingPositionEvent('event_position_1', '2026-07-05T00:02:00.000Z');

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope([event]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...V2_SYNC_CONTRACT, accepted: 1, acceptedIds: [event.id] });
    expect(JSON.parse(String(syncEventParams[0][7]))).toEqual(event.revision);
    expect(materializedParams).toEqual([
      ['book_1', 'user_test', 'chapter_1', 'paragraph_1', 12, 3, 0.42, 240, 'device_a', '2026-07-05T00:02:00.000Z'],
    ]);
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('skips stale reading position events before writing the event log', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rowCount: 0, rows: [] };
        if (sql.includes('from library_books') && sql.includes('for share')) {
          return { rowCount: 1, rows: [{ exists: true }] };
        }
        if (sql.includes('select exists(select 1 from chapters')) return { rowCount: 1, rows: [{ exists: true }] };
        if (sql.includes('select exists(select 1 from paragraph_search'))
          return { rowCount: 1, rows: [{ exists: true }] };
        if (sql.includes('join book_content_revisions')) return { rowCount: 1, rows: [{ should_accept: true }] };
        if (sql.includes('from reading_positions') && sql.includes('should_accept')) {
          return { rowCount: 1, rows: [{ should_accept: false }] };
        }
        if (sql.includes('insert into sync_events') || sql.includes('insert into reading_positions')) {
          throw new Error('stale events should not be inserted or materialized');
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);

    const event = readingPositionEvent('event_position_stale', '2026-07-04T00:00:00.000Z');
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope([event]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 0,
      acceptedIds: [],
      rejected: [
        {
          id: event.id,
          reason: 'stale',
          message: 'server has a newer version of this entity',
        },
      ],
    });
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('rejects book-scoped child events before logging when the server book does not exist yet', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rowCount: 0, rows: [] };
        if (sql.includes('from library_books') && sql.includes('for share')) return { rowCount: 0, rows: [] };
        if (
          sql.includes('insert into sync_events') ||
          sql.includes('insert into bookmarks') ||
          sql.includes('insert into reading_positions')
        ) {
          throw new Error('pre-attach child events should not be inserted or materialized');
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);

    const events = [
      bookmarkCreatedEvent('event_bookmark_pre_attach', '2026-07-05T00:03:00.000Z'),
      readingPositionEvent('event_position_pre_attach', '2026-07-05T00:04:00.000Z'),
      deletedEvent('bookmark_deleted', 'bookmark_pre_attach', '2026-07-05T00:05:00.000Z'),
    ];
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope(events),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 0,
      acceptedIds: [],
      rejected: [
        {
          id: events[0].id,
          reason: 'invalid',
          message: 'server book does not exist yet; upload or attach the book before syncing this event',
        },
        {
          id: events[1].id,
          reason: 'invalid',
          message: 'server book does not exist yet; upload or attach the book before syncing this event',
        },
        {
          id: events[2].id,
          reason: 'invalid',
          message: 'server book does not exist yet; upload or attach the book before syncing this event',
        },
      ],
    });
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('rejects reader child events with anchors outside the attached server book', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rowCount: 0, rows: [] };
        if (sql.includes('from library_books') && sql.includes('for share')) {
          return { rowCount: 1, rows: [{ exists: true }] };
        }
        if (sql.includes('select exists(select 1 from chapters')) return { rowCount: 1, rows: [{ exists: false }] };
        if (sql.includes('insert into sync_events') || sql.includes('insert into reading_positions')) {
          throw new Error('stale child anchors should not be inserted or materialized');
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);

    const event = readingPositionEvent('event_position_stale_anchor', '2026-07-05T00:04:00.000Z');
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope([event]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 0,
      acceptedIds: [],
      rejected: [
        {
          id: event.id,
          reason: 'invalid',
          message: 'reader anchor chapter does not belong to the synced book',
        },
      ],
    });
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('materializes bookmark, highlight, and note events after logging accepted sync events', async () => {
    const materialized: Array<{ sql: string; params?: unknown[] }> = [];
    const client = successfulInsertClient((sql, params) => materialized.push({ sql, params }));
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const events = [
      bookmarkCreatedEvent('event_bookmark_create', '2026-07-05T00:03:00.000Z'),
      highlightCreatedEvent('event_highlight_create', '2026-07-05T00:04:00.000Z'),
      noteUpdatedEvent('event_note_update', '2026-07-05T00:05:00.000Z'),
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope(events),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 3,
      acceptedIds: events.map((event) => event.id),
    });
    expect(materialized).toHaveLength(3);
    expect(materialized[0]).toMatchObject({
      sql: expect.stringContaining('insert into bookmarks'),
      params: [
        'bookmark_1',
        'book_1',
        'user_test',
        'chapter_1',
        'paragraph_1',
        'bookmark label',
        0.5,
        300,
        '2026-07-05T00:03:00.000Z',
      ],
    });
    expect(materialized[1]).toMatchObject({
      sql: expect.stringContaining('insert into highlights'),
      params: [
        'highlight_1',
        'book_1',
        'user_test',
        'chapter_1',
        'paragraph_1',
        'highlight quote',
        'yellow',
        0.6,
        '2026-07-05T00:04:00.000Z',
        '2026-07-05T00:04:00.000Z',
      ],
    });
    expect(materialized[2]).toMatchObject({
      sql: expect.stringContaining('insert into notes'),
      params: [
        'note_1',
        'book_1',
        'user_test',
        'chapter_1',
        'paragraph_1',
        'note quote',
        'note body',
        0.7,
        '2026-07-05T00:00:00.000Z',
        '2026-07-05T00:05:00.000Z',
      ],
    });
    expect(client.query).toHaveBeenCalledWith('commit');

    await app.close();
  });

  it('materializes bookmark, highlight, and note tombstone events', async () => {
    const materialized: Array<{ sql: string; params?: unknown[] }> = [];
    const client = successfulInsertClient((sql, params) => materialized.push({ sql, params }));
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const events = [
      deletedEvent('bookmark_deleted', 'bookmark_1', '2026-07-05T00:06:00.000Z'),
      deletedEvent('highlight_deleted', 'highlight_1', '2026-07-05T00:07:00.000Z'),
      deletedEvent('note_deleted', 'note_1', '2026-07-05T00:08:00.000Z'),
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope(events),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 3,
      acceptedIds: events.map((event) => event.id),
    });
    expect(materialized).toEqual([
      {
        sql: expect.stringContaining('update bookmarks set deleted_at'),
        params: ['bookmark_1', 'user_test', '2026-07-05T00:06:00.000Z'],
      },
      {
        sql: expect.stringContaining('update highlights set deleted_at'),
        params: ['highlight_1', 'user_test', '2026-07-05T00:07:00.000Z'],
      },
      {
        sql: expect.stringContaining('update notes set deleted_at'),
        params: ['note_1', 'user_test', '2026-07-05T00:08:00.000Z'],
      },
    ]);

    await app.close();
  });

  it('skips stale bookmark, highlight, and note events before writing the event log', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rowCount: 0, rows: [] };
        if (sql.includes('from library_books') && sql.includes('for share')) {
          return { rowCount: 1, rows: [{ exists: true }] };
        }
        if (sql.includes('select exists(select 1 from chapters')) return { rowCount: 1, rows: [{ exists: true }] };
        if (sql.includes('select exists(select 1 from paragraph_search'))
          return { rowCount: 1, rows: [{ exists: true }] };
        if (sql.includes('join book_content_revisions')) return { rowCount: 1, rows: [{ should_accept: true }] };
        if (sql.includes('should_accept')) return { rowCount: 1, rows: [{ should_accept: false }] };
        if (
          sql.includes('insert into sync_events') ||
          sql.includes('insert into bookmarks') ||
          sql.includes('insert into highlights') ||
          sql.includes('insert into notes')
        ) {
          throw new Error('stale entity events should not be inserted or materialized');
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithSync(pool);

    const events = [
      bookmarkCreatedEvent('event_bookmark_stale', '2026-07-04T00:00:00.000Z'),
      highlightCreatedEvent('event_highlight_stale', '2026-07-04T00:00:00.000Z'),
      noteUpdatedEvent('event_note_stale', '2026-07-04T00:00:00.000Z'),
    ];
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope(events),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 0,
      acceptedIds: [],
      rejected: [
        {
          id: events[0].id,
          reason: 'stale',
          message: 'server has a newer version of this entity',
        },
        {
          id: events[1].id,
          reason: 'stale',
          message: 'server has a newer version of this entity',
        },
        {
          id: events[2].id,
          reason: 'stale',
          message: 'server has a newer version of this entity',
        },
      ],
    });
    expect(client.query).toHaveBeenCalledWith('commit');

    await app.close();
  });

  it('round-trips reading position and reader entities through sync cursors', async () => {
    const { pool, client } = syncRoundTripPool();
    const app = await appWithSync(pool);
    const firstEvents = [
      readingPositionEvent('event_position_device_a', '2026-07-05T01:00:00.000Z'),
      bookmarkCreatedEvent('event_bookmark_device_a', '2026-07-05T01:01:00.000Z'),
      highlightCreatedEvent('event_highlight_device_a', '2026-07-05T01:02:00.000Z'),
      noteUpdatedEvent('event_note_device_a', '2026-07-05T01:03:00.000Z'),
    ];

    const pushResponse = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope(firstEvents),
    });
    expect(pushResponse.statusCode).toBe(200);
    expect(pushResponse.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 4,
      acceptedIds: firstEvents.map((event) => event.id),
    });

    const pullResponse = await app.inject({ method: 'GET', url: v2PullUrl(0) });
    expect(pullResponse.statusCode).toBe(200);
    expect(pullResponse.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      cursor: 4,
      events: firstEvents.map((event, index) => v2PullEvent(event, index + 1)),
    });

    const staleEvent = readingPositionEvent('event_position_stale_cross_device', '2026-07-05T00:59:00.000Z');
    const staleResponse = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope([staleEvent]),
    });
    expect(staleResponse.statusCode).toBe(200);
    expect(staleResponse.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 0,
      acceptedIds: [],
      rejected: [
        {
          id: staleEvent.id,
          reason: 'stale',
          message: 'server has a newer version of this entity',
        },
      ],
    });

    const deleteEvents = [
      deletedEvent('bookmark_deleted', 'bookmark_1', '2026-07-05T01:04:00.000Z'),
      deletedEvent('highlight_deleted', 'highlight_1', '2026-07-05T01:05:00.000Z'),
      deletedEvent('note_deleted', 'note_1', '2026-07-05T01:06:00.000Z'),
    ];
    const deleteResponse = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope(deleteEvents),
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      accepted: 3,
      acceptedIds: deleteEvents.map((event) => event.id),
    });

    const secondPullResponse = await app.inject({ method: 'GET', url: v2PullUrl(4) });
    expect(secondPullResponse.statusCode).toBe(200);
    expect(secondPullResponse.json()).toEqual({
      ...V2_SYNC_CONTRACT,
      cursor: 7,
      events: deleteEvents.map((event, index) => v2PullEvent(event, index + 5)),
    });
    expect(client.query).toHaveBeenCalledWith('commit');

    await app.close();
  });
});
