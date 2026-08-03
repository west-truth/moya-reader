import type { Queue } from 'bullmq';
import pg from 'pg';
import { providerJobAdmissionLimits, type ServerConfig } from '../../config.js';
import { enqueueProviderJob } from '../../queue.js';
import type { BookAIWorkflowPlan } from '../../../../../src/providers/book-ai-workflow-plan';
import type { BookAIWorkflowRow, ProviderJobStatus, WorkflowProviderJobLinkRow } from './workflow-contracts.js';
import { linkedWorkflowIds, loadWorkflow } from './workflow-repository.js';
import {
  dedupeLinksByProviderJobId,
  hasUnresolvedManualReview,
  labelingWindowIdsForMissingParagraphs,
  recordValue,
  sortedStageLinks,
} from './workflow-state.js';
import { refreshBookAIWorkflowTTSCacheReadiness } from './tts-readiness.js';
import { advanceBookAIWorkflow } from './workflow-orchestrator.js';

export async function resumeBookAIWorkflow(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  workflowId: string,
): Promise<{ row: BookAIWorkflowRow; links: WorkflowProviderJobLinkRow[] } | undefined> {
  const loaded = await loadWorkflow(pool, config, workflowId);
  if (!loaded) return undefined;
  const { row: workflow, links } = loaded;
  if (workflow.status !== 'needs_review' && workflow.status !== 'failed') return loaded;
  if (hasUnresolvedManualReview(links)) return loaded;
  const plan = workflow.plan as BookAIWorkflowPlan;
  const progress = recordValue(workflow.progress);
  const failedProviderJobId =
    typeof progress?.failedProviderJobId === 'string' ? progress.failedProviderJobId : undefined;
  const allFailedLinks = sortedStageLinks(
    links.filter((link) => link.status === 'failed' || link.status === 'cancelled'),
  );
  const failedLinks = failedProviderJobId
    ? allFailedLinks.filter((link) => link.provider_job_id === failedProviderJobId)
    : allFailedLinks;
  const missingLabelingWindowIds = labelingWindowIdsForMissingParagraphs(progress, plan);
  const missingLabelingLinks = sortedStageLinks(
    links.filter(
      (link) =>
        link.stage === 'chapter_labeling' &&
        missingLabelingWindowIds.has(link.plan_item_id) &&
        link.status !== 'queued' &&
        link.status !== 'running',
    ),
  );
  const retryLinks = dedupeLinksByProviderJobId([...failedLinks, ...missingLabelingLinks]);
  const retryCount = Number(progress?.retryCount ?? 0);
  const retryRequestedAt = new Date().toISOString();
  const retryStage =
    failedLinks[0]?.stage ?? (missingLabelingLinks.length > 0 ? 'chapter_labeling' : progress?.failedStage);
  const reviewTargets = Array.isArray(progress?.workflowReviewTargets)
    ? progress.workflowReviewTargets.filter(
        (target): target is Record<string, unknown> =>
          Boolean(target) && typeof target === 'object' && !Array.isArray(target),
      )
    : [];
  await pool.query(
    `
      update book_ai_workflows
      set status = 'running',
          stage = case
            when $3 = 'character_graph_bootstrap' then 'building_graph'
            when $3 = 'character_graph_merge' then 'merging_graph'
            when $3 = 'chapter_labeling' then 'labeling_chapters'
            when $3 = 'chapter_label_repair' then 'labeling_chapters'
            when $3 = 'tts_ready_verification' then 'labeling_chapters'
            else 'building_graph'
          end,
          progress = $4::jsonb,
          error_code = null,
          error_message = null,
          finished_at = null,
          updated_at = now()
      where id = $1 and user_id = $2
    `,
    [
      workflow.id,
      workflow.user_id,
      retryStage,
      JSON.stringify({
        ...progress,
        failedProviderJobId: undefined,
        failedStage: undefined,
        failedPlanItemId: undefined,
        failedJobType: undefined,
        failedJobStatus: undefined,
        workflowReviewTargets: undefined,
        retriedReviewTargetIds: reviewTargets
          .map((target) => (typeof target.id === 'string' ? target.id : undefined))
          .filter((id): id is string => Boolean(id)),
        retryCount: retryCount + 1,
        retryRequestedAt,
        retriedProviderJobIds: retryLinks.map((link) => link.provider_job_id),
        retriedLabelingWindowIds: retryLinks
          .map((link) =>
            link.stage === 'chapter_labeling'
              ? link.plan_item_id
              : recordValue(recordValue(link.progress)?.sourceContext)?.labelingWindowId,
          )
          .filter((value): value is string => typeof value === 'string'),
        retryReason:
          missingLabelingLinks.length > 0 && failedLinks.length === 0
            ? 'missing_planned_paragraph_labels'
            : 'failed_child_jobs',
        retryTransition: 'retry_same_request',
      }),
    ],
  );
  for (const link of retryLinks) {
    const workflowRetry = {
      workflowId: workflow.id,
      retryCount: retryCount + 1,
      retryRequestedAt,
      transition: 'retry_same_request',
    };
    const retried = await pool.query<{ id: string }>(
      `
        update provider_jobs
        set status = 'queued',
            stage = 'queued',
            error_code = null,
            error_message = null,
            started_at = null,
            finished_at = null,
            progress = jsonb_set(coalesce(progress, '{}'::jsonb), '{workflowRetry}', $3::jsonb, true),
            updated_at = now()
        where id = $1
          and user_id = $2
          and status = $4
          and current_attempt_id is not distinct from $5
        returning id
      `,
      [
        link.provider_job_id,
        workflow.user_id,
        JSON.stringify(workflowRetry),
        link.status,
        link.current_attempt_id ?? null,
      ],
    );
    if (queue && retried.rows[0]) {
      await enqueueProviderJob(pool, queue, link.provider_job_id, providerJobAdmissionLimits(config));
    }
  }
  if (retryLinks.length === 0) await advanceBookAIWorkflow(pool, config, queue, workflow.id);
  return loadWorkflow(pool, config, workflowId);
}

export async function advanceBookAIWorkflowsForProviderJob(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  providerJobId: string,
): Promise<void> {
  const workflowIds = await linkedWorkflowIds(pool, config, providerJobId);
  for (const workflowId of workflowIds) {
    await advanceBookAIWorkflow(pool, config, queue, workflowId);
  }
}

export async function reconcileTerminalBookAIWorkflowProviderJobs(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
): Promise<number> {
  const result = await pool.query<{ provider_job_id: string }>(
    `
      select distinct wj.provider_job_id
      from book_ai_workflow_jobs wj
      join provider_jobs pj on pj.id = wj.provider_job_id
      join book_ai_workflows w on w.id = wj.workflow_id
      where w.user_id = $1
        and w.status = 'running'
        and pj.status in ('succeeded', 'failed', 'cancelled')
      order by wj.provider_job_id asc
    `,
    [config.defaultUserId],
  );
  for (const row of result.rows) {
    await advanceBookAIWorkflowsForProviderJob(pool, config, queue, row.provider_job_id);
  }
  return result.rowCount ?? result.rows.length;
}

export async function refreshBookAIWorkflowTTSCacheReadinessForProviderJob(
  pool: pg.Pool,
  config: ServerConfig,
  providerJobId: string,
): Promise<number> {
  const job = await pool.query<{ book_id: string; job_type: string; status: ProviderJobStatus }>(
    `
      select book_id, job_type, status
      from provider_jobs
      where id = $1 and user_id = $2
    `,
    [providerJobId, config.defaultUserId],
  );
  const row = job.rows[0];
  if (!row || row.job_type !== 'tts_synthesis' || row.status !== 'succeeded') return 0;

  const workflows = await pool.query<{ id: string }>(
    `
      select id
      from book_ai_workflows
      where book_id = $1
        and user_id = $2
        and status = 'succeeded'
        and stage in ('ready_for_tts', 'audio_cache_ready')
      order by created_at desc
    `,
    [row.book_id, config.defaultUserId],
  );
  for (const workflow of workflows.rows) {
    await refreshBookAIWorkflowTTSCacheReadiness(pool, config, workflow.id);
  }
  return workflows.rows.length;
}
