import type { Queue } from 'bullmq';
import pg from 'pg';
import { providerJobAdmissionLimits, type ServerConfig } from '../../config.js';
import { enqueueProviderJob } from '../../queue.js';
import { ProviderJobAdmissionError } from '../provider-job-admission/index.js';
import { providerJobId } from '@noveldesk/text-core/identity/provider';
import { bookAIWorkflowJobId } from '@noveldesk/text-core/identity/workflow';
import type { RevisionQueryable } from './analysis-input-repository.js';
import type { ProviderJobStatus, WorkflowProviderJobLinkRow } from './workflow-contracts.js';

async function existingProviderJobByHash(
  pool: RevisionQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly chapterId?: string | null;
    readonly jobType: string;
    readonly providerId: string;
    readonly modelId: string | null;
    readonly inputHash: string;
  },
): Promise<WorkflowProviderJobLinkRow | undefined> {
  const result = await pool.query<WorkflowProviderJobLinkRow>(
    `
      select id as provider_job_id, '' as id, '' as workflow_id, '' as stage, '' as plan_item_id, 0 as sequence,
             job_type, provider_id, model_id, input_hash, status, progress, error_code, error_message,
             current_attempt_id, analysis_input_revision_id
      from provider_jobs
      where book_id = $1
        and chapter_id is not distinct from $2
        and job_type = $3
        and provider_id = $4
        and model_id is not distinct from $5
        and input_hash = $6
        and user_id = $7
    `,
    [
      input.bookId,
      input.chapterId ?? null,
      input.jobType,
      input.providerId,
      input.modelId,
      input.inputHash,
      input.userId,
    ],
  );
  return result.rows[0];
}

export async function insertProviderJob(
  pool: RevisionQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly chapterId?: string | null;
    readonly jobType: string;
    readonly providerId: string;
    readonly modelId: string | null;
    readonly inputHash: string;
    readonly progress: Record<string, unknown>;
  },
): Promise<{ id: string; status: ProviderJobStatus }> {
  const existing = await existingProviderJobByHash(pool, input);
  if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') {
    return { id: existing.provider_job_id, status: existing.status };
  }
  if (existing) {
    const updated = await pool.query<{ id: string; status: ProviderJobStatus }>(
      `
        update provider_jobs
        set status = 'queued',
            stage = 'queued',
            progress = $3,
            error_code = null,
            error_message = null,
            started_at = null,
            finished_at = null,
            updated_at = now()
        where id = $1
          and user_id = $2
          and status = $4
          and current_attempt_id is not distinct from $5
        returning id, status
      `,
      [
        existing.provider_job_id,
        input.userId,
        JSON.stringify(input.progress),
        existing.status,
        existing.current_attempt_id ?? null,
      ],
    );
    return updated.rows[0] ?? { id: existing.provider_job_id, status: existing.status };
  }
  const jobId = providerJobId({
    userId: input.userId,
    novelId: input.bookId,
    chapterId: input.chapterId ?? undefined,
    jobType: input.jobType,
    providerId: input.providerId,
    modelId: input.modelId ?? undefined,
    inputHash: input.inputHash,
  });
  const inserted = await pool.query<{ id: string; status: ProviderJobStatus }>(
    `
      insert into provider_jobs (
        id, user_id, book_id, chapter_id, job_type, provider_id, model_id, input_hash,
        status, stage, progress, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', 'queued', $9, now(), now())
      on conflict do nothing
      returning id, status
    `,
    [
      jobId,
      input.userId,
      input.bookId,
      input.chapterId ?? null,
      input.jobType,
      input.providerId,
      input.modelId,
      input.inputHash,
      JSON.stringify(input.progress),
    ],
  );
  const row = inserted.rows[0];
  if (row) return row;
  const concurrent = await existingProviderJobByHash(pool, input);
  if (!concurrent) throw new Error(`Provider job insert conflict could not be resolved: ${jobId}`);
  return { id: concurrent.provider_job_id, status: concurrent.status };
}

export async function linkWorkflowJob(
  pool: RevisionQueryable,
  input: {
    readonly workflowId: string;
    readonly providerJobId: string;
    readonly stage: string;
    readonly planItemId: string;
    readonly sequence: number;
  },
): Promise<void> {
  await pool.query(
    `
      insert into book_ai_workflow_jobs (id, workflow_id, provider_job_id, stage, plan_item_id, sequence, created_at)
      values ($1, $2, $3, $4, $5, $6, now())
      on conflict (workflow_id, stage, plan_item_id)
      do update set provider_job_id = excluded.provider_job_id,
                    sequence = excluded.sequence
    `,
    [
      bookAIWorkflowJobId(input.workflowId, input.stage, input.planItemId),
      input.workflowId,
      input.providerJobId,
      input.stage,
      input.planItemId,
      input.sequence,
    ],
  );
}

export async function maybeEnqueueProviderJob(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  job: { id: string; status: ProviderJobStatus },
): Promise<boolean> {
  if (!queue || job.status !== 'queued') return true;
  try {
    await enqueueProviderJob(pool, queue, job.id, providerJobAdmissionLimits(config));
    return true;
  } catch (error) {
    // The admission statement has already moved linked workflows to needs_review.
    if (error instanceof ProviderJobAdmissionError) return false;
    throw error;
  }
}
