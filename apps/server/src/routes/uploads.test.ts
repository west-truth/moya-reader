import Fastify from 'fastify';
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
  return registerUploadRoutes(app, pool, testConfig(), queue).then(() => app);
}

describe('upload routes', () => {
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
        expect(sql).toContain('from import_jobs');
        expect(params).toEqual(['job_1']);
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
      { jobId: 'job_1' },
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

  it('enqueues completed uploads with the database import job id as the BullMQ job id', async () => {
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
      { jobId: body.jobId },
    );
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledTimes(1);

    await app.close();
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

  it('does not cancel uploads that are already queued for import', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'begin' || sql === 'rollback') return { rows: [] };
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

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'upload session is queued' });
    expect(client.query).toHaveBeenCalledWith('rollback');
    expect(client.release).toHaveBeenCalledTimes(1);

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
