import { describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import pg from 'pg';
import { DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS } from './config.js';
import {
  enqueueImportJob,
  enqueueProviderJob,
  importQueueAttempt,
  recoverStaleImportJobs,
  requeuePendingImportJobs,
  requeuePendingProviderJobs,
} from './queue.js';

describe('import queue helpers', () => {
  it('exposes BullMQ retry metadata without marking intermediate attempts terminal', () => {
    expect(importQueueAttempt({ attemptsMade: 0, opts: { attempts: 3 } })).toEqual({
      attemptNumber: 1,
      maxAttempts: 3,
      finalAttempt: false,
    });
    expect(importQueueAttempt({ attemptsMade: 2, opts: { attempts: 3 } })).toEqual({
      attemptNumber: 3,
      maxAttempts: 3,
      finalAttempt: true,
    });
  });

  it('uses an attempt-specific BullMQ id and persists its execution fence', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('select active_queue_job_id')) return { rows: [{ active_queue_job_id: null }] };
        return { rowCount: 1, rows: [{ id: 'job_1' }] };
      }),
    } as unknown as pg.Pool;
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;

    await expect(enqueueImportJob(pool, queue, 'job_1', 'upload_1')).resolves.toMatch(/^import_attempt_/);

    expect(queue.add).toHaveBeenCalledWith(
      'import-upload',
      { jobId: 'job_1', uploadId: 'upload_1' },
      { jobId: expect.stringMatching(/^import_attempt_[a-f0-9]{32}$/) },
    );
  });

  it('supersedes a retained terminal BullMQ delivery with a new fenced attempt id', async () => {
    const updates: unknown[][] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('select active_queue_job_id')) {
          return { rows: [{ active_queue_job_id: 'import_attempt_retained' }] };
        }
        if (sql.includes('set active_queue_job_id = null')) return { rows: [], rowCount: 1 };
        if (sql.includes('queue_generation = queue_generation + 1')) {
          updates.push(params ?? []);
          return { rows: [{ id: 'job_1' }], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const queue = {
      getJob: vi.fn(async () => ({ getState: vi.fn(async () => 'completed') })),
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;

    const published = await enqueueImportJob(pool, queue, 'job_1', 'upload_1');

    expect(published).toMatch(/^import_attempt_/);
    expect(published).not.toBe('import_attempt_retained');
    expect(updates[0]?.[2]).toBe(published);
  });

  it('requeues queued database import jobs on worker startup', async () => {
    const pool = {
      query: vi.fn(async () => ({
        rowCount: 2,
        rows: [
          { id: 'job_1', upload_id: 'upload_1' },
          { id: 'job_2', upload_id: 'upload_2' },
        ],
      })),
    } as unknown as pg.Pool;
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;

    await expect(requeuePendingImportJobs(pool, queue)).resolves.toBe(2);

    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      'import-upload',
      { jobId: 'job_1', uploadId: 'upload_1' },
      { jobId: expect.stringMatching(/^import_attempt_/) },
    );
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      'import-upload',
      { jobId: 'job_2', uploadId: 'upload_2' },
      { jobId: expect.stringMatching(/^import_attempt_/) },
    );
  });

  it('returns stale processing imports to the durable queue', async () => {
    const pool = {
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [{ id: 'job_stale', upload_id: 'upload_stale' }],
      })),
    } as unknown as pg.Pool;
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;

    await expect(recoverStaleImportJobs(pool, queue, 300_000)).resolves.toBe(1);

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("job.status = 'processing'"), [300_000]);
    expect(queue.add).toHaveBeenCalledWith(
      'import-upload',
      { jobId: 'job_stale', uploadId: 'upload_stale' },
      { jobId: expect.stringMatching(/^import_attempt_/) },
    );
  });

  it('can disable stale import recovery with an explicit zero', async () => {
    const pool = { query: vi.fn() } as unknown as pg.Pool;
    const queue = { add: vi.fn() } as unknown as Queue;

    await expect(recoverStaleImportJobs(pool, queue, 0)).resolves.toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('provider queue helpers', () => {
  it('persists an attempt and outbox before publishing an attempt-specific BullMQ job', async () => {
    const events: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        events.push(sql.includes('with target as materialized') ? 'prepare' : 'persist');
        if (sql.includes('with target as materialized')) {
          return { rows: [{ attempt_id: params?.[1], bullmq_job_id: params?.[2] }] };
        }
        return { rows: [] };
      }),
    } as unknown as pg.Pool;
    const add = vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => {
      events.push('publish');
      return { id: options?.jobId };
    });
    const queue = { add } as unknown as Queue;

    const bullmqJobId = await enqueueProviderJob(pool, queue, 'provider_job_1', DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS);

    expect(bullmqJobId).toMatch(/^provider_attempt_[a-f0-9]{32}$/);
    expect(add).toHaveBeenCalledWith(
      'provider-job',
      { jobId: 'provider_job_1', attemptId: bullmqJobId },
      { jobId: bullmqJobId },
    );
    expect(events.indexOf('publish')).toBeGreaterThan(events.indexOf('prepare'));
  });

  it.each(['completed', 'failed'] as const)(
    'uses a new attempt-specific BullMQ id when the previous %s job is retained',
    async (retainedState) => {
      const retainedJobs = new Map<string, { id: string; data: unknown; state: string }>();
      const pool = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('with target as materialized')) {
            return { rows: [{ attempt_id: params?.[1], bullmq_job_id: params?.[2] }] };
          }
          return { rows: [] };
        }),
      } as unknown as pg.Pool;
      const add = vi.fn(async (_name: string, data: unknown, options?: { jobId?: string }) => {
        const bullmqJobId = String(options?.jobId);
        const retained = retainedJobs.get(bullmqJobId);
        if (retained) return retained;
        const job = { id: bullmqJobId, data, state: 'waiting' };
        retainedJobs.set(bullmqJobId, job);
        return job;
      });
      const queue = { add } as unknown as Queue;

      const firstAttemptId = await enqueueProviderJob(
        pool,
        queue,
        `provider_job_retained_${retainedState}`,
        DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS,
      );
      const retained = retainedJobs.get(String(firstAttemptId));
      if (retained) retained.state = retainedState;
      const retryAttemptId = await enqueueProviderJob(
        pool,
        queue,
        `provider_job_retained_${retainedState}`,
        DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS,
      );

      expect(firstAttemptId).toMatch(/^provider_attempt_[a-f0-9]{32}$/);
      expect(retryAttemptId).toMatch(/^provider_attempt_[a-f0-9]{32}$/);
      expect(retryAttemptId).not.toBe(firstAttemptId);
      expect(retainedJobs.size).toBe(2);
    },
  );

  it('requeues queued database provider jobs on worker startup', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('select j.id') && sql.includes('left join provider_job_attempts')) {
          return {
            rowCount: 2,
            rows: [
              { id: 'provider_job_1', current_attempt_id: null },
              { id: 'provider_job_2', current_attempt_id: null },
            ],
          };
        }
        if (sql.includes('with target as materialized')) {
          return { rows: [{ attempt_id: params?.[1], bullmq_job_id: params?.[2] }] };
        }
        return { rows: [] };
      }),
    } as unknown as pg.Pool;
    const add = vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId }));
    const queue = { add } as unknown as Queue;

    await expect(requeuePendingProviderJobs(pool, queue, DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS, 0)).resolves.toBe(2);

    expect(add).toHaveBeenCalledTimes(2);
    for (const [index, logicalJobId] of ['provider_job_1', 'provider_job_2'].entries()) {
      const [, data, options] = add.mock.calls[index];
      expect(data).toMatchObject({ jobId: logicalJobId, attemptId: options?.jobId });
      expect(options?.jobId).toMatch(/^provider_attempt_[a-f0-9]{32}$/);
    }
  });

  it('recovers stale running provider jobs before requeueing startup work', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('select j.id') && sql.includes('left join provider_job_attempts')) {
          return { rowCount: 1, rows: [{ id: 'provider_job_recovered', current_attempt_id: null }] };
        }
        if (sql.includes('with target as materialized')) {
          return { rows: [{ attempt_id: params?.[1], bullmq_job_id: params?.[2] }] };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as unknown as pg.Pool;
    const add = vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId }));
    const queue = { add } as unknown as Queue;

    await expect(requeuePendingProviderJobs(pool, queue, DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS, 60000)).resolves.toBe(
      1,
    );

    expect(queries[0].sql).toContain("attempt.status = 'running'");
    expect(queries[0].sql).toContain("outcome_state = 'outcome_unknown'");
    expect(queries[0].sql).toContain('automatic retry is blocked');
    expect(queries[0].params).toEqual([60000]);
    expect(add).toHaveBeenCalledWith(
      'provider-job',
      expect.objectContaining({ jobId: 'provider_job_recovered' }),
      expect.objectContaining({ jobId: expect.stringMatching(/^provider_attempt_/) }),
    );
  });

  it('publishes a pending provider attempt outbox row during startup reconciliation', async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('select j.id') && sql.includes('left join provider_job_attempts')) {
          return {
            rowCount: 1,
            rows: [
              {
                id: 'provider_job_pending',
                current_attempt_id: 'provider_attempt_pending',
                attempt_id: 'provider_attempt_pending',
                attempt_status: 'queued',
                bullmq_job_id: 'provider_attempt_pending',
                outbox_status: 'pending',
              },
            ],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as unknown as pg.Pool;
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;

    await expect(requeuePendingProviderJobs(pool, queue, DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS, 0)).resolves.toBe(1);

    expect(queue.add).toHaveBeenCalledWith(
      'provider-job',
      { jobId: 'provider_job_pending', attemptId: 'provider_attempt_pending' },
      { jobId: 'provider_attempt_pending' },
    );
    expect(queries.some((sql) => sql.includes("set status = 'published'"))).toBe(true);
  });
});
