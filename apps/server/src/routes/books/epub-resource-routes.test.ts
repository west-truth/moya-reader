import pg from 'pg';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getObjectStream: vi.fn(),
}));

vi.mock('../../services/object-storage.js', () => ({
  createS3Client: vi.fn(() => ({})),
  deleteObject: vi.fn(async () => undefined),
  getObjectBuffer: vi.fn(),
  getObjectRangeBuffer: vi.fn(),
  getObjectStream: storage.getObjectStream,
  putRawBookObject: vi.fn(async () => undefined),
}));

import { appWithBooks } from './books-route-test-harness.js';

const resourceBytes = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10, 26, 10]);

function resourcePool(kind: 'epub_resource' | 'document_page') {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("asset.kind in ('epub_resource', 'document_page')")) {
        return {
          rows: [
            {
              id: 'asset_1',
              book_id: 'book_1',
              storage_key: `user_test/books/book_1/${kind}/asset_1.png`,
              file_name: '001 페이지.png',
              content_type: 'image/png',
              byte_length: String(resourceBytes.byteLength),
              content_hash: 'sha256:resource',
              kind,
              page_index: kind === 'document_page' ? 0 : null,
              active_content_revision_id: 'revision-r2',
              has_prior_purge: true,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  } as unknown as pg.Pool;
}

describe('hosted embedded document resources', () => {
  afterEach(() => vi.clearAllMocks());

  it.each(['epub_resource', 'document_page'] as const)(
    'returns the exact stored bytes for an active %s asset',
    async (kind) => {
      storage.getObjectStream.mockResolvedValue({
        body: Readable.from([resourceBytes]),
        contentType: 'image/png',
        contentLength: resourceBytes.byteLength,
      });
      const app = await appWithBooks(resourcePool(kind));

      const response = await app.inject({
        method: 'GET',
        url: '/api/books/book_1/resources/asset_1?contentRevisionId=revision-r2',
      });

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(resourceBytes);
      expect(response.headers['content-type']).toContain('image/png');
      expect(response.headers['content-length']).toBe(String(resourceBytes.byteLength));
      expect(response.headers.etag).toBe('sha256:resource');
      expect(response.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(response.headers['x-asset-id']).toBe('asset_1');
      expect(response.headers['x-content-revision-id']).toBe('revision-r2');
      expect(response.headers['x-asset-kind']).toBe(kind);
      expect(response.headers['x-page-index']).toBe(kind === 'document_page' ? '0' : '');
      expect(response.headers['x-asset-file-name']).toBe(encodeURIComponent('001 페이지.png'));
      expect(storage.getObjectStream).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        `user_test/books/book_1/${kind}/asset_1.png`,
      );
      await app.close();
    },
  );

  it('rejects a stale R1 resource and does not read object storage', async () => {
    const app = await appWithBooks(resourcePool('epub_resource'));
    const response = await app.inject({
      method: 'GET',
      url: '/api/books/book_1/resources/asset_1?contentRevisionId=revision-r1',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ actualContentRevisionId: 'revision-r2' });
    expect(storage.getObjectStream).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not serve an EPUB resource whose book is deleted or missing', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool;
    const app = await appWithBooks(pool);
    const response = await app.inject({
      method: 'GET',
      url: '/api/books/book_1/resources/asset_1?contentRevisionId=revision-r2',
    });
    expect(response.statusCode).toBe(404);
    expect(storage.getObjectStream).not.toHaveBeenCalled();
    await app.close();
  });
});
