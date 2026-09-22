import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { registerAuthHook } from '../auth.js';
import { testConfig } from './books/books-route-test-harness.js';
import { createHostedBackupStream } from '../services/hosted-backup-archive.js';
import { restoreHostedBackup } from '../services/hosted-backup-service.js';
import { registerBackupRoutes } from './backups.js';

vi.mock('../services/hosted-backup-service.js', async (original) => ({
  ...(await original<typeof import('../services/hosted-backup-service.js')>()),
  exportHostedBackup: vi.fn(async () => fixtureZip()),
  restoreHostedBackup: vi.fn(async () => ({ restoredBooks: 0, skippedBooks: 0, copiedBooks: 0, restoredEntries: 0 })),
}));
function fixtureZip() {
  const bytes = Buffer.alloc(2 * 1024 ** 2, 123);
  return createHostedBackupStream(
    {
      tables: new Map([
        ['library_books', []],
        ['reader_settings', []],
      ]),
      books: [],
      exportedAt: '2026-09-22T00:00:00Z',
      appVersion: 'test',
      objects: [
        {
          id: 'source',
          raw_text_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          storage_key: 'source',
          file_name: 'source.cbz',
          content_type: 'application/zip',
          size_bytes: bytes.length,
          created_at: '2026-09-22T00:00:00Z',
        },
      ],
    },
    async () => bytes,
  );
}

it('authenticates issue/inspect/restore, streams past the default body limit, and restores once without a second upload', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moya-backup-route-'));
  const app = Fastify({ bodyLimit: 1024 });
  const config = { ...testConfig(), dataDir: directory, authToken: 'test-secret' };
  const headers = { authorization: 'Bearer test-secret' };
  app.addContentTypeParser('application/zip', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  await registerAuthHook(app, config);
  await registerBackupRoutes(app, { query: async () => ({ rows: [] }) } as unknown as pg.Pool, config);
  try {
    expect((await app.inject({ method: 'POST', url: '/api/backups/download' })).statusCode).toBe(401);
    const issue = await app.inject({ method: 'POST', url: '/api/backups/download', headers });
    expect(issue.statusCode).toBe(200);
    const url = `/api/backups/download/${issue.json().ticket}`;
    const download = await app.inject(url);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.length).toBeGreaterThan(1024 ** 2);
    expect((await app.inject(url)).statusCode).toBe(410);
    expect((await app.inject(`/api/backups/download/${'x'.repeat(43)}`)).statusCode).toBe(410);
    const inspect = await app.inject({
      method: 'POST',
      url: '/api/backups/inspect',
      headers: { ...headers, 'content-type': 'application/zip' },
      payload: download.rawPayload,
    });
    expect(inspect.statusCode, inspect.body).toBe(200);
    const { stagedId } = inspect.json();
    const restoreUrl = `/api/backups/staged/${stagedId}/restore`;
    expect((await app.inject({ method: 'POST', url: restoreUrl })).statusCode).toBe(401);
    const restored = await app.inject({ method: 'POST', url: restoreUrl, headers });
    expect(restored.statusCode, restored.body).toBe(200);
    const parsed = vi.mocked(restoreHostedBackup).mock.calls.at(-1)![2];
    expect('assetBlobs' in parsed && parsed.assetBlobs.get('source')).toBeInstanceOf(Blob);
    expect(await readdir(path.join(directory, 'backup-staging'))).toEqual([]);
    expect((await app.inject({ method: 'POST', url: restoreUrl, headers })).statusCode).toBe(410);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
