import type { Queue } from 'bullmq';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { recordValue } from '../provider-jobs/job-progress.js';
import { withBookAITransaction } from './transaction.js';
import {
  cancelWorkflowProviderJob,
  cancelWorkflowRow,
  loadActiveWorkflowJobs,
  loadBullmqJobId,
  markCancelledWorkflowBook,
  updateCancelledJobProgress,
  updateCancelledWorkflowQueueRemovals,
} from './workflow-cancellation-repository.js';
import { loadWorkflow } from './workflow-repository.js';

export type CancelBookAIWorkflowResult =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'terminal'; readonly status: string }
  | { readonly kind: 'cancelled'; readonly workflowId: string };

async function removeQueueJob(
  pool: pg.Pool,
  queue: Queue | undefined,
  jobId: string,
  userId: string,
  attemptId: string | null,
): Promise<{ attempted: boolean; removed: boolean; error?: string }> {
  if (!queue) return { attempted: false, removed: false };
  try {
    const bullmqJobId = await loadBullmqJobId(pool, jobId, userId, attemptId);
    if (!bullmqJobId) return { attempted: true, removed: false };
    const queuedJob = await queue.getJob(bullmqJobId);
    if (!queuedJob) return { attempted: true, removed: false };
    await queuedJob.remove();
    return { attempted: true, removed: true };
  } catch {
    return { attempted: true, removed: false, error: 'queue_remove_failed' };
  }
}

export async function cancelBookAIWorkflow(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  workflowId: string,
): Promise<CancelBookAIWorkflowResult> {
  const loaded = await loadWorkflow(pool, config, workflowId);
  if (!loaded) return { kind: 'not_found' };
  if (loaded.row.status === 'cancelled') return { kind: 'cancelled', workflowId };
  if (loaded.row.status === 'succeeded' || loaded.row.status === 'failed') {
    return { kind: 'terminal', status: loaded.row.status };
  }
  const cancelledAt = new Date().toISOString();
  const cancelledJobs = await withBookAITransaction(pool, async (client) => {
    const current = await loadWorkflow(client, config, workflowId);
    if (!current) return [];
    const jobs = await loadActiveWorkflowJobs(client, workflowId, config.defaultUserId);
    const cancelled = [];
    for (const job of jobs) {
      const progress = {
        ...recordValue(job.progress),
        cancelled: true,
        cancelRequestedAt: cancelledAt,
        cancelledByWorkflowId: workflowId,
      };
      const row = await cancelWorkflowProviderJob(client, job, progress);
      if (row) cancelled.push(row);
    }
    await cancelWorkflowRow(client, current.row, {
      ...recordValue(current.row.progress),
      cancelled: true,
      cancelRequestedAt: cancelledAt,
      cancelledProviderJobIds: cancelled.map((job) => job.id),
    });
    await markCancelledWorkflowBook(client, current.row);
    return cancelled;
  });

  const queueRemovals: Record<string, unknown> = {};
  for (const job of cancelledJobs) {
    const queueRemoval = await removeQueueJob(pool, queue, job.id, job.user_id, job.current_attempt_id ?? null);
    queueRemovals[job.id] = queueRemoval;
    await updateCancelledJobProgress(pool, job, {
      ...recordValue(job.progress),
      queueRemoval,
    });
  }
  await updateCancelledWorkflowQueueRemovals(pool, workflowId, config.defaultUserId, queueRemovals);
  return { kind: 'cancelled', workflowId };
}
