import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appWithBooks } from './books-route-test-harness.js';

describe('book catalog routes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('atomically patches only requested metadata fields and emits the final snapshot', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
        if (sql.includes('update library_books')) {
          return {
            rowCount: 1,
            rows: [
              {
                title: 'Existing title',
                author: null,
                series_title: null,
                series_index: null,
                tags: [],
                description: null,
                language: null,
                cover_asset_id: null,
                cover_fit: 'crop',
                cover_position_x: 50,
                cover_position_y: 50,
                favorite: true,
                analysis_status: 'ready',
                metadata_revision: 8,
                active_content_revision_id: 'revision-1',
                updated_at: '2026-07-13T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('insert into sync_events')) return { rowCount: 1, rows: [] };
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rowCount: null, rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/books/book_1',
      payload: { favorite: true },
    });

    expect(response.statusCode).toBe(200);
    const update = queries.find((query) => query.sql.includes('update library_books'));
    expect(update?.sql).toContain('title = coalesce($1, title)');
    expect(update?.sql).toContain('favorite = coalesce($14, favorite)');
    expect(update?.sql).toContain('analysis_status = coalesce($15, analysis_status)');
    expect(update?.params?.[13]).toBe(true);
    expect(update?.params?.slice(18)).toEqual(['book_1', 'user_test', null, null]);
    expect(queries.some((query) => query.sql.includes('select id, title, favorite'))).toBe(false);
    const syncInsert = queries.find((query) => query.sql.includes('insert into sync_events'));
    expect(JSON.parse(String(syncInsert?.params?.[6]))).toMatchObject({
      novel: {
        id: 'book_1',
        title: 'Existing title',
        favorite: true,
        analysisStatus: 'ready',
        metadataRevision: 8,
      },
      contentRevisionId: 'revision-1',
    });
    expect(client.release).toHaveBeenCalledOnce();

    await app.close();
  });

  it('commits a soft-delete lifecycle update and its sync event on the same client transaction', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
        if (sql.includes('update library_books')) {
          return {
            rowCount: 1,
            rows: [
              {
                id: 'book_1',
                deleted_at: '2026-07-13T00:00:00.000Z',
                metadata_revision: 3,
                active_content_revision_id: 'revision-1',
              },
            ],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({ method: 'DELETE', url: '/api/books/book_1' });

    expect(response.statusCode).toBe(200);
    expect(queries[0]).toBe('begin');
    expect(queries[1]).toContain('pg_advisory_xact_lock');
    expect(queries[2]).toContain('set deleted_at = now()');
    expect(queries[3]).toContain('insert into sync_events');
    expect(queries[4]).toBe('commit');
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('rolls back and releases when the deletion sync event cannot be inserted', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
        if (sql.includes('update library_books')) {
          return {
            rowCount: 1,
            rows: [
              {
                id: 'book_1',
                deleted_at: '2026-07-13T00:00:00.000Z',
                metadata_revision: 3,
                active_content_revision_id: 'revision-1',
              },
            ],
          };
        }
        if (sql.includes('insert into sync_events')) throw new Error('sync insert failed');
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({ method: 'DELETE', url: '/api/books/book_1' });

    expect(response.statusCode).toBe(500);
    expect(queries.at(-1)).toBe('rollback');
    expect(queries).not.toContain('commit');
    expect(client.release).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('rolls back and releases a missing-book deletion', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({ method: 'DELETE', url: '/api/books/missing' });

    expect(response.statusCode).toBe(404);
    expect(queries[0]).toBe('begin');
    expect(queries[1]).toContain('pg_advisory_xact_lock');
    expect(queries[2]).toContain('set deleted_at = now()');
    expect(queries[3]).toContain('select metadata_revision from library_books');
    expect(queries[4]).toBe('rollback');
    expect(client.release).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('lists trash separately and exposes source metadata without returning object bytes', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('b.deleted_at is not null')) {
          return {
            rows: [{ id: 'book_1', title: 'Trashed', deleted_at: '2026-07-13T00:00:00.000Z' }],
          };
        }
        if (sql.includes('join book_objects')) {
          return {
            rows: [
              {
                id: 'object_1',
                book_id: 'book_1',
                storage_key: 'user/object/book.txt',
                file_name: 'book.txt',
                content_type: 'text/plain',
                size_bytes: 128,
                raw_text_hash: 'sha256:source',
              },
            ],
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const trash = await app.inject({ method: 'GET', url: '/api/trash/books' });
    const source = await app.inject({ method: 'GET', url: '/api/books/book_1/source/metadata' });

    expect(trash.statusCode).toBe(200);
    expect(trash.json().books[0]).toMatchObject({ id: 'book_1', title: 'Trashed' });
    expect(source.statusCode).toBe(200);
    expect(source.json().source).toMatchObject({ id: 'object_1', raw_text_hash: 'sha256:source' });
    await app.close();
  });

  it('restores a trashed book with revision fencing', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
        if (sql.includes('update library_books')) {
          return {
            rows: [
              {
                id: 'book_1',
                updated_at: '2026-07-13T01:00:00.000Z',
                metadata_revision: 4,
                active_content_revision_id: 'revision-1',
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/trash/books/book_1/restore',
      payload: { expectedRevision: 3 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, metadataRevision: 4 });
    expect(queries[1]).toContain('pg_advisory_xact_lock');
    expect(queries[2]).toContain('deleted_at = null');
    expect(queries[3]).toContain('insert into sync_events');
    expect(queries.at(-1)).toBe('commit');
    await app.close();
  });

  it('permanently purges only a trashed book and reference-checks its source object', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('from library_books') && sql.includes('for update')) {
          return {
            rows: [
              {
                object_id: 'object_1',
                metadata_revision: 4,
                active_content_revision_id: 'revision-1',
                deleted_at: '2026-07-13T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('select storage_key from book_assets')) {
          return { rows: [{ storage_key: 'user/book/page-1' }] };
        }
        if (sql.includes('delete from library_books')) {
          return {
            rows: [
              {
                object_id: 'object_1',
                metadata_revision: 4,
                active_content_revision_id: 'revision-1',
              },
            ],
          };
        }
        if (sql.includes('delete from book_objects')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/trash/books/book_1',
      payload: { expectedRevision: 4 },
    });

    expect(response.statusCode).toBe(200);
    expect(queries[1]).toContain('pg_advisory_xact_lock');
    expect(queries[2]).toContain('for update');
    expect(queries[2]).toContain('deleted_at');
    expect(queries.indexOf(queries[2])).toBeLessThan(
      queries.findIndex((sql) => sql.includes('select storage_key from book_assets')),
    );
    const referencedObjectQuery = queries.find((sql) => sql.includes('select storage_key from book_assets')) ?? '';
    expect(referencedObjectQuery).toContain('from tts_audio_cache where book_id = $1');
    expect(referencedObjectQuery).not.toContain('tts_audio_cache where book_id = $1 and user_id');
    expect(queries.some((sql) => sql.includes('delete from book_objects'))).toBe(true);
    expect(queries.some((sql) => sql.includes('insert into object_delete_outbox'))).toBe(true);
    expect(queries.at(-1)).toBe('commit');
    await app.close();
  });

  it('serializes empty-trash purges with every active image-series append', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('select id, active_content_revision_id from library_books')) {
          return {
            rows: [
              { id: 'book_a', active_content_revision_id: 'revision-a' },
              { id: 'book_b', active_content_revision_id: 'revision-b' },
            ],
          };
        }
        if (sql.includes('from library_books') && sql.includes('for update')) {
          const bookId = String(params?.[0]);
          const suffix = bookId === 'book_a' ? 'a' : 'b';
          return {
            rows: [
              {
                object_id: null,
                metadata_revision: bookId === 'book_a' ? 2 : 4,
                active_content_revision_id: `revision-${suffix}`,
                deleted_at: '2026-07-13T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('select storage_key from book_assets')) return { rows: [] };
        if (sql.includes('delete from library_books')) {
          const bookId = String(params?.[0]);
          const suffix = bookId === 'book_a' ? 'a' : 'b';
          return {
            rows: [
              {
                object_id: null,
                metadata_revision: bookId === 'book_a' ? 2 : 4,
                active_content_revision_id: `revision-${suffix}`,
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await appWithBooks(pool);

    const response = await app.inject({ method: 'DELETE', url: '/api/trash/books' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, purged: 2, bookIds: ['book_a', 'book_b'] });
    const locks = queries.filter(({ sql }) => sql.includes('pg_advisory_xact_lock'));
    expect(locks.slice(0, 2).map(({ params }) => params)).toEqual([
      ['book_a', 7319],
      ['book_b', 7319],
    ]);
    expect(queries.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toBeLessThan(
      queries.findIndex(({ sql }) => sql.includes('delete from library_books')),
    );
    expect(queries.at(-1)?.sql).toBe('commit');
    await app.close();
  });
});
