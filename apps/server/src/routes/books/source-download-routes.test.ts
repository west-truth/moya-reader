import { Readable } from 'node:stream';
import pg from 'pg';
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

const originalBytes = Buffer.from([0, 1, 2, 3, 4, 5, 254, 255]);

function sourcePool() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('select o.storage_key')) {
        return {
          rows: [
            {
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
    expect(storage.getObjectStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'user/object/original.epub',
      undefined,
    );
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
});
