import Fastify from 'fastify';
import type pg from 'pg';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_ARCHIVE_SERIES_TYPE } from '@noveldesk/document-series-core';
import { registerAuthHook } from '../../auth.js';
import { getObjectStream } from '../../services/object-storage.js';
import { registerOriginalFileRoutes } from './original-file-routes.js';
import { testConfig } from './books-route-test-harness.js';

vi.mock('../../services/object-storage.js', () => ({
  createS3Client: () => ({ destroy() {} }),
  getObjectStream: vi.fn(),
}));

const auth = { authorization: 'Bearer test-secret' };
const part = {
  id: 'part-1',
  storageKey: 'private/key',
  fileName: '한글 2권.epub',
  contentType: 'application/epub+zip',
  byteLength: String(2 * 1024 ** 3),
  contentHash: 'sha256:original',
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

async function setup() {
  let source: typeof part | undefined = { ...part, id: 'index', contentType: LOCAL_ARCHIVE_SERIES_TYPE };
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    expect(values[1]).toBe('user_test');
    expect(sql).toContain('b.deleted_at is null');
    if (values[0] !== 'book-1') return { rows: [] };
    if (sql.includes('from book_assets')) {
      expect(sql).toContain("a.kind='source_part' and a.status='active'");
      expect(sql).toContain('order by a.page_index');
      expect(values[2]).toBe('index');
      return { rows: [part, { ...part, id: 'part-2', fileName: '한글 10권.epub' }] };
    }
    return { rows: source ? [source] : [] };
  });
  const app = Fastify();
  apps.push(app);
  const config = { ...testConfig(), authToken: 'test-secret' };
  await registerAuthHook(app, config);
  await registerOriginalFileRoutes(app, { query } as unknown as pg.Pool, config);
  const issue = async (fileId = 'part-1') => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/books/book-1/original-files/${fileId}/download`,
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    return `/api/original-downloads/${response.json().ticket}`;
  };
  return {
    app,
    issue,
    setSource: (value: typeof source) => {
      source = value;
    },
  };
}

describe('original file downloads', () => {
  it('lists multi-GB originals in order without reading object bodies or exposing storage keys', async () => {
    const { app } = await setup();
    vi.mocked(getObjectStream).mockClear();
    const response = await app.inject({ url: '/api/books/book-1/original-files', headers: auth });
    expect(response.json().files.map((f: { fileName: string }) => f.fileName)).toEqual([
      '한글 2권.epub',
      '한글 10권.epub',
    ]);
    expect(response.json().files[0].byteLength).toBe(2 * 1024 ** 3);
    expect(response.body).not.toContain('storageKey');
    expect(getObjectStream).not.toHaveBeenCalled();
  });

  it('requires account auth to list/issue, rejects wrong files, and consumes an exact single-file ticket once', async () => {
    const { app, issue, setSource } = await setup();
    expect((await app.inject('/api/books/book-1/original-files')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/books/other-book/original-files', headers: auth })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/books/book-1/original-files/part-1/download' })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', headers: auth, url: '/api/books/book-1/original-files/other/download' }))
        .statusCode,
    ).toBe(404);
    setSource({ ...part, byteLength: '3' });
    const path = await issue();
    expect((await app.inject({ method: 'POST', url: path })).statusCode).toBe(401);
    vi.mocked(getObjectStream).mockResolvedValueOnce({ body: Readable.from(['abc']) });
    const response = await app.inject(path);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('abc');
    expect(response.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await app.inject(path)).statusCode).toBe(410);
    expect((await app.inject('/api/original-downloads/' + 'x'.repeat(43))).statusCode).toBe(410);
  });

  it('expires unused tickets and rechecks deleted or replaced originals', async () => {
    const { app, issue, setSource } = await setup();
    const expired = await issue();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    expect((await app.inject(expired)).statusCode).toBe(410);
    clock.mockRestore();
    const deleted = await issue();
    setSource(undefined);
    expect((await app.inject(deleted)).statusCode).toBe(404);
    setSource(part);
    const replaced = await issue();
    setSource({ ...part, contentHash: 'sha256:changed' });
    expect((await app.inject(replaced)).statusCode).toBe(404);
  });

  it('uses ordinary files directly and leaves internal portable formats to the existing exporter', async () => {
    const { app, setSource } = await setup();
    setSource(part);
    expect((await app.inject({ url: '/api/books/book-1/original-files', headers: auth })).json().files).toHaveLength(1);
    setSource({ ...part, contentType: 'application/vnd.moya.comic-manifest+zip' });
    expect((await app.inject({ url: '/api/books/book-1/original-files', headers: auth })).json()).toEqual({
      files: null,
    });
  });

  it('streams a file larger than the old 500MiB export limit over HTTP with matching bytes/hash', async () => {
    const { app, issue, setSource } = await setup();
    const size = 513 * 1024 ** 2;
    setSource({ ...part, byteLength: String(size) });
    const block = Buffer.alloc(64 * 1024, 123);
    const expected = createHash('sha256');
    let produced = 0;
    const body = Readable.from(
      (async function* () {
        while (produced < size) {
          produced += block.length;
          expected.update(block);
          yield block;
        }
      })(),
    );
    vi.mocked(getObjectStream).mockResolvedValueOnce({ body });
    const url = await issue();
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(base + url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(size));
    const actual = createHash('sha256');
    let received = 0;
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      actual.update(value);
    }
    expect(received).toBe(size);
    expect(actual.digest('hex')).toBe(expected.digest('hex'));
    expect(body.destroyed).toBe(true);
  }, 30_000);

  it('destroys the upstream stream when the browser cancels the download', async () => {
    const { app, issue } = await setup();
    const body = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024));
      },
    });
    vi.mocked(getObjectStream).mockResolvedValueOnce({ body });
    const path = await issue();
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const abort = new AbortController();
    const response = await fetch(base + path, { signal: abort.signal });
    await response.body!.getReader().read();
    abort.abort();
    await vi.waitFor(() => expect(body.destroyed).toBe(true));
  });
});
