import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { processProviderJob } from './provider-job-service.js';
import { testConfig } from './provider-jobs/provider-job-test-harness.js';

interface MutableProviderJob {
  id: string;
  user_id: string;
  book_id: string;
  chapter_id: string | null;
  job_type: string;
  provider_id: string;
  model_id: string | null;
  input_hash: string;
  status: string;
  stage: string;
  progress: Record<string, unknown>;
  current_attempt_id: string | null;
  attempt_count: number;
}

interface MutableProviderAttempt {
  attempt_number: number;
  provider_job_id: string;
  bullmq_job_id: string;
  status: string;
  stage: string;
  progress: Record<string, unknown>;
  attempt_generation?: number;
  lease_owner?: string;
  lease_token_hash?: string;
  outcome_state?: string;
}

describe('provider job attempt ownership', () => {
  it('does not let a cancelled old worker overwrite a running retry attempt', async () => {
    const oldAttemptId = 'provider_attempt_old';
    const newAttemptId = 'provider_attempt_new';
    const logicalJob: MutableProviderJob = {
      id: 'provider_job_retry_race',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: null,
      job_type: 'character_graph_merge',
      provider_id: 'mock',
      model_id: 'mock-model',
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
      current_attempt_id: oldAttemptId,
      attempt_count: 1,
    };
    const attempts = new Map<string, MutableProviderAttempt>([
      [
        oldAttemptId,
        {
          attempt_number: 1,
          provider_job_id: 'provider_job_retry_race',
          bullmq_job_id: oldAttemptId,
          status: 'queued',
          stage: 'queued',
          progress: {},
        },
      ],
    ]);
    const libraryStatusUpdates: string[] = [];
    const logicalAttemptUpdates: boolean[] = [];

    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const values = params ?? [];
      const normalized = sql.trim();
      if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('from provider_jobs') && sql.includes('for update')) {
        return { rowCount: 1, rows: [{ ...logicalJob }] };
      }
      if (sql.includes('from provider_job_attempts') && sql.includes('where id = $1')) {
        const attempt = attempts.get(String(values[0]));
        return { rowCount: attempt ? 1 : 0, rows: attempt ? [{ ...attempt }] : [] };
      }
      if (normalized.startsWith('insert into provider_job_attempts')) {
        attempts.set(String(values[0]), {
          attempt_number: Number(values[2]),
          provider_job_id: String(values[1]),
          bullmq_job_id: String(values[3]),
          status: 'queued',
          stage: 'queued',
          progress: JSON.parse(String(values[4])),
        });
        return { rowCount: 1, rows: [] };
      }
      if (normalized.startsWith('update provider_jobs') && sql.includes('current_attempt_id = $3')) {
        logicalJob.status = 'running';
        logicalJob.stage = 'loading_graph';
        logicalJob.current_attempt_id = String(values[2]);
        logicalJob.attempt_count = Number(values[3]);
        logicalJob.progress = { ...logicalJob.progress, loaded: false };
        return { rowCount: 1, rows: [{ ...logicalJob }] };
      }
      if (normalized.startsWith('update provider_job_attempts') && sql.includes("set status = 'running'")) {
        const attempt = attempts.get(String(values[0]));
        if (attempt) {
          attempt.status = 'running';
          attempt.stage = String(values[1]);
          attempt.progress = JSON.parse(String(values[2]));
          attempt.attempt_generation = Number(values[4]);
          attempt.lease_owner = String(values[5]);
          attempt.lease_token_hash = String(values[6]);
          attempt.outcome_state = 'claimed';
        }
        return {
          rowCount: attempt ? 1 : 0,
          rows: attempt ? [{ attempt_generation: attempt.attempt_generation }] : [],
        };
      }
      if (normalized.startsWith('insert into provider_job_outbox')) {
        return { rowCount: 1, rows: [] };
      }
      if (normalized.startsWith('with updated_job as')) {
        const targetJobId = logicalJob.id;
        const targetAttemptId = oldAttemptId;
        const nextStatus = values.find((value) => ['succeeded', 'failed', 'cancelled'].includes(String(value)));
        const nextStage = values.find((value) =>
          ['merging_graph', 'writing_results', 'ready', 'failed', 'cancelled'].includes(String(value)),
        );
        const applied =
          logicalJob.id === targetJobId &&
          logicalJob.status === 'running' &&
          logicalJob.current_attempt_id === targetAttemptId;
        logicalAttemptUpdates.push(applied);
        if (applied) {
          if (nextStatus) logicalJob.status = String(nextStatus);
          if (nextStage) logicalJob.stage = String(nextStage);
        }
        const attempt = attempts.get(targetAttemptId);
        if (applied && attempt && (attempt.status === 'queued' || attempt.status === 'running')) {
          if (nextStatus) attempt.status = String(nextStatus);
          if (nextStage) attempt.stage = String(nextStage);
        }
        return { rowCount: 1, rows: [{ applied }] };
      }
      if (normalized.startsWith('update provider_job_attempts') && sql.includes("outcome_state = 'quarantined'")) {
        const attempt = attempts.get(String(values[0]));
        if (attempt) attempt.outcome_state = 'quarantined';
        return { rowCount: attempt ? 1 : 0, rows: [] };
      }
      if (
        normalized.startsWith('update provider_job_attempts attempt') &&
        sql.includes("outcome_state = 'in_flight'")
      ) {
        const attempt = attempts.get(String(values[0]));
        if (attempt) attempt.outcome_state = 'in_flight';
        return { rowCount: attempt ? 1 : 0, rows: [] };
      }
      if (sql.includes('from provider_jobs')) {
        return { rowCount: 1, rows: [{ ...logicalJob }] };
      }
      if (
        sql.includes('from characters') ||
        sql.includes('from character_relations') ||
        sql.includes('from user_corrections')
      ) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('update library_books set analysis_status')) {
        libraryStatusUpdates.push(String(values[0]));
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = { query, release: vi.fn() };
    const pool = {
      query,
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;
    const mergeCharacterGraph = vi.fn(async () => {
      logicalJob.status = 'running';
      logicalJob.stage = 'merging_graph';
      logicalJob.current_attempt_id = newAttemptId;
      logicalJob.attempt_count = 2;
      attempts.set(newAttemptId, {
        attempt_number: 2,
        provider_job_id: logicalJob.id,
        bullmq_job_id: newAttemptId,
        status: 'running',
        stage: 'merging_graph',
        progress: {},
      });
      throw new Error('old cancelled provider call completed late');
    });

    await processProviderJob(
      pool,
      testConfig(),
      logicalJob.id,
      {
        cancellationPollMs: 60_000,
        createAIProvider: () => ({
          providerId: 'mock',
          displayName: 'Retry race provider',
          labelChapterSegments: vi.fn(),
          mergeCharacterGraph,
        }),
      },
      { attemptId: oldAttemptId, bullmqJobId: oldAttemptId },
    );

    expect(mergeCharacterGraph).toHaveBeenCalledOnce();
    expect(logicalJob).toMatchObject({
      status: 'running',
      stage: 'merging_graph',
      current_attempt_id: newAttemptId,
      attempt_count: 2,
    });
    expect(attempts.get(oldAttemptId)).toMatchObject({
      status: 'running',
      attempt_generation: 1,
      outcome_state: 'quarantined',
    });
    expect(attempts.get(oldAttemptId)?.lease_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempts.get(newAttemptId)).toMatchObject({ status: 'running', stage: 'merging_graph' });
    expect(libraryStatusUpdates).toEqual([]);
    expect(logicalAttemptUpdates.at(-1)).toBe(false);
  });
});
