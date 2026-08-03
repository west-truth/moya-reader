import type { Queue } from 'bullmq';
import pg from 'pg';

export async function removeProviderQueueJob(
  pool: pg.Pool,
  providerQueue: Queue | undefined,
  jobId: string,
  userId: string,
  attemptId: string | null,
): Promise<{
  attempted: boolean;
  removed: boolean;
  error?: string;
}> {
  if (!providerQueue) return { attempted: false, removed: false };
  try {
    if (!attemptId) return { attempted: true, removed: false };
    const attempt = await pool.query<{ bullmq_job_id: string }>(
      `
        select attempt.bullmq_job_id
        from provider_job_attempts attempt
        join provider_jobs job on job.id = attempt.provider_job_id
        where job.id = $1 and job.user_id = $2 and attempt.id = $3
      `,
      [jobId, userId, attemptId],
    );
    const bullmqJobId = attempt.rows[0]?.bullmq_job_id;
    if (!bullmqJobId) return { attempted: true, removed: false };
    const queuedJob = await providerQueue.getJob(bullmqJobId);
    if (!queuedJob) return { attempted: true, removed: false };
    await queuedJob.remove();
    return { attempted: true, removed: true };
  } catch {
    return {
      attempted: true,
      removed: false,
      error: 'queue_remove_failed',
    };
  }
}
