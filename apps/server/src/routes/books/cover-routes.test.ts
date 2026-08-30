import Fastify from 'fastify';
import pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integrityHash } from '@noveldesk/text-core/hash';
import type { ServerConfig } from '../../config.js';
import { registerBookCoverRoutes } from './cover-routes.js';

const objectStorage = vi.hoisted(() => ({
  putRawBookObject: vi.fn(async () => undefined),
  deleteObject: vi.fn(async () => undefined),
  getObjectBuffer: vi.fn(async () => ({ body: Buffer.alloc(0) })),
  createS3Client: vi.fn(() => ({})),
}));

vi.mock('../../services/object-storage.js', () => objectStorage);

function config(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir: '.server-test-data',
    maxChunkBytes: 1024,
    maxUploadBytes: 1024 * 1024,
    staleUploadMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    s3: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
    },
  };
}

function coverRequest(contentRevisionId: string, body: Buffer) {
  return {
    method: 'PUT' as const,
    url: '/api/books/book-1/cover',
    headers: {
      'content-type': 'application/octet-stream',
      'x-cover-file-name': encodeURIComponent('cover.jpg'),
      'x-cover-content-type': 'image/jpeg',
      'x-cover-content-hash': integrityHash(body),
      'x-cover-width': '480',
      'x-cover-height': '720',
      'x-cover-fit': 'crop',
      'x-cover-position-x': '50',
      'x-cover-position-y': '50',
      'x-expected-metadata-revision': '1',
      'x-expected-content-revision-id': contentRevisionId,
    },
    payload: body,
  };
}

async function coverApp(pool: pg.Pool) {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  await registerBookCoverRoutes(app, pool, config());
  return app;
}

describe('hosted cover content-incarnation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an R1 upload after the same book id has been purged and recreated as R2', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('from library_books')) {
          return {
            rows: [
              {
                id: 'book-1',
                cover_asset_id: null,
                metadata_revision: 1,
                active_content_revision_id: 'revision-2',
                has_prior_purge: true,
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as pg.Pool;
    const app = await coverApp(pool);
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

    const response = await app.inject(coverRequest('revision-1', body));

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'book content revision changed' });
    expect(queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes('insert into book_assets'))).toBe(false);
    expect(objectStorage.deleteObject).toHaveBeenCalledOnce();
    await app.close();
  });

  it('binds the stored cover and emitted book update to the canonical R2 token', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('from library_books')) {
          return {
            rows: [
              {
                id: 'book-1',
                cover_asset_id: null,
                metadata_revision: 1,
                active_content_revision_id: 'revision-2',
                has_prior_purge: true,
              },
            ],
          };
        }
        if (sql.includes('update library_books set cover_asset_id')) return { rows: [{ metadata_revision: 2 }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({
        rows: [
          {
            id: 'cover-1',
            book_id: 'book-1',
            kind: 'cover',
            provenance: 'user_supplied',
            status: 'active',
          },
        ],
      })),
    } as unknown as pg.Pool;
    const app = await coverApp(pool);
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

    const response = await app.inject(coverRequest('revision-2', body));

    expect(response.statusCode).toBe(200);
    const assetInsert = queries.find(({ sql }) => sql.includes('insert into book_assets'));
    expect(assetInsert?.params?.[3]).toBe('revision-2');
    const eventInsert = queries.find(({ sql }) => sql.includes('insert into sync_events'));
    expect(JSON.parse(String(eventInsert?.params?.[6]))).toMatchObject({ contentRevisionId: 'revision-2' });
    expect(JSON.parse(String(eventInsert?.params?.[7]))).toMatchObject({ payloadHash: expect.any(String) });
    await app.close();
  });

  it('durably records an explicit removal even when no active cover remains', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('from library_books')) {
          return {
            rows: [
              {
                id: 'book-1',
                cover_asset_id: null,
                metadata_revision: 4,
                active_content_revision_id: 'revision-2',
                has_prior_purge: true,
              },
            ],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as pg.Pool;
    const app = await coverApp(pool);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/books/book-1/cover',
      payload: { expectedRevision: 4, expectedContentRevisionId: 'revision-2' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      coverRemovedAt: expect.any(String),
      metadataRevision: 5,
    });
    const removal = queries.find(({ sql }) => sql.includes('cover_removed_at = $1'));
    expect(removal?.params?.[0]).toBe(response.json().coverRemovedAt);
    expect(queries.some(({ sql }) => sql.includes('delete from book_assets'))).toBe(false);
    const eventInsert = queries.find(({ sql }) => sql.includes('insert into sync_events'));
    expect(JSON.parse(String(eventInsert?.params?.[6]))).toMatchObject({
      novel: {
        coverAssetId: null,
        coverRemovedAt: response.json().coverRemovedAt,
        metadataRevision: 5,
      },
      contentRevisionId: 'revision-2',
    });
    await app.close();
  });
});
