import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import type { ProviderJobRow } from './provider-job-contract.js';

export async function loadProviderJob(
  pool: pg.Pool,
  config: ServerConfig,
  jobId: string,
): Promise<ProviderJobRow | undefined> {
  const result = await pool.query<ProviderJobRow>(
    `
      select job.id, job.book_id, job.chapter_id, job.job_type, job.provider_id, job.model_id,
             job.input_hash, job.status, job.stage, job.progress, job.error_code, job.error_message,
             job.created_at, job.updated_at, job.started_at, job.finished_at,
             job.current_attempt_id, attempt.attempt_generation, attempt.outcome_state,
             attempt.billing_state, attempt.heartbeat_at, attempt.dispatch_started_at,
             attempt.reconcile_after, attempt.normalized_completion_code, attempt.normalized_error_code
      from provider_jobs job
      left join provider_job_attempts attempt on attempt.id = job.current_attempt_id
      where job.id = $1 and job.user_id = $2
    `,
    [jobId, config.defaultUserId],
  );
  return result.rows[0];
}
