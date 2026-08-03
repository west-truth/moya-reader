import type { Queue } from 'bullmq';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import type { BookAIWorkflowPlan } from '../../../../../src/providers/book-ai-workflow-plan';
import {
  enqueueChapterLabelingJobs,
  enqueueChapterLabelRepairJob,
  enqueueGraphBootstrapJob,
  enqueueGraphMergeJob,
} from './stage-advancement.js';
import type { WorkflowReviewTarget } from './workflow-contracts.js';
import { failWorkflow, loadWorkflow, updateRunningProgress, updateWorkflowProgress } from './workflow-repository.js';
import {
  pendingLinks,
  providerJobIsTerminal,
  reviewTargetsForTTSReadiness,
  sortedStageLinks,
  succeededLinks,
  terminalFailure,
  recordValue,
} from './workflow-state.js';
import { verifyTTSReadiness } from './tts-readiness.js';

export async function advanceBookAIWorkflow(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  workflowId: string,
): Promise<void> {
  const loaded = await loadWorkflow(pool, config, workflowId);
  if (!loaded) return;
  const { row: workflow, links } = loaded;
  if (
    workflow.status === 'succeeded' ||
    workflow.status === 'needs_review' ||
    workflow.status === 'failed' ||
    workflow.status === 'cancelled'
  )
    return;
  const plan = workflow.plan as BookAIWorkflowPlan;
  const bootstrapLinks = sortedStageLinks(links.filter((link) => link.stage === 'character_graph_bootstrap'));
  const bootstrapFailure = terminalFailure(bootstrapLinks);
  if (bootstrapFailure) {
    await failWorkflow(pool, workflow, bootstrapFailure);
    return;
  }
  if (pendingLinks(bootstrapLinks).length > 0) {
    await updateRunningProgress(pool, workflow, 'building_graph', bootstrapLinks, {
      totalBundleWindows: plan.bundleWindows.length,
    });
    return;
  }
  if (bootstrapLinks.length < plan.bundleWindows.length) {
    const nextWindow = plan.bundleWindows[bootstrapLinks.length];
    const admitted = await enqueueGraphBootstrapJob(pool, config, queue, workflow, nextWindow, bootstrapLinks.at(-1));
    if (!admitted) return;
    const refreshed = await loadWorkflow(pool, config, workflowId);
    const linkedJob = refreshed?.links.find(
      (link) => link.stage === 'character_graph_bootstrap' && link.plan_item_id === nextWindow.id,
    );
    if (linkedJob && providerJobIsTerminal(linkedJob)) await advanceBookAIWorkflow(pool, config, queue, workflowId);
    return;
  }

  let mergeLinks = links.filter((link) => link.stage === 'character_graph_merge');
  if (mergeLinks.length === 0) {
    const admitted = await enqueueGraphMergeJob(pool, config, queue, workflow, succeededLinks(bootstrapLinks));
    if (!admitted) return;
    const refreshed = await loadWorkflow(pool, config, workflowId);
    mergeLinks = refreshed?.links.filter((link) => link.stage === 'character_graph_merge') ?? [];
    if (mergeLinks.some(providerJobIsTerminal)) await advanceBookAIWorkflow(pool, config, queue, workflowId);
    return;
  }
  const mergeFailure = terminalFailure(mergeLinks);
  if (mergeFailure) {
    await failWorkflow(pool, workflow, mergeFailure);
    return;
  }
  const mergeLink = mergeLinks[0];
  if (mergeLink.status !== 'succeeded') {
    await updateRunningProgress(pool, workflow, 'merging_graph', mergeLinks, {
      graphMergeJobId: mergeLink.provider_job_id,
    });
    return;
  }

  const labelingWindowIds = new Set(plan.labelingWindows.map((window) => window.id));
  let labelingLinks = links.filter(
    (link) => link.stage === 'chapter_labeling' && labelingWindowIds.has(link.plan_item_id),
  );
  const repairLinks = sortedStageLinks(links.filter((link) => link.stage === 'chapter_label_repair'));
  const repairFailure = terminalFailure(repairLinks);
  if (repairFailure) {
    await failWorkflow(pool, workflow, repairFailure);
    return;
  }
  if (pendingLinks(repairLinks).length > 0) {
    await updateRunningProgress(pool, workflow, 'labeling_chapters', repairLinks, {
      totalLabelingChapters: plan.labelingChapters.length,
      totalLabelingWindows: plan.labelingWindows.length,
      repairChildJobIds: repairLinks.map((link) => link.provider_job_id),
    });
    return;
  }
  const repairedLabelingWindowIds = new Set(
    succeededLinks(repairLinks)
      .map((link) => recordValue(recordValue(link.progress)?.sourceContext)?.labelingWindowId)
      .filter((value): value is string => typeof value === 'string' && labelingWindowIds.has(value)),
  );
  const labelingFailure = terminalFailure(
    labelingLinks.filter((link) => !repairedLabelingWindowIds.has(link.plan_item_id)),
  );
  if (labelingFailure) {
    const autoRepair = recordValue(recordValue(labelingFailure.progress)?.autoRepair);
    if (
      labelingFailure.status === 'failed' &&
      autoRepair?.enabled === true &&
      autoRepair.delegated === true &&
      typeof autoRepair.candidateArtifactId === 'string'
    ) {
      const admitted = await enqueueChapterLabelRepairJob(pool, config, queue, workflow, labelingFailure);
      if (!admitted) return;
      const refreshed = await loadWorkflow(pool, config, workflowId);
      const repairLink = refreshed?.links.find(
        (link) =>
          link.stage === 'chapter_label_repair' &&
          recordValue(recordValue(link.progress)?.sourceContext)?.labelingWindowId === labelingFailure.plan_item_id,
      );
      if (repairLink && providerJobIsTerminal(repairLink)) {
        await advanceBookAIWorkflow(pool, config, queue, workflowId);
      }
      return;
    }
    await failWorkflow(pool, workflow, labelingFailure);
    return;
  }
  if (pendingLinks(labelingLinks).length > 0) {
    await updateRunningProgress(pool, workflow, 'labeling_chapters', labelingLinks, {
      totalLabelingChapters: plan.labelingChapters.length,
      totalLabelingWindows: plan.labelingWindows.length,
    });
    return;
  }
  const succeededLabelingWindowIds = new Set([
    ...succeededLinks(labelingLinks).map((link) => link.plan_item_id),
    ...repairedLabelingWindowIds,
  ]);
  if (succeededLabelingWindowIds.size < plan.labelingWindows.length) {
    const nextWindow = plan.labelingWindows.find((window) => !succeededLabelingWindowIds.has(window.id));
    if (!nextWindow) {
      await updateWorkflowProgress(pool, workflow, {
        status: 'needs_review',
        stage: 'needs_review',
        errorCode: 'workflow_labeling_window_mismatch',
        errorMessage: 'The workflow labeling window links do not match the current plan.',
        progress: {
          failedStage: 'chapter_labeling',
          workflowReviewTargets: [
            {
              id: 'workflow:labeling_window_mismatch',
              kind: 'tts_readiness_failed',
              stage: 'chapter_labeling',
              errorCode: 'workflow_labeling_window_mismatch',
              message: 'The workflow labeling window links do not match the current plan.',
              recommendedAction: 'retry_workflow',
            } satisfies WorkflowReviewTarget,
          ],
        },
      });
      return;
    }
    const admitted = await enqueueChapterLabelingJobs(pool, config, queue, workflow, plan, mergeLink, [nextWindow]);
    if (!admitted) return;
    const refreshed = await loadWorkflow(pool, config, workflowId);
    labelingLinks =
      refreshed?.links.filter(
        (link) => link.stage === 'chapter_labeling' && labelingWindowIds.has(link.plan_item_id),
      ) ?? [];
    const linkedJob = labelingLinks.find((link) => link.plan_item_id === nextWindow.id);
    if (linkedJob && providerJobIsTerminal(linkedJob)) await advanceBookAIWorkflow(pool, config, queue, workflowId);
    return;
  }
  const ttsReadiness = await verifyTTSReadiness(pool, workflow, plan);
  if (!ttsReadiness.ok) {
    await updateWorkflowProgress(pool, workflow, {
      status: 'needs_review',
      stage: 'needs_review',
      errorCode: ttsReadiness.errorCode ?? 'tts_readiness_failed',
      errorMessage: ttsReadiness.message ?? 'TTS readiness verification failed.',
      progress: {
        failedStage: 'tts_ready_verification',
        ttsReadiness,
        workflowReviewTargets: reviewTargetsForTTSReadiness(plan, ttsReadiness),
      },
    });
    await pool.query(
      'update library_books set analysis_status = $1, updated_at = now() where id = $2 and user_id = $3',
      ['needs_review', workflow.book_id, workflow.user_id],
    );
    return;
  }
  await updateWorkflowProgress(pool, workflow, {
    status: 'succeeded',
    stage: 'ready_for_tts',
    finished: true,
    progress: {
      totalBundleWindows: plan.bundleWindows.length,
      totalLabelingChapters: plan.labelingChapters.length,
      totalLabelingWindows: plan.labelingWindows.length,
      readyForTtsChapterIds: plan.ttsReady.chapterIds,
      ttsReadiness,
    },
  });
  await pool.query('update library_books set analysis_status = $1, updated_at = now() where id = $2 and user_id = $3', [
    'ready',
    workflow.book_id,
    workflow.user_id,
  ]);
}
