import { Queue, Worker } from 'bullmq';
import pg from 'pg';
import type { ProviderJobAdmissionLimits, ServerConfig } from './config.js';
import {
  ProviderJobAdmissionError,
  prepareAdmittedProviderAttempt,
  type ProviderQueueAttempt,
} from './services/provider-job-admission/index.js';

export type { ProviderQueueAttempt } from './services/provider-job-admission/index.js';

export const IMPORT_QUEUE_NAME = 'noveldesk-import';
export const PROVIDER_QUEUE_NAME = 'noveldesk-provider';

function redisConnectionOptions(config: ServerConfig) {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: Number.parseInt(url.port || '6379', 10),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname && url.pathname !== '/' ? Number.parseInt(url.pathname.slice(1), 10) : undefined,
    maxRetriesPerRequest: null,
  };
}

export function createImportQueue(config: ServerConfig): Queue {
  return new Queue(IMPORT_QUEUE_NAME, {
    connection: redisConnectionOptions(config),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });
}

export function enqueueImportJob(queue: Queue, jobId: string, uploadId: string): Promise<unknown> {
  return queue.add('import-upload', { jobId, uploadId }, { jobId }).then((job) => job.id);
}

interface ProviderQueueJobData {
  readonly jobId: string;
  readonly attemptId?: string;
}

export type ProviderWorkerAttempt = ProviderQueueAttempt;

export function createProviderQueue(config: ServerConfig): Queue {
  return new Queue(PROVIDER_QUEUE_NAME, {
    connection: redisConnectionOptions(config),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 200,
    },
  });
}

interface QueuedImportJobRow {
  id: string;
  upload_id: string;
}

export async function requeuePendingImportJobs(pool: pg.Pool, queue: Queue): Promise<number> {
  const result = await pool.query<QueuedImportJobRow>(
    `
      select j.id, j.upload_id
      from import_jobs j
      join upload_sessions u on u.id = j.upload_id
      where j.status = 'queued'
        and u.status = 'queued'
      order by j.created_at asc
    `,
  );
  for (const row of result.rows) {
    await enqueueImportJob(queue, row.id, row.upload_id);
  }
  return result.rowCount ?? result.rows.length;
}

function importRunningStaleMs(): number {
  const parsed = Number.parseInt(process.env.IMPORT_RUNNING_STALE_MS ?? `${5 * 60 * 1000}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function recoverStaleImportJobs(
  pool: pg.Pool,
  queue: Queue,
  staleRunningMs = importRunningStaleMs(),
): Promise<number> {
  const safeStaleMs = Number.isFinite(staleRunningMs) && staleRunningMs > 0 ? Math.floor(staleRunningMs) : 0;
  if (safeStaleMs === 0) return 0;
  const result = await pool.query<QueuedImportJobRow>(
    `
      update import_jobs job
      set status = 'queued',
          stage = 'queued',
          message = 'Interrupted import was returned to the queue.',
          error_message = null,
          updated_at = now()
      from upload_sessions upload
      where job.upload_id = upload.id
        and job.status = 'processing'
        and upload.status = 'queued'
        and job.updated_at < now() - ($1::bigint * interval '1 millisecond')
      returning job.id, job.upload_id
    `,
    [safeStaleMs],
  );
  for (const row of result.rows) {
    await enqueueImportJob(queue, row.id, row.upload_id);
  }
  return result.rowCount ?? result.rows.length;
}

interface QueuedProviderJobRow {
  id: string;
  current_attempt_id?: string | null;
  attempt_id?: string | null;
  attempt_status?: string | null;
  bullmq_job_id?: string | null;
  outbox_status?: string | null;
}

function providerRunningStaleMs(): number {
  const parsed = Number.parseInt(process.env.PROVIDER_RUNNING_STALE_MS ?? `${2 * 60 * 60 * 1000}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function recoverStaleRunningProviderJobs(pool: pg.Pool, staleRunningMs: number): Promise<void> {
  const legacyStaleMs = Number.isFinite(staleRunningMs) && staleRunningMs > 0 ? Math.floor(staleRunningMs) : 0;
  await pool.query(
    `
      update provider_job_attempts attempt
      set status = 'failed',
          stage = 'failed',
          outcome_state = 'outcome_unknown',
          billing_state = case
            when dispatch_started_at is null then 'billed_possible'
            else 'billed_possible'
          end,
          normalized_error_code = 'provider_attempt_lease_expired_after_dispatch',
          error_code = 'provider_attempt_outcome_unknown',
          error_message = 'Provider request outcome is unknown; automatic retry is blocked',
          reconcile_after = now(),
          lease_expires_at = null,
          finished_at = now(),
          updated_at = now()
      from provider_jobs job
      where job.current_attempt_id = attempt.id
        and job.status = 'running'
        and attempt.status = 'running'
        and attempt.outcome_state in ('dispatching', 'in_flight', 'reconciling', 'outcome_unknown')
        and (
          attempt.lease_expires_at <= now()
          or (
            $1::bigint > 0
            and attempt.lease_expires_at is null
            and attempt.updated_at < now() - ($1::bigint * interval '1 millisecond')
          )
        )
    `,
    [legacyStaleMs],
  );
  await pool.query(
    `
      update provider_jobs job
      set status = 'failed',
          stage = 'failed',
          progress = jsonb_set(
            coalesce(job.progress, '{}'::jsonb),
            '{providerOutcome}',
            jsonb_build_object(
              'state', 'outcome_unknown',
              'billingState', 'billed_possible',
              'errorCode', 'provider_attempt_outcome_unknown',
              'recoveredAt', now()
            ),
            true
          ),
          error_code = 'provider_attempt_outcome_unknown',
          error_message = 'Provider request outcome is unknown; automatic retry is blocked',
          finished_at = now(),
          updated_at = now()
      from provider_job_attempts attempt
      where job.current_attempt_id = attempt.id
        and job.status = 'running'
        and attempt.outcome_state = 'outcome_unknown'
        and attempt.error_code = 'provider_attempt_outcome_unknown'
    `,
  );
  await pool.query(
    `
      update provider_job_attempts attempt
      set status = 'failed',
          stage = 'failed',
          outcome_state = 'failed',
          billing_state = 'not_billable',
          normalized_error_code = 'provider_attempt_lease_expired_before_dispatch',
          error_code = 'provider_attempt_lease_expired_before_dispatch',
          error_message = 'Provider attempt lease expired before dispatch',
          reconcile_after = null,
          lease_expires_at = null,
          finished_at = now(),
          updated_at = now()
      from provider_jobs job
      where job.current_attempt_id = attempt.id
        and job.status = 'running'
        and attempt.status = 'running'
        and attempt.outcome_state in ('not_dispatched', 'claimed')
        and (
          attempt.lease_expires_at <= now()
          or (
            $1::bigint > 0
            and attempt.lease_expires_at is null
            and attempt.updated_at < now() - ($1::bigint * interval '1 millisecond')
          )
        )
    `,
    [legacyStaleMs],
  );
  await pool.query(
    `
      update provider_jobs job
      set status = 'failed',
          stage = 'failed',
          error_code = 'provider_attempt_lease_expired_before_dispatch',
          error_message = 'Provider attempt lease expired before dispatch',
          finished_at = now(),
          updated_at = now()
      from provider_job_attempts attempt
      where job.current_attempt_id = attempt.id
        and job.status = 'running'
        and attempt.normalized_error_code = 'provider_attempt_lease_expired_before_dispatch'
    `,
  );
  await pool.query(
    `
      update provider_jobs
      set status = 'queued',
          stage = 'queued',
          current_attempt_id = null,
          error_code = null,
          error_message = null,
          started_at = null,
          finished_at = null,
          updated_at = now()
      where status = 'failed'
        and error_code = 'provider_attempt_lease_expired_before_dispatch'
    `,
  );
}

async function reconcileTerminalProviderJobAttempts(pool: pg.Pool): Promise<void> {
  await pool.query(
    `
      update provider_job_attempts a
      set status = j.status,
          stage = j.stage,
          progress = j.progress,
          error_code = j.error_code,
          error_message = j.error_message,
          finished_at = coalesce(a.finished_at, j.finished_at, now()),
          updated_at = now()
      from provider_jobs j
      where j.current_attempt_id = a.id
        and j.status in ('succeeded', 'failed', 'cancelled')
        and a.status in ('queued', 'running')
    `,
  );
}

function providerAttemptOutboxId(attemptId: string): string {
  return `${attemptId}_outbox`;
}

async function ensureProviderAttemptOutbox(pool: pg.Pool, jobId: string, attempt: ProviderQueueAttempt): Promise<void> {
  await pool.query(
    `
      insert into provider_job_outbox (
        id, provider_job_id, attempt_id, bullmq_job_id, status, publish_attempts, created_at, updated_at
      )
      values ($1, $2, $3, $4, 'pending', 0, now(), now())
      on conflict (attempt_id) do nothing
    `,
    [providerAttemptOutboxId(attempt.attemptId), jobId, attempt.attemptId, attempt.bullmqJobId],
  );
}

async function publishProviderAttempt(
  pool: pg.Pool,
  queue: Queue,
  jobId: string,
  attempt: ProviderQueueAttempt,
): Promise<void> {
  try {
    await queue.add('provider-job', { jobId, attemptId: attempt.attemptId } satisfies ProviderQueueJobData, {
      jobId: attempt.bullmqJobId,
    });
    await pool.query(
      `
        update provider_job_outbox
        set status = 'published',
            publish_attempts = publish_attempts + 1,
            last_error = null,
            published_at = coalesce(published_at, now()),
            updated_at = now()
        where attempt_id = $1 and provider_job_id = $2
      `,
      [attempt.attemptId, jobId],
    );
  } catch (error) {
    await pool.query(
      `
        update provider_job_outbox
        set publish_attempts = publish_attempts + 1,
            last_error = 'Queue publish failed',
            updated_at = now()
        where attempt_id = $1 and provider_job_id = $2
      `,
      [attempt.attemptId, jobId],
    );
    throw error;
  }
}

export async function enqueueProviderJob(
  pool: pg.Pool,
  queue: Queue,
  jobId: string,
  limits: ProviderJobAdmissionLimits,
): Promise<unknown> {
  const attempt = await prepareAdmittedProviderAttempt(pool, jobId, limits);
  if (!attempt) return undefined;
  await ensureProviderAttemptOutbox(pool, jobId, attempt);
  await publishProviderAttempt(pool, queue, jobId, attempt);
  return attempt.bullmqJobId;
}

async function providerQueueJobState(queue: Queue, bullmqJobId: string): Promise<string | undefined> {
  if (typeof queue.getJob !== 'function') return undefined;
  const queuedJob = await queue.getJob(bullmqJobId);
  return queuedJob ? queuedJob.getState() : 'missing';
}

async function markRetainedProviderAttemptTerminal(
  pool: pg.Pool,
  attemptId: string,
  _queueState: 'completed' | 'failed',
): Promise<void> {
  await pool.query(
    `
      update provider_job_attempts
      set status = 'failed',
          stage = 'failed',
          outcome_state = 'failed',
          billing_state = 'not_billable',
          normalized_error_code = 'queue_delivery_terminal_without_claim',
          error_code = 'queue_delivery_terminal_without_claim',
          error_message = 'Queue delivery ended before the provider attempt was claimed',
          finished_at = coalesce(finished_at, now()),
          updated_at = now()
      where id = $1 and status = 'queued'
    `,
    [attemptId],
  );
}

async function clearCurrentProviderAttempt(pool: pg.Pool, jobId: string, expectedAttemptId: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `
      update provider_jobs
      set current_attempt_id = null,
          updated_at = now()
      where id = $1
        and status = 'queued'
        and current_attempt_id = $2
      returning id
    `,
    [jobId, expectedAttemptId],
  );
  return result.rows.length > 0;
}

export async function requeuePendingProviderJobs(
  pool: pg.Pool,
  queue: Queue,
  limits: ProviderJobAdmissionLimits,
  staleRunningMs = providerRunningStaleMs(),
): Promise<number> {
  await recoverStaleRunningProviderJobs(pool, staleRunningMs);
  await reconcileTerminalProviderJobAttempts(pool);
  const result = await pool.query<QueuedProviderJobRow>(
    `
      select j.id,
             j.current_attempt_id,
             a.id as attempt_id,
             a.status as attempt_status,
             a.bullmq_job_id,
             o.status as outbox_status
      from provider_jobs j
      left join provider_job_attempts a on a.id = j.current_attempt_id
      left join provider_job_outbox o on o.attempt_id = a.id
      where j.status = 'queued'
      order by j.created_at asc
    `,
  );
  let publishedCount = 0;
  for (const row of result.rows) {
    const currentAttemptId = row.current_attempt_id ?? null;
    if (
      currentAttemptId &&
      row.attempt_id === currentAttemptId &&
      row.attempt_status === 'queued' &&
      row.bullmq_job_id
    ) {
      const attempt = { attemptId: currentAttemptId, bullmqJobId: row.bullmq_job_id };
      if (row.outbox_status !== 'published') {
        await ensureProviderAttemptOutbox(pool, row.id, attempt);
        await publishProviderAttempt(pool, queue, row.id, attempt);
        publishedCount += 1;
        continue;
      }

      const queueState = await providerQueueJobState(queue, attempt.bullmqJobId);
      if (queueState === 'completed' || queueState === 'failed') {
        await markRetainedProviderAttemptTerminal(pool, attempt.attemptId, queueState);
      } else if (queueState && queueState !== 'missing' && queueState !== 'unknown') {
        continue;
      } else {
        await publishProviderAttempt(pool, queue, row.id, attempt);
        publishedCount += 1;
        continue;
      }
    }

    if (currentAttemptId && !(await clearCurrentProviderAttempt(pool, row.id, currentAttemptId))) continue;
    try {
      const publishedJobId = await enqueueProviderJob(pool, queue, row.id, limits);
      if (publishedJobId !== undefined) publishedCount += 1;
    } catch (error) {
      // Admission rejection is already persisted as a safe failed/review state.
      if (!(error instanceof ProviderJobAdmissionError)) throw error;
    }
  }
  return publishedCount;
}

export function createImportWorker(
  config: ServerConfig,
  processor: (jobId: string, uploadId: string) => Promise<void>,
): Worker {
  return new Worker(
    IMPORT_QUEUE_NAME,
    async (job) => {
      const jobId = String(job.data.jobId);
      const uploadId = String(job.data.uploadId);
      await processor(jobId, uploadId);
    },
    {
      connection: redisConnectionOptions(config),
      concurrency: Number.parseInt(process.env.IMPORT_WORKER_CONCURRENCY ?? '1', 10),
    },
  );
}

export function createProviderWorker(
  config: ServerConfig,
  processor: (jobId: string, attempt: ProviderWorkerAttempt) => Promise<void>,
): Worker {
  return new Worker(
    PROVIDER_QUEUE_NAME,
    async (job) => {
      const jobId = String(job.data.jobId);
      const bullmqJobId = String(job.id);
      const attemptId =
        typeof job.data.attemptId === 'string' && job.data.attemptId.trim() ? job.data.attemptId.trim() : bullmqJobId;
      await processor(jobId, { attemptId, bullmqJobId });
    },
    {
      connection: redisConnectionOptions(config),
      concurrency: Number.parseInt(process.env.PROVIDER_WORKER_CONCURRENCY ?? '1', 10),
    },
  );
}
