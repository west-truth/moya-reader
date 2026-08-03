import crypto from 'node:crypto';
import pg from 'pg';
import {
  ProviderJobCancelledError,
  type ProviderJobExecutionIdentity,
  type ProviderJobProgressPatch,
  type ProviderJobRow,
  type ProviderJobStatus,
} from './contracts.js';
import { recordValue } from './job-progress.js';

const PROVIDER_ATTEMPT_LEASE_TTL_MS = 60_000;

interface ProviderAttemptLeaseIdentity {
  readonly attemptGeneration: number;
  readonly leaseOwner: string;
  readonly leaseTokenHash: string;
}

function leaseIdentity(job: ProviderJobRow): ProviderAttemptLeaseIdentity | undefined {
  const execution = job.execution;
  if (
    !execution ||
    !Number.isSafeInteger(execution.attemptGeneration) ||
    Number(execution.attemptGeneration) <= 0 ||
    !execution.leaseOwner ||
    !execution.leaseTokenHash
  ) {
    return undefined;
  }
  return {
    attemptGeneration: Number(execution.attemptGeneration),
    leaseOwner: execution.leaseOwner,
    leaseTokenHash: execution.leaseTokenHash,
  };
}

export async function updateProviderJobProgress(
  queryable: pg.Pool | pg.PoolClient,
  job: ProviderJobRow,
  patch: ProviderJobProgressPatch,
): Promise<boolean> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  let errorCodeValueIndex: number | undefined;
  const setValue = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  if (patch.progress !== undefined && patch.mergeProgress !== undefined) {
    throw new Error('provider job progress patch cannot replace and merge progress together');
  }

  if (patch.status !== undefined) setValue('status', patch.status);
  if (patch.stage !== undefined) setValue('stage', patch.stage);
  if (patch.progress !== undefined) setValue('progress', JSON.stringify(patch.progress));
  if (patch.mergeProgress !== undefined) {
    values.push(JSON.stringify(patch.mergeProgress));
    assignments.push(`progress = coalesce(progress, '{}'::jsonb) || $${values.length}::jsonb`);
  }
  if (patch.errorCode !== undefined) {
    setValue('error_code', patch.errorCode);
    errorCodeValueIndex = values.length;
  }
  if (patch.errorMessage !== undefined) setValue('error_message', patch.errorMessage);
  if (patch.startedAt) assignments.push('started_at = coalesce(started_at, now())');
  if (patch.finishedAt) assignments.push('finished_at = now()');
  if (!assignments.length) return false;

  values.push(job.id);
  const jobIdIndex = values.length;
  if (job.execution) {
    values.push(job.execution.attemptId);
    const attemptIdIndex = values.length;
    const lease = leaseIdentity(job);
    let leasePredicate = '';
    if (lease) {
      values.push(lease.attemptGeneration, lease.leaseOwner, lease.leaseTokenHash);
      const generationIndex = values.length - 2;
      const ownerIndex = values.length - 1;
      const tokenIndex = values.length;
      leasePredicate = `
        and attempt_generation = $${generationIndex}
        and lease_owner = $${ownerIndex}
        and lease_token_hash = $${tokenIndex}
        and lease_expires_at > now()
      `;
    }
    const attemptAssignments = [...assignments];
    if (patch.status === 'succeeded') {
      attemptAssignments.push(
        "outcome_state = 'succeeded'",
        "billing_state = case when dispatch_started_at is null then 'not_billable' else 'billed_possible' end",
        "normalized_completion_code = 'completed'",
        'normalized_error_code = null',
        'reconcile_after = null',
        'lease_expires_at = null',
      );
    } else if (patch.status === 'failed') {
      attemptAssignments.push(
        "outcome_state = 'failed'",
        "billing_state = case when dispatch_started_at is null then 'not_billable' else 'billed_possible' end",
        errorCodeValueIndex
          ? `normalized_error_code = $${errorCodeValueIndex}`
          : "normalized_error_code = 'provider_failed'",
        'reconcile_after = null',
        'lease_expires_at = null',
      );
    } else if (patch.status === 'cancelled') {
      attemptAssignments.push(
        "outcome_state = 'cancelled'",
        "billing_state = case when dispatch_started_at is null then 'not_billable' else 'billed_possible' end",
        'reconcile_after = null',
        'lease_expires_at = null',
      );
    }
    const currentLeasePredicate = lease
      ? `and exists (
          select 1 from provider_job_attempts lease
          where lease.id = $${attemptIdIndex}
            and lease.provider_job_id = $${jobIdIndex}
            and lease.status = 'running'
            ${leasePredicate}
        )`
      : '';
    const result = await queryable.query<{ applied: boolean }>(
      `
        with updated_job as (
          update provider_jobs
          set ${assignments.join(', ')}, updated_at = now()
          where id = $${jobIdIndex}
            and current_attempt_id = $${attemptIdIndex}
            and status = 'running'
            ${currentLeasePredicate}
          returning 1
        ),
        updated_attempt as (
          update provider_job_attempts
          set ${attemptAssignments.join(', ')}, heartbeat_at = now(), updated_at = now()
          where id = $${attemptIdIndex}
            and provider_job_id = $${jobIdIndex}
            and status in ('queued', 'running')
            ${leasePredicate}
            and exists(select 1 from updated_job)
          returning 1
        )
        select exists(select 1 from updated_job) as applied
      `,
      values,
    );
    return Boolean(result.rows[0]?.applied);
  }

  const whereClause =
    patch.status === 'cancelled' ? `where id = $${jobIdIndex}` : `where id = $${jobIdIndex} and status <> 'cancelled'`;
  const result = await queryable.query(
    `update provider_jobs set ${assignments.join(', ')}, updated_at = now() ${whereClause}`,
    values,
  );
  return result.rowCount == null ? true : result.rowCount > 0;
}

async function claimLegacyProviderJob(
  pool: pg.Pool,
  jobId: string,
  userId: string,
): Promise<ProviderJobRow | undefined> {
  const result = await pool.query<ProviderJobRow>(
    `
      update provider_jobs
      set status = $3,
          stage = case
            when job_type = 'tts_synthesis' then 'loading_tts_input'
            when job_type = 'character_bundle_analysis' then 'loading_bundle'
            when job_type = 'character_graph_merge' then 'loading_graph'
            else 'loading_chapter'
          end,
          progress = jsonb_set(coalesce(progress, '{}'::jsonb), '{loaded}', 'false'::jsonb, true),
          error_code = null,
          error_message = null,
          started_at = coalesce(started_at, now()),
          updated_at = now()
      where id = $1
        and user_id = $2
        and status = 'queued'
      returning id, user_id, book_id, chapter_id, job_type, provider_id, model_id,
                input_hash, status, progress, current_attempt_id, attempt_count, analysis_input_revision_id
    `,
    [jobId, userId, 'running'],
  );
  const claimed = result.rows[0];
  if (claimed) return claimed;

  const current = await loadProviderJob(pool, jobId, userId);
  if (result.rowCount === undefined && (current.status === 'queued' || current.status === 'running')) return current;
  if ((result.rowCount ?? 0) > 0 && current.status === 'running') return current;
  if (current.status === 'succeeded' || current.status === 'cancelled' || current.status === 'running')
    return undefined;
  if (current.status === 'failed') return undefined;
  return undefined;
}

interface ProviderJobAttemptRow {
  attempt_number: number | string;
  attempt_generation?: number | string;
  provider_job_id: string;
  bullmq_job_id: string;
  status: ProviderJobStatus;
}

async function claimProviderJobAttempt(
  pool: pg.Pool,
  jobId: string,
  userId: string,
  execution: ProviderJobExecutionIdentity,
): Promise<ProviderJobRow | undefined> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const locked = await client.query<ProviderJobRow>(
      `
        select id, user_id, book_id, chapter_id, job_type, provider_id, model_id,
               input_hash, status, progress, current_attempt_id, attempt_count, analysis_input_revision_id
        from provider_jobs
        where id = $1 and user_id = $2
        for update
      `,
      [jobId, userId],
    );
    const logicalJob = locked.rows[0];
    if (!logicalJob) throw new Error(`Provider job not found: ${jobId}`);
    if (logicalJob.status !== 'queued' || logicalJob.current_attempt_id !== execution.attemptId) {
      await client.query('commit');
      return undefined;
    }

    const existingAttempt = await client.query<ProviderJobAttemptRow>(
      `
        select attempt_number, attempt_generation, provider_job_id, bullmq_job_id, status
        from provider_job_attempts
        where id = $1
      `,
      [execution.attemptId],
    );
    const existing = existingAttempt.rows[0];
    if (!existing) {
      await client.query('commit');
      return undefined;
    }
    if (
      existing.provider_job_id !== jobId ||
      existing.bullmq_job_id !== execution.bullmqJobId ||
      existing.status !== 'queued'
    ) {
      throw new Error(`Provider job attempt identity conflict: ${execution.attemptId}`);
    }
    const attemptNumber = Number(existing.attempt_number);
    const attemptGeneration = Number(existing.attempt_generation ?? 0) + 1;
    const leaseOwner = `bullmq:${execution.bullmqJobId}:${crypto.randomUUID()}`;
    const leaseTokenHash = crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');

    const claimed = await client.query<ProviderJobRow>(
      `
        update provider_jobs
        set status = 'running',
            stage = case
              when job_type = 'tts_synthesis' then 'loading_tts_input'
              when job_type = 'character_bundle_analysis' then 'loading_bundle'
              when job_type = 'character_graph_merge' then 'loading_graph'
              else 'loading_chapter'
            end,
            progress = jsonb_set(coalesce(progress, '{}'::jsonb), '{loaded}', 'false'::jsonb, true),
            error_code = null,
            error_message = null,
            current_attempt_id = $3,
            attempt_count = greatest(attempt_count, $4),
            started_at = coalesce(started_at, now()),
            updated_at = now()
        where id = $1 and user_id = $2 and status = 'queued'
        returning id, user_id, book_id, chapter_id, job_type, provider_id, model_id,
                  input_hash, status, progress, current_attempt_id, attempt_count, analysis_input_revision_id
      `,
      [jobId, userId, execution.attemptId, attemptNumber],
    );
    const row = claimed.rows[0];
    if (!row) {
      await client.query('rollback');
      return undefined;
    }
    const claimedAttempt = await client.query<{ attempt_generation: number | string }>(
      `
        update provider_job_attempts
        set status = 'running',
            stage = $2,
            progress = $3,
            error_code = null,
            error_message = null,
            attempt_generation = $5,
            lease_owner = $6,
            lease_token_hash = $7,
            lease_expires_at = now() + ($8::integer * interval '1 millisecond'),
            heartbeat_at = now(),
            outcome_state = 'claimed',
            billing_state = 'not_started',
            reconcile_after = null,
            normalized_completion_code = null,
            normalized_error_code = null,
            started_at = coalesce(started_at, now()),
            updated_at = now()
        where id = $1 and provider_job_id = $4 and status = 'queued'
        returning attempt_generation
      `,
      [
        execution.attemptId,
        row.job_type === 'tts_synthesis'
          ? 'loading_tts_input'
          : row.job_type === 'character_bundle_analysis'
            ? 'loading_bundle'
            : row.job_type === 'character_graph_merge'
              ? 'loading_graph'
              : 'loading_chapter',
        JSON.stringify(recordValue(row.progress) ?? {}),
        jobId,
        attemptGeneration,
        leaseOwner,
        leaseTokenHash,
        PROVIDER_ATTEMPT_LEASE_TTL_MS,
      ],
    );
    if (claimedAttempt.rowCount !== undefined && claimedAttempt.rowCount !== 1) {
      await client.query('rollback');
      return undefined;
    }
    await client.query(
      `
        insert into provider_job_outbox (
          id, provider_job_id, attempt_id, bullmq_job_id, status, publish_attempts,
          created_at, updated_at, published_at
        )
        values ($1, $2, $3, $4, 'published', 1, now(), now(), now())
        on conflict (attempt_id) do update
        set status = 'published',
            publish_attempts = greatest(provider_job_outbox.publish_attempts, 1),
            last_error = null,
            published_at = coalesce(provider_job_outbox.published_at, now()),
            updated_at = now()
      `,
      [`${execution.attemptId}_outbox`, jobId, execution.attemptId, execution.bullmqJobId],
    );
    await client.query('commit');
    return {
      ...row,
      execution: {
        ...execution,
        attemptGeneration: Number(claimedAttempt.rows[0]?.attempt_generation ?? attemptGeneration),
        leaseOwner,
        leaseTokenHash,
      },
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimProviderJob(
  pool: pg.Pool,
  jobId: string,
  userId: string,
  execution?: ProviderJobExecutionIdentity,
): Promise<ProviderJobRow | undefined> {
  return execution
    ? claimProviderJobAttempt(pool, jobId, userId, execution)
    : claimLegacyProviderJob(pool, jobId, userId);
}

export async function loadProviderJob(
  pool: Pick<pg.Pool, 'query'>,
  jobId: string,
  userId: string,
): Promise<ProviderJobRow> {
  const result = await pool.query<ProviderJobRow>(
    `
      select id, user_id, book_id, chapter_id, job_type, provider_id, model_id, input_hash, status, progress,
             current_attempt_id, attempt_count, analysis_input_revision_id
      from provider_jobs
      where id = $1 and user_id = $2
    `,
    [jobId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Provider job not found: ${jobId}`);
  return row;
}

export async function renewProviderJobLease(
  pool: Pick<pg.Pool, 'query'>,
  job: ProviderJobRow,
  leaseTtlMs = PROVIDER_ATTEMPT_LEASE_TTL_MS,
): Promise<boolean> {
  const lease = leaseIdentity(job);
  if (!job.execution || !lease) return true;
  const result = await pool.query(
    `
      update provider_job_attempts attempt
      set heartbeat_at = now(),
          lease_expires_at = now() + ($7::integer * interval '1 millisecond'),
          updated_at = now()
      from provider_jobs job
      where attempt.id = $1
        and attempt.provider_job_id = $2
        and attempt.attempt_generation = $3
        and attempt.lease_owner = $4
        and attempt.lease_token_hash = $5
        and attempt.lease_expires_at > now()
        and attempt.status = 'running'
        and job.id = attempt.provider_job_id
        and job.user_id = $6
        and job.status = 'running'
        and job.current_attempt_id = attempt.id
    `,
    [
      job.execution.attemptId,
      job.id,
      lease.attemptGeneration,
      lease.leaseOwner,
      lease.leaseTokenHash,
      job.user_id,
      Math.max(1, Math.floor(leaseTtlMs)),
    ],
  );
  return result.rowCount == null ? true : result.rowCount > 0;
}

export async function markProviderJobDispatchStarted(pool: pg.Pool, job: ProviderJobRow): Promise<void> {
  const lease = leaseIdentity(job);
  if (!job.execution || !lease) return;
  const idempotencyKeyHash = crypto
    .createHash('sha256')
    .update(`${job.id}:${job.execution.attemptId}:${lease.attemptGeneration}`)
    .digest('hex');
  const result = await pool.query(
    `
      update provider_job_attempts attempt
      set outcome_state = 'in_flight',
          billing_state = 'estimated',
          dispatch_started_at = coalesce(dispatch_started_at, now()),
          provider_idempotency_key_hash = coalesce(provider_idempotency_key_hash, $6),
          heartbeat_at = now(),
          updated_at = now()
      from provider_jobs job
      where attempt.id = $1
        and attempt.provider_job_id = $2
        and attempt.attempt_generation = $3
        and attempt.lease_owner = $4
        and attempt.lease_token_hash = $5
        and attempt.lease_expires_at > now()
        and attempt.status = 'running'
        and attempt.outcome_state in ('claimed', 'dispatching', 'in_flight')
        and job.id = attempt.provider_job_id
        and job.status = 'running'
        and job.current_attempt_id = attempt.id
    `,
    [
      job.execution.attemptId,
      job.id,
      lease.attemptGeneration,
      lease.leaseOwner,
      lease.leaseTokenHash,
      idempotencyKeyHash,
    ],
  );
  if (result.rowCount !== undefined && result.rowCount !== 1) throw new ProviderJobCancelledError(job.id);
}

export async function quarantineProviderJobLateResult(
  pool: Pick<pg.Pool, 'query'>,
  job: ProviderJobRow,
  errorCode: string,
): Promise<void> {
  const lease = leaseIdentity(job);
  if (!job.execution || !lease) return;
  await pool.query(
    `
      update provider_job_attempts
      set outcome_state = 'quarantined',
          billing_state = case when dispatch_started_at is null then 'not_billable' else 'billed_possible' end,
          normalized_error_code = $6,
          reconcile_after = null,
          lease_expires_at = null,
          updated_at = now()
      where id = $1
        and provider_job_id = $2
        and attempt_generation = $3
        and lease_owner = $4
        and lease_token_hash = $5
        and outcome_state in ('dispatching', 'in_flight', 'outcome_unknown', 'cancelled')
    `,
    [job.execution.attemptId, job.id, lease.attemptGeneration, lease.leaseOwner, lease.leaseTokenHash, errorCode],
  );
}

export async function assertProviderJobNotCancelled(pool: pg.Pool, job: ProviderJobRow): Promise<void> {
  const current = await loadProviderJob(pool, job.id, job.user_id);
  if (job.execution && (current.status !== 'running' || current.current_attempt_id !== job.execution.attemptId)) {
    throw new ProviderJobCancelledError(job.id);
  }
  if (!(await renewProviderJobLease(pool, job))) throw new ProviderJobCancelledError(job.id);
  if (current.status === 'cancelled') throw new ProviderJobCancelledError(job.id);
}

export function createProviderJobAbortMonitor(
  pool: pg.Pool,
  job: ProviderJobRow,
  pollMs = 1000,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  let stopped = false;
  let checking = false;
  let lastLeaseRenewedAt = 0;
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new ProviderJobCancelledError(job.id));
  };
  const check = async () => {
    if (stopped || checking || controller.signal.aborted) return;
    checking = true;
    try {
      const current = await loadProviderJob(pool, job.id, job.user_id);
      if (job.execution) {
        if (current.status !== 'running' || current.current_attempt_id !== job.execution.attemptId) abort();
        else if (Date.now() - lastLeaseRenewedAt >= PROVIDER_ATTEMPT_LEASE_TTL_MS / 3) {
          if (!(await renewProviderJobLease(pool, job))) abort();
          else lastLeaseRenewedAt = Date.now();
        }
      } else if (current.status === 'cancelled') {
        abort();
      }
    } catch {
      // A transient status-check failure should not abort an otherwise valid provider call.
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(
    () => {
      void check();
    },
    Math.max(1, pollMs),
  );
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === 'function') unref.call(timer);
  void check();
  return {
    signal: controller.signal,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function lockProviderJobForPersistence(client: pg.PoolClient, job: ProviderJobRow): Promise<void> {
  const result = await client.query<ProviderJobRow>(
    `
      select id, user_id, book_id, chapter_id, job_type, provider_id, model_id, input_hash, status, progress,
             current_attempt_id, attempt_count, analysis_input_revision_id
      from provider_jobs
      where id = $1 and user_id = $2
      for update
    `,
    [job.id, job.user_id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Provider job not found: ${job.id}`);
  if (job.execution && (row.status !== 'running' || row.current_attempt_id !== job.execution.attemptId)) {
    throw new ProviderJobCancelledError(job.id);
  }
  const lease = leaseIdentity(job);
  if (job.execution && lease) {
    const currentLease = await client.query(
      `
        update provider_job_attempts
        set heartbeat_at = now(),
            lease_expires_at = now() + ($6::integer * interval '1 millisecond'),
            updated_at = now()
        where id = $1
          and provider_job_id = $2
          and attempt_generation = $3
          and lease_owner = $4
          and lease_token_hash = $5
          and lease_expires_at > now()
          and status = 'running'
        returning 1
      `,
      [
        job.execution.attemptId,
        job.id,
        lease.attemptGeneration,
        lease.leaseOwner,
        lease.leaseTokenHash,
        PROVIDER_ATTEMPT_LEASE_TTL_MS,
      ],
    );
    if (!currentLease.rows[0]) throw new ProviderJobCancelledError(job.id);
  }
  if (row.status === 'cancelled') throw new ProviderJobCancelledError(job.id);
}
