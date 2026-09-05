import Fastify from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import pg from 'pg';
import { ServerConfig } from '../config.js';
import { registerUploadRoutes } from './uploads.js';

function testConfig(): ServerConfig {
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

function appWithUploads(pool: pg.Pool, queue: Queue) {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );
  return registerUploadRoutes(app, pool, testConfig(), queue).then(() => app);
}

describe('upload routes', () => {
  it.each([{ kind: 'absent' }, { kind: 'revision', contentRevisionId: 'revision_1' }] as const)(
    'stores and returns the $kind caller snapshot fence',
    async (expectedBase) => {
      let storedBase: unknown;
      const pool = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('insert into upload_sessions')) {
            storedBase = JSON.parse(String(params?.[13]));
            return { rows: [] };
          }
          if (sql.includes('from upload_sessions'))
            return {
              rows: [
                {
                  id: 'upload_fixture',
                  size_bytes: '4',
                  total_chunks: 1,
                  status: 'uploading',
                  expected_base: storedBase,
                },
              ],
            };
          return { rows: [] };
        }),
      } as unknown as pg.Pool;
      const app = await appWithUploads(pool, { add: vi.fn() } as unknown as Queue);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/uploads/init',
          payload: { fileName: 'fixture.txt', sizeBytes: 4, totalChunks: 1, clientBookId: 'book', expectedBase },
        });
        expect(response.statusCode).toBe(200);
        expect(storedBase).toEqual(expectedBase);
        expect((await app.inject('/api/uploads/upload_fixture')).json().expectedBase).toEqual(expectedBase);
      } finally {
        await app.close();
      }
    },
  );

  it.each([
    { expectedBase: {} },
    { expectedBase: { kind: 'revision', contentRevisionId: '' } },
    { expectedBase: { kind: 'absent', contentRevisionId: 'unexpected' } },
    { expectedBase: { kind: 'absent' }, clientBookId: undefined },
    { expectedBase: { kind: 'absent' }, importMode: 'append_image_series' },
  ])('rejects an invalid or incompatible caller snapshot fence %#', async (override) => {
    const pool = { query: vi.fn() } as unknown as pg.Pool;
    const app = await appWithUploads(pool, { add: vi.fn() } as unknown as Queue);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/uploads/init',
        payload: { fileName: 'fixture.txt', sizeBytes: 4, totalChunks: 1, clientBookId: 'book', ...override },
      });
      expect(response.statusCode).toBe(400);
      expect(pool.query).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes the latest import job summary in upload status responses', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from upload_sessions')) {
          return {
            rows: [
              {
                id: 'upload_1',
                file_name: 'novel.txt',
                size_bytes: '12',
                content_type: 'text/plain',
                encoding: 'utf-8',
                chapter_split_mode: 'mixed',
                status: 'queued',
                total_chunks: 3,
                created_at: '2026-07-05T00:00:00.000Z',
                updated_at: '2026-07-05T00:00:01.000Z',
              },
            ],
          };
        }
        if (sql.includes('from upload_chunks')) {
          return {
            rows: [
              { chunk_index: 0, size_bytes: 4 },
              { chunk_index: 1, size_bytes: 4 },
              { chunk_index: 2, size_bytes: 4 },
            ],
          };
        }
        if (sql.includes('from import_jobs')) {
          return { rows: [{ id: 'job_1', status: 'queued', stage: 'queued' }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const queue = { add: vi.fn() } as unknown as Queue;
    const app = await appWithUploads(pool, queue);

    const response = await app.inject({ method: 'GET', url: '/api/uploads/upload_1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      uploadId: 'upload_1',
      status: 'queued',
      expectedBytes: 12,
      expectedChunks: 3,
      uploadedBytes: 12,
      receivedChunkIndexes: [0, 1, 2],
      missingChunkIndexes: [],
      complete: true,
      importJobId: 'job_1',
      importJobStatus: 'queued',
      importJobStage: 'queued',
      chapterSplitMode: 'mixed',
    });

    await app.close();
  });

  it('requeues queued import jobs when hosted clients poll job status', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from import_jobs') && sql.includes('where id = $1'))
          return {
            rows: [
              {
                id: 'job_1',
                upload_id: 'upload_1',
                status: 'queued',
                stage: 'queued',
                bytes_read: 12,
                total_bytes: 12,
                chapters_detected: 0,
                paragraphs_written: 0,
                message: 'queued',
              },
            ],
          };
        if (sql.startsWith('select active_queue_job_id')) return { rows: [{ active_queue_job_id: null }] };
        if (sql.startsWith('update import_jobs')) return { rows: [{ id: 'job_1' }], rowCount: 1 };
        throw new Error(`unexpected query: ${sql} ${String(params)}`);
      }),
    } as unknown as pg.Pool;
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const app = await appWithUploads(pool, queue);

    const response = await app.inject({ method: 'GET', url: '/api/import-jobs/job_1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'job_1', status: 'queued', upload_id: 'upload_1' });
    expect(queue.add).toHaveBeenCalledWith(
      'import-upload',
      { jobId: 'job_1', uploadId: 'upload_1' },
      { jobId: expect.stringMatching(/^import_attempt_/) },
    );

    await app.close();
  });

  it('keeps queued import job status readable when requeue retry fails', async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            id: 'job_1',
            upload_id: 'upload_1',
            status: 'queued',
            stage: 'queued',
          },
        ],
      })),
    } as unknown as pg.Pool;
    const queue = {
      add: vi.fn(async () => {
        throw new Error('redis unavailable');
      }),
    } as unknown as Queue;
    const app = await appWithUploads(pool, queue);

    const response = await app.inject({ method: 'GET', url: '/api/import-jobs/job_1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'job_1', status: 'queued', upload_id: 'upload_1' });
    expect(queue.add).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('stores a safe client book id during upload initialization', async () => {
    const pool = {
      query: vi.fn(async (_sql: string, params?: unknown[]) => {
        expect(params).toEqual([
          expect.stringMatching(/^upload_/),
          'user_test',
          'local.txt',
          12,
          'text/plain',
          'utf-8',
          'mixed',
          'hash_hint',
          'novel_local_1',
          3,
          undefined,
          'replace_book',
          undefined,
          null,
        ]);
        return { rows: [] };
      }),
    } as unknown as pg.Pool;
    const queue = { add: vi.fn() } as unknown as Queue;
    const app = await appWithUploads(pool, queue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/uploads/init',
      payload: {
        fileName: 'local.txt',
        sizeBytes: 12,
        contentType: 'text/plain',
        encoding: 'utf-8',
        chapterSplitMode: 'mixed',
        clientHashHint: 'hash_hint',
        clientBookId: 'novel_local_1',
        totalChunks: 3,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().uploadId).toMatch(/^upload_/);

    await app.close();
  });

  it('stores an image-series append upload with its optimistic base revision', async () => {
    const sourceContentHash = `sha256:${'a'.repeat(64)}`;
    const pool = {
      query: vi.fn(async (_sql: string, params?: unknown[]) => {
        expect(params).toEqual([
          expect.stringMatching(/^upload_/),
          'user_test',
          '새 회차.cbz',
          321,
          'application/vnd.comicbook+zip',
          'auto',
          'auto',
          undefined,
          'book_series_1',
          1,
          sourceContentHash,
          'append_image_series',
          'content_revision_7',
          null,
        ]);
        return { rows: [] };
      }),
    } as unknown as pg.Pool;
    const app = await appWithUploads(pool, { add: vi.fn() } as unknown as Queue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/uploads/init',
      payload: {
        fileName: '새 회차.cbz',
        sizeBytes: 321,
        contentType: 'application/vnd.comicbook+zip',
        clientBookId: 'book_series_1',
        sourceContentHash,
        importMode: 'append_image_series',
        baseActiveContentRevisionId: 'content_revision_7',
        totalChunks: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().uploadId).toMatch(/^upload_/);
    await app.close();
  });

  it('rejects an image-series append without a target book and verified delta hash', async () => {
    const pool = { query: vi.fn() } as unknown as pg.Pool;
    const app = await appWithUploads(pool, { add: vi.fn() } as unknown as Queue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/uploads/init',
      payload: {
        fileName: '새 회차.cbz',
        sizeBytes: 321,
        importMode: 'append_image_series',
        totalChunks: 1,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('clientBookId and sourceContentHash');
    expect(pool.query).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an otherwise valid image-series append without its optimistic base revision', async () => {
    const pool = { query: vi.fn() } as unknown as pg.Pool;
    const app = await appWithUploads(pool, { add: vi.fn() } as unknown as Queue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/uploads/init',
      payload: {
        fileName: '새 회차.cbz',
        sizeBytes: 321,
        contentType: 'application/vnd.comicbook+zip',
        clientBookId: 'book_series_1',
        sourceContentHash: `sha256:${'a'.repeat(64)}`,
        importMode: 'append_image_series',
        totalChunks: 1,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('baseActiveContentRevisionId');
    expect(pool.query).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects unsupported chapter split modes during upload initialization', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('database should not be touched for invalid chapterSplitMode');
      }),
    } as unknown as pg.Pool;
    const queue = { add: vi.fn() } as unknown as Queue;
    const app = await appWithUploads(pool, queue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/uploads/init',
      payload: {
        fileName: 'local.txt',
        sizeBytes: 12,
        chapterSplitMode: 'aggressive',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'chapterSplitMode must be auto, mixed, or single when provided' });
    expect(pool.query).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects unsafe client book ids during upload initialization', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('database should not be touched for invalid clientBookId');
      }),
    } as unknown as pg.Pool;
    const queue = { add: vi.fn() } as unknown as Queue;
    const app = await appWithUploads(pool, queue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/uploads/init',
      payload: {
        fileName: 'local.txt',
        sizeBytes: 12,
        clientBookId: '../bad',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'clientBookId must be a safe identifier when provided' });
    expect(pool.query).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects upload chunk plans that cannot fit the declared bytes', async () => {
    const pool = { query: vi.fn() } as unknown as pg.Pool;
    const app = await appWithUploads(pool, { add: vi.fn() } as unknown as Queue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/uploads/init',
      payload: { fileName: 'bad.txt', sizeBytes: 12, totalChunks: 13 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('cannot exceed sizeBytes');
    expect(pool.query).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a replacement chunk when cumulative accepted bytes exceed the declared size', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'rollback') return { rows: [] };
        if (sql.includes('from upload_sessions') && sql.includes('for update')) {
          return { rows: [{ id: 'upload_1', size_bytes: '10', status: 'uploading', total_chunks: 2 }] };
        }
        if (sql.includes('accepted_bytes')) return { rows: [{ accepted_bytes: '4' }] };
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await appWithUploads(pool, { add: vi.fn() } as unknown as Queue);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/uploads/upload_1/chunks/1',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(8),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ sizeBytes: 10, acceptedBytes: 12 });
    expect(client.query).toHaveBeenCalledWith('rollback');
    await app.close();
  });

  it('enqueues completed uploads with an attempt-specific BullMQ job id', async () => {
    const committedImportJobIds: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
        if (sql.includes('from upload_sessions') && sql.includes('for update')) {
          return { rows: [{ id: 'upload_1', size_bytes: '12', status: 'uploading', total_chunks: 3 }] };
        }
        if (sql.includes('from upload_chunks')) {
          return {
            rows: [
              { chunk_index: 0, size_bytes: 4 },
              { chunk_index: 1, size_bytes: 4 },
              { chunk_index: 2, size_bytes: 4 },
            ],
          };
        }
        if (sql.includes('update upload_sessions set status')) return { rows: [] };
        if (sql.includes('insert into import_jobs')) {
          committedImportJobIds.push(String(params?.[0]));
          return { rows: [] };
        }
        throw new Error(`unexpected client query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('select active_queue_job_id')) return { rows: [{ active_queue_job_id: null }] };
        if (sql.startsWith('update import_jobs')) return { rows: [{ id: committedImportJobIds[0] }], rowCount: 1 };
        throw new Error(`unexpected pool query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const app = await appWithUploads(pool, queue);

    const response = await app.inject({ method: 'POST', url: '/api/uploads/upload_1/complete' });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.jobId).toMatch(/^job_/);
    expect(committedImportJobIds).toEqual([body.jobId]);
    expect(queue.add).toHaveBeenCalledWith(
      'import-upload',
      { jobId: body.jobId, uploadId: 'upload_1' },
      { jobId: expect.stringMatching(/^import_attempt_/) },
    );
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('returns the existing import job when upload completion is retried', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'commit') return { rows: [] };
        if (sql.includes('from upload_sessions')) {
          return { rows: [{ id: 'upload_1', size_bytes: '12', status: 'queued', total_chunks: 3 }] };
        }
        if (sql.includes('from import_jobs')) return { rows: [{ id: 'job_existing', status: 'queued' }] };
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [{ active_queue_job_id: 'import_attempt_existing' }] })),
    } as unknown as pg.Pool;
    const queue = {
      getJob: vi.fn(async () => ({ getState: vi.fn(async () => 'waiting') })),
      add: vi.fn(),
    } as unknown as Queue;
    const app = await appWithUploads(pool, queue);

    const response = await app.inject({ method: 'POST', url: '/api/uploads/upload_1/complete' });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ jobId: 'job_existing', idempotent: true });
    expect(queue.add).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects completion when assembled bytes do not match sourceContentHash', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'moya-upload-hash-'));
    const chunkPath = path.join(tempDir, '00000000.part');
    const bytes = Buffer.from('hello');
    await writeFile(chunkPath, bytes);
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'rollback') return { rows: [] };
        if (sql.includes('from upload_sessions')) {
          return {
            rows: [
              {
                id: 'upload_hash',
                size_bytes: String(bytes.length),
                status: 'uploading',
                total_chunks: 1,
                source_content_hash: `sha256:${'0'.repeat(64)}`,
              },
            ],
          };
        }
        if (sql.includes('from upload_chunks')) {
          return { rows: [{ chunk_index: 0, size_bytes: bytes.length, storage_path: chunkPath }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const queue = { add: vi.fn() } as unknown as Queue;
    const app = await appWithUploads(pool, queue);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/uploads/upload_hash/complete' });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'source_content_hash_mismatch' });
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('cancels uploading sessions and clears accepted chunks before import is queued', async () => {
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
        if (sql.includes('from upload_sessions') && sql.includes('for update')) {
          expect(params).toEqual(['upload_1']);
          return {
            rows: [
              {
                id: 'upload_1',
                file_name: 'novel.txt',
                size_bytes: '12',
                content_type: 'text/plain',
                encoding: 'utf-8',
                status: 'uploading',
                total_chunks: 3,
                created_at: '2026-07-05T00:00:00.000Z',
                updated_at: '2026-07-05T00:00:01.000Z',
              },
            ],
          };
        }
        if (sql.startsWith('delete from upload_chunks')) {
          expect(params).toEqual(['upload_1']);
          return { rows: [] };
        }
        if (sql.startsWith('update import_jobs')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('update upload_sessions set status')) {
          expect(params).toEqual(['cancelled', 'upload_1']);
          return { rows: [] };
        }
        if (sql.includes('from upload_sessions')) {
          return {
            rows: [
              {
                id: 'upload_1',
                file_name: 'novel.txt',
                size_bytes: '12',
                content_type: 'text/plain',
                encoding: 'utf-8',
                status: 'cancelled',
                total_chunks: 3,
                created_at: '2026-07-05T00:00:00.000Z',
                updated_at: '2026-07-05T00:00:02.000Z',
              },
            ],
          };
        }
        if (sql.includes('from upload_chunks')) return { rows: [] };
        if (sql.includes('from import_jobs')) return { rows: [] };
        throw new Error(`unexpected client query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const queue = { add: vi.fn() } as unknown as Queue;
    const app = await appWithUploads(pool, queue);

    const response = await app.inject({ method: 'DELETE', url: '/api/uploads/upload_1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      upload: {
        uploadId: 'upload_1',
        status: 'cancelled',
        uploadedBytes: 0,
        receivedChunkIndexes: [],
        missingChunkIndexes: [0, 1, 2],
        complete: false,
      },
    });
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();

    await app.close();
  });

  it('cancels uploads that are already queued for import', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
        if (sql.includes('from upload_sessions') && sql.includes('for update')) {
          return {
            rows: [
              {
                id: 'upload_1',
                size_bytes: '12',
                status: 'queued',
                total_chunks: 3,
              },
            ],
          };
        }
        if (sql.includes('select status from import_jobs')) return { rows: [{ status: 'queued' }] };
        if (sql.startsWith('update import_jobs')) return { rows: [], rowCount: 1 };
        if (sql.startsWith('update upload_sessions set status')) return { rows: [] };
        if (sql.startsWith('delete from upload_chunks')) return { rows: [] };
        if (sql.includes('from upload_sessions'))
          return { rows: [{ id: 'upload_1', size_bytes: '12', status: 'cancelled', total_chunks: 3 }] };
        if (sql.includes('from upload_chunks') || sql.includes('from import_jobs')) return { rows: [] };
        throw new Error(`unexpected client query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const queue = { add: vi.fn() } as unknown as Queue;
    const app = await appWithUploads(pool, queue);

    const response = await app.inject({ method: 'DELETE', url: '/api/uploads/upload_1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, cancellationState: 'cancelled' });
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('requests cancellation without deleting chunks underneath a processing worker', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
        if (sql.includes('from upload_sessions') && sql.includes('for update')) {
          return { rows: [{ id: 'upload_1', size_bytes: '12', status: 'queued', total_chunks: 1 }] };
        }
        if (sql.includes('select status from import_jobs')) return { rows: [{ status: 'processing' }] };
        if (sql.startsWith('update import_jobs')) return { rows: [], rowCount: 1 };
        if (sql.startsWith('update upload_sessions set status')) return { rows: [] };
        if (sql.includes('from upload_sessions')) {
          return { rows: [{ id: 'upload_1', size_bytes: '12', status: 'cancelled', total_chunks: 1 }] };
        }
        if (sql.includes('from upload_chunks')) return { rows: [{ chunk_index: 0, size_bytes: 12 }] };
        if (sql.includes('from import_jobs')) {
          return { rows: [{ id: 'job_1', status: 'cancelled', stage: 'cancelled', cancel_requested_at: new Date() }] };
        }
        throw new Error(`unexpected client query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await appWithUploads(pool, { add: vi.fn() } as unknown as Queue);

    const response = await app.inject({ method: 'DELETE', url: '/api/uploads/upload_1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, cancellationState: 'requested' });
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('delete from upload_chunks'))).toBe(false);
    await app.close();
  });

  it('prunes stale uploading sessions for the configured user', async () => {
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
        if (sql.includes('update upload_sessions')) {
          expect(params?.[0]).toBe('expired');
          expect(params?.[1]).toEqual(['uploading', 'failed', 'imported', 'cancelled']);
          expect(typeof params?.[2]).toBe('string');
          expect(params?.[3]).toBe('user_test');
          return { rows: [{ id: 'upload_old' }], rowCount: 1 };
        }
        if (sql.includes('delete from upload_chunks')) {
          expect(params).toEqual([['upload_old']]);
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected client query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const queue = { add: vi.fn() } as unknown as Queue;
    const app = await appWithUploads(pool, queue);

    const response = await app.inject({ method: 'POST', url: '/api/uploads/prune' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      prunedCount: 1,
      uploadIds: ['upload_old'],
      disabled: false,
    });
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
