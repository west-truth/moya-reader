import type pg from 'pg';
import type { ProviderJobRow } from '../provider-jobs/contracts.js';
import type { RevisionQueryable } from './analysis-input-repository.js';
import type { BookAIWorkflowRow } from './workflow-contracts.js';

export async function loadActiveWorkflowJobs(
  db: RevisionQueryable,
  workflowId: string,
  userId: string,
): Promise<ProviderJobRow[]> {
  const result = await db.query<ProviderJobRow & pg.QueryResultRow>(
    `
      select pj.id, pj.user_id, pj.book_id, pj.chapter_id, pj.job_type, pj.provider_id,
             pj.model_id, pj.input_hash, pj.status, pj.progress, pj.current_attempt_id,
             pj.attempt_count, pj.analysis_input_revision_id
      from book_ai_workflow_jobs workflow_job
      join book_ai_workflows workflow on workflow.id = workflow_job.workflow_id
      join provider_jobs pj on pj.id = workflow_job.provider_job_id
      where workflow.id = $1
        and workflow.user_id = $2
        and pj.status in ('queued', 'running')
      order by workflow_job.sequence, pj.id
      for update of pj
    `,
    [workflowId, userId],
  );
  return result.rows;
}

export async function cancelWorkflowProviderJob(
  db: RevisionQueryable,
  job: ProviderJobRow,
  progress: Readonly<Record<string, unknown>>,
): Promise<ProviderJobRow | undefined> {
  const result = await db.query<ProviderJobRow & pg.QueryResultRow>(
    `
      with cancelled_job as (
        update provider_jobs
        set status = 'cancelled',
            stage = 'cancelled',
            outcome_state = 'cancelled',
            billing_state = case
              when dispatch_started_at is null then 'not_billable'
              else 'billed_possible'
            end,
            normalized_error_code = 'provider_job_cancelled',
            reconcile_after = null,
            lease_expires_at = null,
            progress = $3,
            error_code = 'provider_job_cancelled',
            error_message = 'Provider job cancelled by workflow cancel',
            finished_at = now(),
            updated_at = now()
        where id = $1
          and user_id = $2
          and status = $4
          and current_attempt_id is not distinct from $5
        returning id, user_id, book_id, chapter_id, job_type, provider_id, model_id,
                  input_hash, status, progress, current_attempt_id, attempt_count,
                  analysis_input_revision_id
      ),
      cancelled_attempt as (
        update provider_job_attempts attempt
        set status = 'cancelled',
            stage = 'cancelled',
            progress = $3,
            error_code = 'provider_job_cancelled',
            error_message = 'Provider job cancelled by workflow cancel',
            finished_at = now(),
            updated_at = now()
        from cancelled_job job
        where attempt.id = job.current_attempt_id
          and attempt.provider_job_id = job.id
          and attempt.status in ('queued', 'running')
        returning attempt.id
      )
      select * from cancelled_job
    `,
    [job.id, job.user_id, JSON.stringify(progress), job.status, job.current_attempt_id ?? null],
  );
  return result.rows[0];
}

export async function loadBullmqJobId(
  db: RevisionQueryable,
  jobId: string,
  userId: string,
  attemptId: string | null,
): Promise<string | undefined> {
  if (!attemptId) return undefined;
  const result = await db.query<{ bullmq_job_id: string }>(
    `
      select attempt.bullmq_job_id
      from provider_job_attempts attempt
      join provider_jobs job on job.id = attempt.provider_job_id
      where job.id = $1 and job.user_id = $2 and attempt.id = $3
    `,
    [jobId, userId, attemptId],
  );
  return result.rows[0]?.bullmq_job_id;
}

export async function updateCancelledJobProgress(
  db: RevisionQueryable,
  job: ProviderJobRow,
  progress: Readonly<Record<string, unknown>>,
): Promise<void> {
  await db.query(
    `
      update provider_jobs
      set progress = $3, updated_at = now()
      where id = $1
        and user_id = $2
        and status = 'cancelled'
        and current_attempt_id is not distinct from $4
    `,
    [job.id, job.user_id, JSON.stringify(progress), job.current_attempt_id ?? null],
  );
}

export async function updateCancelledWorkflowQueueRemovals(
  db: RevisionQueryable,
  workflowId: string,
  userId: string,
  queueRemovals: Readonly<Record<string, unknown>>,
): Promise<void> {
  await db.query(
    `
      update book_ai_workflows
      set progress = progress || jsonb_build_object('queueRemovals', $3::jsonb),
          updated_at = now()
      where id = $1 and user_id = $2 and status = 'cancelled'
    `,
    [workflowId, userId, JSON.stringify(queueRemovals)],
  );
}

export async function cancelWorkflowRow(
  db: RevisionQueryable,
  workflow: BookAIWorkflowRow,
  progress: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `
      update book_ai_workflows
      set status = 'cancelled',
          stage = 'cancelled',
          progress = $3,
          error_code = 'workflow_cancelled',
          error_message = 'Book AI workflow cancelled by user',
          finished_at = now(),
          updated_at = now()
      where id = $1
        and user_id = $2
        and status not in ('succeeded', 'failed', 'cancelled')
      returning id
    `,
    [workflow.id, workflow.user_id, JSON.stringify(progress)],
  );
  return Boolean(result.rows[0]);
}

export async function markCancelledWorkflowBook(db: RevisionQueryable, workflow: BookAIWorkflowRow): Promise<void> {
  await db.query(
    `
      update library_books
      set analysis_status = 'cancelled', updated_at = now()
      where id = $1 and user_id = $2 and active_content_revision_id = $3 and revision_fence = $4
    `,
    [workflow.book_id, workflow.user_id, workflow.content_revision_id, workflow.revision_fence],
  );
}
