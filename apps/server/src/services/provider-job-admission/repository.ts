import type pg from 'pg';
import type { ProviderJobAdmissionLimits } from '../../config.js';
import {
  PROVIDER_JOB_ADMISSION_ERROR_CODE,
  type ProviderJobAdmissionDecision,
  type ProviderJobAdmissionLimit,
  type ProviderQueueAttempt,
} from './contracts.js';

interface AdmissionRow extends pg.QueryResultRow {
  outcome: 'admitted' | 'rejected';
  attempt_id: string | null;
  bullmq_job_id: string | null;
  reused: boolean | null;
  limit_kind: ProviderJobAdmissionLimit | null;
  retry_after_seconds: number | string | null;
}

const admissionMessage = 'Provider job admission limit was reached.';

export async function admitProviderJobAttempt(
  pool: pg.Pool,
  input: {
    readonly jobId: string;
    readonly attempt: ProviderQueueAttempt;
    readonly outboxId: string;
    readonly limits: ProviderJobAdmissionLimits;
  },
): Promise<ProviderJobAdmissionDecision> {
  const result = await pool.query<AdmissionRow>(
    `
      with target as materialized (
        select job.id, job.user_id, job.book_id, job.status, job.current_attempt_id,
               job.attempt_count, job.progress, admission_lock.acquired
        from provider_jobs job
        cross join lateral (
          select pg_advisory_xact_lock(hashtextextended(job.user_id, 764173)) as acquired
        ) admission_lock
        where job.id = $1
        for update of job
      ),
      existing_attempt as materialized (
        select attempt.id as attempt_id, attempt.bullmq_job_id
        from target
        join provider_job_attempts attempt on attempt.id = target.current_attempt_id
        where target.status = 'queued'
          and attempt.status in ('queued', 'running')
      ),
      usage as materialized (
        select
          count(attempt.id) filter (where attempt.status in ('queued', 'running'))::integer as active_count,
          count(attempt.id) filter (
            where attempt.created_at > statement_timestamp() - interval '1 minute'
          )::integer as minute_count,
          count(attempt.id) filter (
            where attempt.created_at >=
              (date_trunc('day', statement_timestamp() at time zone 'UTC') at time zone 'UTC')
          )::integer as day_count,
          min(attempt.created_at) filter (
            where attempt.created_at > statement_timestamp() - interval '1 minute'
          ) as oldest_minute_attempt_at
        from target
        left join provider_jobs user_job on user_job.user_id = target.user_id
        left join provider_job_attempts attempt on attempt.provider_job_id = user_job.id
      ),
      decision as materialized (
        select target.id, target.user_id, target.book_id, target.attempt_count, target.progress,
               case
                 when $5::integer > 0 and usage.active_count >= $5::integer then 'active_attempts'
                 when $6::integer > 0 and usage.minute_count >= $6::integer then 'attempts_per_minute'
                 when $7::integer > 0 and usage.day_count >= $7::integer then 'attempts_per_utc_day'
                 else null
               end as limit_kind,
               case
                 when $5::integer > 0 and usage.active_count >= $5::integer then null
                 when $6::integer > 0 and usage.minute_count >= $6::integer then greatest(
                   1,
                   ceil(extract(epoch from (
                     usage.oldest_minute_attempt_at + interval '1 minute' - statement_timestamp()
                   )))::integer
                 )
                 when $7::integer > 0 and usage.day_count >= $7::integer then greatest(
                   1,
                   ceil(extract(epoch from (
                     (
                       date_trunc('day', statement_timestamp() at time zone 'UTC') + interval '1 day'
                     ) at time zone 'UTC' - statement_timestamp()
                   )))::integer
                 )
                 else null
               end as retry_after_seconds
        from target
        cross join usage
        where target.status = 'queued'
          and target.current_attempt_id is null
          and not exists (select 1 from existing_attempt)
      ),
      inserted_attempt as (
        insert into provider_job_attempts (
          id, provider_job_id, attempt_number, bullmq_job_id, status, stage, progress, created_at, updated_at
        )
        select $2, decision.id, decision.attempt_count + 1, $3, 'queued', 'queued',
               decision.progress, statement_timestamp(), statement_timestamp()
        from decision
        where decision.limit_kind is null
        returning id, provider_job_id, attempt_number, bullmq_job_id
      ),
      updated_job as (
        update provider_jobs job
        set current_attempt_id = inserted_attempt.id,
            attempt_count = inserted_attempt.attempt_number,
            error_code = null,
            error_message = null,
            updated_at = statement_timestamp()
        from inserted_attempt
        where job.id = inserted_attempt.provider_job_id
          and job.status = 'queued'
          and job.current_attempt_id is null
        returning job.id, job.current_attempt_id
      ),
      inserted_outbox as (
        insert into provider_job_outbox (
          id, provider_job_id, attempt_id, bullmq_job_id, status, publish_attempts, created_at, updated_at
        )
        select $4, inserted_attempt.provider_job_id, inserted_attempt.id,
               inserted_attempt.bullmq_job_id, 'pending', 0, statement_timestamp(), statement_timestamp()
        from inserted_attempt
        join updated_job on updated_job.id = inserted_attempt.provider_job_id
        returning attempt_id
      ),
      rejected_job as (
        update provider_jobs job
        set status = 'failed',
            stage = 'admission_rejected',
            progress = jsonb_set(
              coalesce(job.progress, '{}'::jsonb),
              '{providerAdmission}',
              jsonb_strip_nulls(jsonb_build_object(
                'code', '${PROVIDER_JOB_ADMISSION_ERROR_CODE}',
                'limit', decision.limit_kind,
                'retryAfterSeconds', decision.retry_after_seconds,
                'rejectedAt', statement_timestamp()
              )),
              true
            ),
            error_code = '${PROVIDER_JOB_ADMISSION_ERROR_CODE}',
            error_message = $8,
            finished_at = statement_timestamp(),
            updated_at = statement_timestamp()
        from decision
        where job.id = decision.id
          and decision.limit_kind is not null
          and job.status = 'queued'
          and job.current_attempt_id is null
        returning job.id, job.user_id, job.book_id, decision.limit_kind, decision.retry_after_seconds
      ),
      rejected_workflows as (
        update book_ai_workflows workflow
        set status = 'needs_review',
            stage = 'needs_review',
            progress = coalesce(workflow.progress, '{}'::jsonb) || jsonb_build_object(
              'failedProviderJobId', rejected_job.id,
              'failedStage', workflow_job.stage,
              'failedPlanItemId', workflow_job.plan_item_id,
              'failedJobStatus', 'failed',
              'workflowReviewTargets', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                'id', 'provider_admission:' || rejected_job.id,
                'kind', 'provider_admission_rejected',
                'stage', workflow_job.stage,
                'planItemId', workflow_job.plan_item_id,
                'providerJobId', rejected_job.id,
                'providerJobStatus', 'failed',
                'errorCode', '${PROVIDER_JOB_ADMISSION_ERROR_CODE}',
                'message', $8,
                'recommendedAction', 'retry_workflow',
                'limit', rejected_job.limit_kind,
                'retryAfterSeconds', rejected_job.retry_after_seconds
              )))
            ),
            error_code = '${PROVIDER_JOB_ADMISSION_ERROR_CODE}',
            error_message = $8,
            updated_at = statement_timestamp()
        from rejected_job
        join book_ai_workflow_jobs workflow_job on workflow_job.provider_job_id = rejected_job.id
        where workflow.id = workflow_job.workflow_id
          and workflow.user_id = rejected_job.user_id
          and workflow.status in ('queued', 'running')
        returning workflow.book_id, workflow.user_id
      ),
      updated_books as (
        update library_books book
        set analysis_status = 'needs_review', updated_at = statement_timestamp()
        from rejected_workflows workflow
        where book.id = workflow.book_id and book.user_id = workflow.user_id
        returning book.id
      )
      select 'admitted'::text as outcome,
             existing_attempt.attempt_id,
             existing_attempt.bullmq_job_id,
             true as reused,
             null::text as limit_kind,
             null::integer as retry_after_seconds
      from existing_attempt
      union all
      select 'admitted'::text as outcome,
             inserted_attempt.id as attempt_id,
             inserted_attempt.bullmq_job_id,
             false as reused,
             null::text as limit_kind,
             null::integer as retry_after_seconds
      from inserted_attempt
      join updated_job on updated_job.current_attempt_id = inserted_attempt.id
      join inserted_outbox on inserted_outbox.attempt_id = inserted_attempt.id
      union all
      select 'rejected'::text as outcome,
             null::text as attempt_id,
             null::text as bullmq_job_id,
             false as reused,
             rejected_job.limit_kind,
             rejected_job.retry_after_seconds
      from rejected_job
      limit 1
    `,
    [
      input.jobId,
      input.attempt.attemptId,
      input.attempt.bullmqJobId,
      input.outboxId,
      input.limits.maxActiveAttempts,
      input.limits.maxAttemptsPerMinute,
      input.limits.maxAttemptsPerUtcDay,
      admissionMessage,
    ],
  );

  const row = result.rows[0];
  if (!row) return { kind: 'not_queued' };
  if (row.outcome === 'rejected' && row.limit_kind) {
    const retryAfterSeconds = Number(row.retry_after_seconds);
    return {
      kind: 'rejected',
      rejection: {
        code: PROVIDER_JOB_ADMISSION_ERROR_CODE,
        limit: row.limit_kind,
        ...(Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0 ? { retryAfterSeconds } : {}),
      },
    };
  }
  if (!row.attempt_id || !row.bullmq_job_id) return { kind: 'not_queued' };
  return {
    kind: 'admitted',
    attempt: { attemptId: row.attempt_id, bullmqJobId: row.bullmq_job_id },
    reused: row.reused === true,
  };
}
