import pg from 'pg';
import { classifyProviderError } from '../providers/provider-error-classification.js';
import { jobCorrelationContext, runWithCorrelation } from './context.js';
import type { StructuredLogger } from './logger.js';
import { ObservabilityMetrics, workerHeartbeatIntervalMs } from './metrics.js';

interface ProviderJobObservabilityRow {
  job_type: string;
  status: string;
  workflow_id: string | null;
}

export async function observeProviderJobExecution(
  pool: pg.Pool,
  metrics: ObservabilityMetrics,
  logger: StructuredLogger,
  input: { jobId: string; attemptId: string },
  operation: () => Promise<void>,
): Promise<void> {
  const metadata = await loadProviderJobObservability(pool, input.jobId);
  const context = jobCorrelationContext({
    jobId: input.jobId,
    attemptId: input.attemptId,
    workflowId: metadata?.workflow_id ?? undefined,
  });

  return runWithCorrelation(context, async () => {
    const startedAt = performance.now();
    let failure: unknown;
    logger.info('provider_job_started', { jobType: metadata?.job_type ?? 'other' });
    try {
      await operation();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const finalState = await loadProviderJobObservability(pool, input.jobId);
      const classification = failure === undefined ? undefined : classifyProviderError(failure);
      const outcome = providerJobOutcome(finalState?.status, classification?.category);
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      await metrics.observeProviderJob({
        durationMs,
        jobType: metadata?.job_type,
        outcome,
        errorCategory: classification?.category,
      });
      logger.log(outcome === 'failed' ? 'error' : 'info', 'provider_job_finished', {
        jobType: metadata?.job_type ?? 'other',
        outcome,
        durationMs,
        ...(classification
          ? {
              errorCategory: classification.category,
              errorCode: classification.errorCode,
              retryable: classification.retryable,
            }
          : {}),
      });
    }
  });
}

export async function observeImportJobExecution(
  logger: StructuredLogger,
  jobId: string,
  operation: () => Promise<void>,
): Promise<void> {
  return runWithCorrelation(jobCorrelationContext({ jobId }), async () => {
    const startedAt = performance.now();
    logger.info('import_job_started');
    try {
      await operation();
      logger.info('import_job_finished', {
        outcome: 'succeeded',
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      logger.error('import_job_finished', {
        outcome: 'failed',
        durationMs: Math.round(performance.now() - startedAt),
        errorName: error instanceof Error ? error.name : 'Error',
      });
      throw error;
    }
  });
}

export function startWorkerProcessHeartbeat(
  metrics: Pick<ObservabilityMetrics, 'processHeartbeat'>,
  logger: StructuredLogger,
  intervalMs = workerHeartbeatIntervalMs(),
): { stop(): void } {
  let stopped = false;
  let writing = false;
  const writeHeartbeat = async () => {
    if (stopped || writing) return;
    writing = true;
    try {
      await metrics.processHeartbeat();
    } finally {
      writing = false;
    }
  };
  const timer = setInterval(() => void writeHeartbeat(), intervalMs);
  timer.unref();
  void writeHeartbeat();
  logger.info('worker_process_heartbeat_started', { intervalMs });
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function loadProviderJobObservability(
  pool: pg.Pool,
  jobId: string,
): Promise<ProviderJobObservabilityRow | undefined> {
  try {
    const result = await pool.query<ProviderJobObservabilityRow>(
      `
        select provider_job.job_type, provider_job.status, workflow_job.workflow_id
        from provider_jobs provider_job
        left join lateral (
          select workflow_id
          from book_ai_workflow_jobs
          where provider_job_id = provider_job.id
          order by created_at asc
          limit 1
        ) workflow_job on true
        where provider_job.id = $1
      `,
      [jobId],
    );
    return result.rows[0];
  } catch {
    return undefined;
  }
}

function providerJobOutcome(status: string | undefined, errorCategory: string | undefined): string {
  if (status === 'cancelled' || errorCategory === 'cancelled') return 'cancelled';
  if (status === 'failed' || errorCategory) return 'failed';
  if (status === 'succeeded') return 'succeeded';
  return 'skipped';
}
