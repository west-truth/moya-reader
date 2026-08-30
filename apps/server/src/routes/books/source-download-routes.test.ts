import { Readable } from 'node:stream';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { integrityHash } from '@noveldesk/text-core/hash';

const storage = vi.hoisted(() => ({
  getObjectStream: vi.fn(),
  putRawBookObject: vi.fn(async () => undefined),
}));

vi.mock('../../services/object-storage.js', () => ({
  createS3Client: vi.fn(() => ({})),
  deleteObject: vi.fn(async () => undefined),
  getObjectBuffer: vi.fn(),
  getObjectRangeBuffer: vi.fn(),
  getObjectStream: storage.getObjectStream,
  putRawBookObject: storage.putRawBookObject,
}));

import { appWithBooks } from './books-route-test-harness.js';

const originalBytes = Buffer.from([0, 1, 2, 3, 4, 5, 254, 255]);

function sourcePool() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('select o.id') && sql.includes('b.active_content_revision_id as content_revision_id')) {
        return {
          rows: [
            {
              id: 'object_1',
              book_id: 'book_1',
              content_revision_id: 'revision-r1',
              file_name: 'book.epub',
              content_type: 'application/epub+zip',
              size_bytes: originalBytes.byteLength,
              raw_text_hash: 'sha256:source',
            },
          ],
        };
      }
      if (sql.includes('o.storage_key') && sql.includes('join book_objects')) {
        return {
          rows: [
            {
              content_revision_id: 'revision-r1',
              storage_key: 'user/object/original.epub',
              file_name: '돌아온 밤.epub',
              content_type: 'application/epub+zip',
              size_bytes: originalBytes.byteLength,
              raw_text_hash: 'sha256:source',
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  } as unknown as pg.Pool;
}

async function sourceUploadApp(pool: pg.Pool) {
  const app = await appWithBooks(pool);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  return app;
}

describe('hosted original source download', () => {
  afterEach(() => vi.clearAllMocks());

  it('streams the exact stored bytes as an attachment without transforming the source', async () => {
    storage.getObjectStream.mockResolvedValue({
      body: Readable.from([originalBytes]),
      contentType: 'application/epub+zip',
      contentLength: originalBytes.byteLength,
    });
    const app = await appWithBooks(sourcePool());

    const response = await app.inject({ method: 'GET', url: '/api/books/book_1/source' });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(originalBytes);
    expect(response.headers['content-type']).toContain('application/epub+zip');
    expect(response.headers['content-length']).toBe(String(originalBytes.byteLength));
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.headers['content-disposition']).toContain(
      "filename*=UTF-8''%EB%8F%8C%EC%95%84%EC%98%A8%20%EB%B0%A4.epub",
    );
    expect(response.headers['x-source-content-hash']).toBe('sha256:source');
    expect(response.headers['x-content-revision-id']).toBe('revision-r1');
    expect(storage.getObjectStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'user/object/original.epub',
      undefined,
    );
    await app.close();
  });

  it('rejects a source download when the caller metadata belongs to an older incarnation', async () => {
    const app = await appWithBooks(sourcePool());

    const response = await app.inject({
      method: 'GET',
      url: '/api/books/book_1/source',
      headers: { 'x-expected-content-revision-id': 'revision-r0' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'book content revision changed' });
    expect(storage.getObjectStream).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects stale source metadata before a client can hydrate the wrong incarnation', async () => {
    const app = await appWithBooks(sourcePool());

    const response = await app.inject({
      method: 'GET',
      url: '/api/books/book_1/source/metadata',
      headers: { 'x-expected-content-revision-id': 'revision-r0' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'book content revision changed' });
    await app.close();
  });

  it('preserves byte-range downloads for resumable and fixed-document reads', async () => {
    const rangeBytes = originalBytes.subarray(2, 5);
    storage.getObjectStream.mockResolvedValue({
      body: Readable.from([rangeBytes]),
      contentType: 'application/epub+zip',
      contentLength: rangeBytes.byteLength,
    });
    const app = await appWithBooks(sourcePool());

    const response = await app.inject({
      method: 'GET',
      url: '/api/books/book_1/source',
      headers: { range: 'bytes=2-4' },
    });

    expect(response.statusCode).toBe(206);
    expect(response.rawPayload).toEqual(rangeBytes);
    expect(response.headers['content-length']).toBe('3');
    expect(response.headers['content-range']).toBe(`bytes 2-4/${originalBytes.byteLength}`);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(storage.getObjectStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'user/object/original.epub',
      {
        startInclusive: 2,
        endInclusive: 4,
      },
    );
    await app.close();
  });

  it('does not attach an R1 source upload after the same book id was recreated as R2', async () => {
    const body = Buffer.from('same source bytes');
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('coalesce(r.source_raw_text_hash')) {
          return {
            rows: [
              {
                id: 'book_1',
                object_id: null,
                active_content_revision_id: 'revision-r2',
                source_raw_text_hash: integrityHash(body),
                has_prior_purge: true,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await sourceUploadApp(pool);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/books/book_1/source',
      headers: {
        'content-type': 'application/octet-stream',
        'x-source-file-name': 'book.txt',
        'x-expected-content-revision-id': 'revision-r1',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'book content revision changed' });
    expect(queries[1]).toContain('pg_advisory_xact_lock');
    expect(queries.some((sql) => sql.includes('update library_books'))).toBe(false);
    expect(storage.putRawBookObject).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires the canonical revision for tokenless source hydration after an id was reused', async () => {
    const body = Buffer.from('same source bytes');
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('coalesce(r.source_raw_text_hash')) {
          return {
            rows: [
              {
                id: 'book_1',
                object_id: null,
                active_content_revision_id: 'revision-r2',
                source_raw_text_hash: integrityHash(body),
                has_prior_purge: true,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const app = await sourceUploadApp({ connect: vi.fn(async () => client) } as unknown as pg.Pool);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/books/book_1/source',
      headers: { 'content-type': 'application/octet-stream', 'x-source-file-name': 'book.txt' },
      payload: body,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'book content revision is required' });
    expect(storage.putRawBookObject).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps byte-identical source hydration working when the canonical revision matches', async () => {
    const body = Buffer.from('same source bytes');
    const contentHash = integrityHash(body);
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('coalesce(r.source_raw_text_hash')) {
          return {
            rows: [
              {
                id: 'book_1',
                object_id: null,
                active_content_revision_id: 'revision-r2',
                source_raw_text_hash: contentHash,
                has_prior_purge: true,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('from book_objects where raw_text_hash')) {
          return {
            rows: [
              {
                id: 'object_1',
                storage_key: 'user/object/book.txt',
                file_name: 'book.txt',
                content_type: 'text/plain',
                size_bytes: body.byteLength,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('update library_books')) {
          return {
            rows: [{ metadata_revision: 4, updated_at: '2026-08-31T00:00:00.000Z' }],
            rowCount: 1,
          };
        }
        if (sql.includes('update book_content_revisions')) return { rows: [], rowCount: 1 };
        if (sql.includes('select o.id, b.id as book_id')) {
          return {
            rows: [
              {
                id: 'object_1',
                book_id: 'book_1',
                content_revision_id: 'revision-r2',
                storage_key: 'user/object/book.txt',
                file_name: 'book.txt',
                content_type: 'text/plain',
                size_bytes: body.byteLength,
                raw_text_hash: contentHash,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const app = await sourceUploadApp({ connect: vi.fn(async () => client) } as unknown as pg.Pool);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/books/book_1/source',
      headers: {
        'content-type': 'application/octet-stream',
        'x-source-file-name': 'book.txt',
        'x-source-content-type': 'text/plain',
        'x-expected-content-revision-id': 'revision-r2',
      },
      payload: body,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().source).toMatchObject({
      id: 'object_1',
      content_revision_id: 'revision-r2',
      raw_text_hash: contentHash,
    });
    const attached = queries.find(({ sql }) => sql.includes('update library_books'));
    expect(attached?.params?.at(-1)).toBe('revision-r2');
    expect(queries.some(({ sql }) => sql.includes('insert into sync_events'))).toBe(true);
    expect(storage.putRawBookObject).not.toHaveBeenCalled();
    await app.close();
  });
});
