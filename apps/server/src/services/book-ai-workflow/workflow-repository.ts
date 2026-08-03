import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import type { BookAIWorkflowRow, WorkflowProviderJobLinkRow } from './workflow-contracts.js';
import type { RevisionQueryable } from './analysis-input-repository.js';
import { recordValue, reviewTargetForFailedLink } from './workflow-state.js';

interface WorkflowDbRow extends pg.QueryResultRow, Omit<BookAIWorkflowRow, 'revision_fence'> {
  revision_fence: number | string;
}

function mapWorkflowRow(row: WorkflowDbRow): BookAIWorkflowRow {
  return { ...row, revision_fence: Number(row.revision_fence) };
}

export async function loadWorkflow(
  pool: RevisionQueryable,
  config: ServerConfig,
  workflowId: string,
): Promise<{ row: BookAIWorkflowRow; links: WorkflowProviderJobLinkRow[] } | undefined> {
  const workflow = await pool.query<WorkflowDbRow>(
    `
      select id, user_id, book_id, provider_id, model_id, plan_hash, plan,
             content_revision_id, base_graph_revision_id, revision_fence,
             status, stage, progress
      from book_ai_workflows
      where id = $1 and user_id = $2
    `,
    [workflowId, config.defaultUserId],
  );
  const dbRow = workflow.rows[0];
  if (!dbRow) return undefined;
  const row = mapWorkflowRow(dbRow);
  const links = await pool.query<WorkflowProviderJobLinkRow>(
    `
      select wj.id, wj.workflow_id, wj.provider_job_id, wj.stage, wj.plan_item_id, wj.sequence,
             pj.job_type, pj.provider_id, pj.model_id, pj.input_hash, pj.status, pj.progress,
             pj.error_code, pj.error_message, pj.current_attempt_id, pj.analysis_input_revision_id
      from book_ai_workflow_jobs wj
      join provider_jobs pj on pj.id = wj.provider_job_id
      where wj.workflow_id = $1
      order by wj.stage asc, wj.sequence asc
    `,
    [workflowId],
  );
  return { row, links: links.rows };
}

export async function linkedWorkflowIds(pool: pg.Pool, config: ServerConfig, providerJobId: string): Promise<string[]> {
  const result = await pool.query<{ workflow_id: string }>(
    `
      select distinct wj.workflow_id
      from book_ai_workflow_jobs wj
      join book_ai_workflows w on w.id = wj.workflow_id
      where wj.provider_job_id = $1
        and w.user_id = $2
        and w.status in ('queued', 'running', 'needs_review')
    `,
    [providerJobId, config.defaultUserId],
  );
  return result.rows.map((row) => row.workflow_id);
}

export async function updateWorkflowProgress(
  pool: RevisionQueryable,
  workflow: BookAIWorkflowRow,
  patch: {
    readonly status?: string;
    readonly stage?: string;
    readonly progress?: Record<string, unknown>;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
    readonly finished?: boolean;
  },
): Promise<void> {
  await pool.query(
    `
      update book_ai_workflows
      set status = coalesce($3, status),
          stage = coalesce($4, stage),
          progress = coalesce($5::jsonb, progress),
          error_code = $6,
          error_message = $7,
          finished_at = case when $8 then now() else finished_at end,
          updated_at = now()
      where id = $1 and user_id = $2
    `,
    [
      workflow.id,
      workflow.user_id,
      patch.status ?? null,
      patch.stage ?? null,
      patch.progress ? JSON.stringify({ ...recordValue(workflow.progress), ...patch.progress }) : null,
      patch.errorCode ?? null,
      patch.errorMessage ?? null,
      patch.finished === true,
    ],
  );
}

export async function failWorkflow(
  pool: RevisionQueryable,
  workflow: BookAIWorkflowRow,
  failedJob: WorkflowProviderJobLinkRow,
): Promise<void> {
  await updateWorkflowProgress(pool, workflow, {
    status: 'needs_review',
    stage: 'needs_review',
    errorCode: failedJob.error_code ?? 'provider_job_failed',
    errorMessage: failedJob.error_message ?? `Workflow child job failed: ${failedJob.provider_job_id}`,
    progress: {
      failedProviderJobId: failedJob.provider_job_id,
      failedStage: failedJob.stage,
      failedPlanItemId: failedJob.plan_item_id,
      failedJobType: failedJob.job_type,
      failedJobStatus: failedJob.status,
      workflowReviewTargets: [reviewTargetForFailedLink(failedJob)],
    },
  });
  await pool.query('update library_books set analysis_status = $1, updated_at = now() where id = $2 and user_id = $3', [
    'needs_review',
    workflow.book_id,
    workflow.user_id,
  ]);
}

export async function updateRunningProgress(
  pool: pg.Pool,
  workflow: BookAIWorkflowRow,
  stage: string,
  links: readonly WorkflowProviderJobLinkRow[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await updateWorkflowProgress(pool, workflow, {
    stage,
    progress: {
      ...extra,
      childJobCounts: {
        queued: links.filter((link) => link.status === 'queued').length,
        running: links.filter((link) => link.status === 'running').length,
        succeeded: links.filter((link) => link.status === 'succeeded').length,
        failed: links.filter((link) => link.status === 'failed').length,
        cancelled: links.filter((link) => link.status === 'cancelled').length,
      },
    },
  });
}
