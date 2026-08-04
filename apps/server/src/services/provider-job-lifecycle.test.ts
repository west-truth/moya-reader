import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { bookAnalysisStatusForSucceededAIProviderJob, processProviderJob } from './provider-job-service.js';
import { testConfig } from './provider-jobs/provider-job-test-harness.js';

describe('provider job lifecycle', () => {
  it('does not mark workflow child jobs as book-ready before workflow readiness passes', () => {
    expect(
      bookAnalysisStatusForSucceededAIProviderJob({
        provider_id: 'gemini-vertex',
        job_type: 'character_graph_merge',
        progress: {
          sourceContext: {
            workflowId: 'workflow_1',
            workflowStage: 'merging_graph',
          },
        },
      }),
    ).toBe('building_graph');
    expect(
      bookAnalysisStatusForSucceededAIProviderJob({
        provider_id: 'gemini-vertex',
        job_type: 'chapter_segment_labeling',
        progress: {
          sourceContext: {
            workflowId: 'workflow_1',
            workflowStage: 'labeling_chapters',
            paragraphIds: ['p1', 'p2'],
          },
        },
      }),
    ).toBe('labeling_segments');
  });

  it('preserves direct provider job book status semantics outside book workflows', () => {
    expect(
      bookAnalysisStatusForSucceededAIProviderJob({
        provider_id: 'mock',
        job_type: 'chapter_segment_labeling',
        progress: {},
      }),
    ).toBe('mock_ready');
    expect(
      bookAnalysisStatusForSucceededAIProviderJob({
        provider_id: 'gemini-vertex',
        job_type: 'character_graph_merge',
        progress: {},
      }),
    ).toBe('ready');
    expect(
      bookAnalysisStatusForSucceededAIProviderJob({
        provider_id: 'gemini-vertex',
        job_type: 'character_bundle_analysis',
        progress: {},
      }),
    ).toBe('needs_review');
  });

  it('does not execute provider work when another worker already claimed the job', async () => {
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_claimed_elsewhere',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash',
      status: 'running',
      stage: 'loading_chapter',
      progress: {},
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.trim().startsWith('update provider_jobs') && sql.includes("status = 'queued'")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('select id, user_id, book_id, chapter_id')) {
          return { rows: [jobRow] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const createAIProvider = vi.fn();

    await processProviderJob(pool, testConfig(), 'provider_job_claimed_elsewhere', { createAIProvider });

    expect(createAIProvider).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('stops before provider calls when a job is cancelled after the worker starts', async () => {
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_cancelled',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'tts_synthesis',
      provider_id: 'openai-tts',
      model_id: 'gpt-4o-mini-tts',
      input_hash: 'input_hash',
      status: 'queued',
      stage: 'queued',
      progress: {},
    };
    const updates: unknown[][] = [];
    let claimed = false;
    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) {
        return { rows: [{ ...jobRow, status: claimed ? 'cancelled' : jobRow.status }] };
      }
      if (sql.trim() === 'begin' || sql.trim() === 'commit' || sql.trim() === 'rollback') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.trim().startsWith('update provider_jobs')) {
        if (sql.includes("and status = 'queued'")) {
          claimed = true;
          jobRow.status = 'running';
          jobRow.stage = 'loading_tts_input';
          return { rowCount: 1, rows: [{ ...jobRow, progress: { loaded: false } }] };
        }
        const values = params ?? [];
        updates.push(values);
        if (values.includes('cancelled')) {
          jobRow.status = 'cancelled';
          jobRow.stage = 'cancelled';
        }
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = {
      query: handleQuery,
      release: vi.fn(),
    };
    const pool = {
      query: handleQuery,
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const createTTSProvider = vi.fn();

    await processProviderJob(pool, testConfig(), 'provider_job_cancelled', { createTTSProvider });

    expect(createTTSProvider).not.toHaveBeenCalled();
    expect(jobRow.status).toBe('cancelled');
    expect(updates.some((values) => values.includes('cancelled'))).toBe(true);
  });

  it('does not mark a book failed when provider errors after cancellation is recorded', async () => {
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_cancelled_error',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: null,
      job_type: 'character_graph_merge',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash',
      status: 'queued',
      stage: 'queued',
      progress: {
        discoveredGraph: {
          novelId: 'book_1',
          characters: [],
          relations: [],
        },
      },
    };
    const books = new Map([['book_1', { analysis_status: 'queued' }]]);
    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) {
        return { rows: [jobRow] };
      }
      if (sql.trim() === 'begin' || sql.trim() === 'commit' || sql.trim() === 'rollback') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.trim().startsWith('update provider_jobs')) {
        const values = params ?? [];
        if (values.includes('running')) jobRow.status = 'running';
        if (values.includes('cancelled')) jobRow.status = 'cancelled';
        if (values.includes('failed')) jobRow.status = 'failed';
        const stage = values.find((value) =>
          ['loading_graph', 'merging_graph', 'cancelled', 'failed'].includes(String(value)),
        );
        if (stage) jobRow.stage = stage;
        return { rowCount: 1, rows: [] };
      }
      if (
        sql.includes('from characters') ||
        sql.includes('from character_relations') ||
        sql.includes('from user_corrections')
      ) {
        return { rows: [] };
      }
      if (sql.includes('update library_books set analysis_status')) {
        books.set(String(params?.[1]), { analysis_status: String(params?.[0]) });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = {
      query: handleQuery,
      connect: vi.fn(async () => {
        throw new Error('persistence transaction should not start');
      }),
    } as unknown as pg.Pool;

    await processProviderJob(pool, testConfig(), 'provider_job_cancelled_error', {
      createAIProvider: () => ({
        providerId: 'mock',
        displayName: 'Cancelling graph provider',
        labelChapterSegments: vi.fn(),
        mergeCharacterGraph: vi.fn(async () => {
          jobRow.status = 'cancelled';
          throw new Error('provider request aborted remotely');
        }),
      }),
    });

    expect(jobRow.status).toBe('cancelled');
    expect(jobRow.stage).toBe('cancelled');
    expect(books.get('book_1')).toEqual({ analysis_status: 'queued' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('aborts an active provider call when cancellation is detected by the worker monitor', async () => {
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_abort_signal',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: null,
      job_type: 'character_graph_merge',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash',
      status: 'queued',
      stage: 'queued',
      progress: {
        discoveredGraph: {
          novelId: 'book_1',
          characters: [],
          relations: [],
        },
      },
    };
    let providerSignal: AbortSignal | undefined;
    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) {
        return { rows: [jobRow] };
      }
      if (sql.trim().startsWith('update provider_jobs')) {
        const values = params ?? [];
        if (values.includes('running')) jobRow.status = 'running';
        if (values.includes('cancelled')) jobRow.status = 'cancelled';
        const stage = values.find((value) => ['loading_graph', 'merging_graph', 'cancelled'].includes(String(value)));
        if (stage) jobRow.stage = stage;
        return { rowCount: 1, rows: [] };
      }
      if (
        sql.includes('from characters') ||
        sql.includes('from character_relations') ||
        sql.includes('from user_corrections')
      ) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = {
      query: handleQuery,
      connect: vi.fn(async () => {
        throw new Error('persistence transaction should not start');
      }),
    } as unknown as pg.Pool;

    await processProviderJob(pool, testConfig(), 'provider_job_abort_signal', {
      cancellationPollMs: 1,
      createAIProvider: () => ({
        providerId: 'mock',
        displayName: 'Abortable graph provider',
        labelChapterSegments: vi.fn(),
        mergeCharacterGraph: vi.fn(async (input) => {
          providerSignal = input.signal;
          setTimeout(() => {
            jobRow.status = 'cancelled';
            jobRow.stage = 'cancelled';
          }, 0);
          await new Promise((_resolve, reject) => {
            input.signal?.addEventListener('abort', () => reject(new Error('provider request aborted by signal')), {
              once: true,
            });
          });
          throw new Error('unreachable provider result');
        }),
      }),
    });

    expect(providerSignal?.aborted).toBe(true);
    expect(jobRow.status).toBe('cancelled');
    expect(jobRow.stage).toBe('cancelled');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
