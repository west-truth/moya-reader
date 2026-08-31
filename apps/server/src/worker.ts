import { randomUUID } from 'node:crypto';
import { loadConfig, providerJobAdmissionLimits } from './config.js';
import { createPool } from './db/pool.js';
import {
  createImportQueue,
  createImportWorker,
  createProviderQueue,
  createProviderWorker,
  recoverStaleImportJobs,
  requeuePendingImportJobs,
  requeuePendingProviderJobs,
} from './queue.js';
import { processImportJob } from './services/import-service.js';
import {
  advanceBookAIWorkflowsForProviderJob,
  reconcileApprovedAnalysisReviews,
  reconcileTerminalBookAIWorkflowProviderJobs,
  refreshBookAIWorkflowTTSCacheReadinessForProviderJob,
} from './services/book-ai-workflow-service.js';
import { processProviderJob } from './services/provider-job-service.js';
import { maintainTTSCache } from './services/tts-cache-maintenance.js';
import { drainObjectDeleteOutbox } from './services/object-delete-outbox.js';
import {
  createStructuredLogger,
  metricsFromQueue,
  observeImportJobExecution,
  observeProviderJobExecution,
  startWorkerProcessHeartbeat,
} from './observability/index.js';

const config = loadConfig();
const pool = createPool(config);
const importQueue = createImportQueue(config);
const providerQueue = createProviderQueue(config);
const logger = createStructuredLogger({ service: 'worker' });
const metrics = metricsFromQueue(providerQueue, logger);
const heartbeat = startWorkerProcessHeartbeat(metrics, logger);
const reviewReconcilerOwner = `worker:${process.pid}:${randomUUID()}`;
let reviewReconcilePromise: Promise<void> | undefined;
let importRecoveryPromise: Promise<void> | undefined;
let providerRecoveryPromise: Promise<void> | undefined;
let ttsMaintenancePromise: Promise<void> | undefined;
let objectDeletePromise: Promise<void> | undefined;

function runReviewReconciler(): Promise<void> {
  if (reviewReconcilePromise) return reviewReconcilePromise;
  reviewReconcilePromise = (async () => {
    try {
      const summary = await reconcileApprovedAnalysisReviews(pool, config, providerQueue, {
        owner: reviewReconcilerOwner,
      });
      if (summary.claimed > 0) logger.info('analysis_reviews_reconciled', { ...summary });
    } catch (error) {
      logger.error('analysis_review_reconciler_error', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  })().finally(() => {
    reviewReconcilePromise = undefined;
  });
  return reviewReconcilePromise;
}

function runProviderAttemptRecovery(): Promise<void> {
  if (providerRecoveryPromise) return providerRecoveryPromise;
  providerRecoveryPromise = (async () => {
    try {
      const requeued = await requeuePendingProviderJobs(pool, providerQueue, providerJobAdmissionLimits(config));
      const reconciled = await reconcileTerminalBookAIWorkflowProviderJobs(pool, config, providerQueue);
      if (requeued > 0 || reconciled > 0) {
        logger.info('provider_attempts_recovered', { requeued, reconciled });
      }
    } catch (error) {
      logger.error('provider_attempt_recovery_error', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  })().finally(() => {
    providerRecoveryPromise = undefined;
  });
  return providerRecoveryPromise;
}

function runImportRecovery(): Promise<void> {
  if (importRecoveryPromise) return importRecoveryPromise;
  importRecoveryPromise = (async () => {
    try {
      const recovered = await recoverStaleImportJobs(pool, importQueue);
      if (recovered > 0) logger.info('stale_import_jobs_recovered', { count: recovered });
    } catch (error) {
      logger.error('import_job_recovery_error', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  })().finally(() => {
    importRecoveryPromise = undefined;
  });
  return importRecoveryPromise;
}

function runTTSCacheMaintenance(): Promise<void> {
  if (ttsMaintenancePromise) return ttsMaintenancePromise;
  ttsMaintenancePromise = maintainTTSCache(pool, config)
    .then((summary) => {
      if (summary.markedStale || summary.deleted || summary.failed) logger.info('tts_cache_maintained', { ...summary });
    })
    .catch((error) =>
      logger.error('tts_cache_maintenance_error', { errorName: error instanceof Error ? error.name : 'UnknownError' }),
    )
    .finally(() => {
      ttsMaintenancePromise = undefined;
    });
  return ttsMaintenancePromise;
}

function runObjectDeleteOutbox(): Promise<void> {
  if (objectDeletePromise) return objectDeletePromise;
  objectDeletePromise = drainObjectDeleteOutbox(pool, config)
    .then((summary) => {
      if (summary.deleted || summary.failed) logger.info('object_delete_outbox_drained', summary);
    })
    .catch((error) =>
      logger.error('object_delete_outbox_error', { errorName: error instanceof Error ? error.name : 'UnknownError' }),
    )
    .finally(() => {
      objectDeletePromise = undefined;
    });
  return objectDeletePromise;
}

const requeuedCount = await requeuePendingImportJobs(pool, importQueue);
if (requeuedCount) logger.info('pending_import_jobs_requeued', { count: requeuedCount });
await runImportRecovery();
const requeuedProviderCount = await requeuePendingProviderJobs(pool, providerQueue, providerJobAdmissionLimits(config));
if (requeuedProviderCount) logger.info('pending_provider_jobs_requeued', { count: requeuedProviderCount });
const reconciledWorkflowProviderCount = await reconcileTerminalBookAIWorkflowProviderJobs(pool, config, providerQueue);
if (reconciledWorkflowProviderCount)
  logger.info('terminal_workflow_provider_jobs_reconciled', { count: reconciledWorkflowProviderCount });
await runReviewReconciler();
await runTTSCacheMaintenance();
await runObjectDeleteOutbox();
const reviewReconcileTimer = setInterval(() => void runReviewReconciler(), 15_000);
reviewReconcileTimer.unref();
const importRecoveryTimer = setInterval(() => void runImportRecovery(), 60_000);
importRecoveryTimer.unref();
const providerRecoveryTimer = setInterval(() => void runProviderAttemptRecovery(), 30_000);
providerRecoveryTimer.unref();
const ttsMaintenanceTimer = setInterval(() => void runTTSCacheMaintenance(), 5 * 60_000);
ttsMaintenanceTimer.unref();
const objectDeleteTimer = setInterval(() => void runObjectDeleteOutbox(), 30_000);
objectDeleteTimer.unref();

const importWorker = createImportWorker(config, async (jobId, uploadId, attempt) => {
  await observeImportJobExecution(logger, jobId, () =>
    processImportJob(pool, config, jobId, uploadId, attempt, logger),
  );
});
const providerWorker = createProviderWorker(config, async (jobId, attempt) => {
  await observeProviderJobExecution(pool, metrics, logger, { jobId, attemptId: attempt.attemptId }, async () => {
    try {
      await processProviderJob(pool, config, jobId, {}, attempt);
    } finally {
      await advanceBookAIWorkflowsForProviderJob(pool, config, providerQueue, jobId);
      await refreshBookAIWorkflowTTSCacheReadinessForProviderJob(pool, config, jobId);
    }
  });
});

importWorker.on('error', (error) => logger.error('import_worker_error', { errorName: error.name }));
providerWorker.on('error', (error) => logger.error('provider_worker_error', { errorName: error.name }));

async function shutdown(): Promise<void> {
  clearInterval(reviewReconcileTimer);
  clearInterval(importRecoveryTimer);
  clearInterval(providerRecoveryTimer);
  clearInterval(ttsMaintenanceTimer);
  clearInterval(objectDeleteTimer);
  await reviewReconcilePromise;
  await importRecoveryPromise;
  await providerRecoveryPromise;
  await ttsMaintenancePromise;
  await objectDeletePromise;
  heartbeat.stop();
  await providerWorker.close();
  await importWorker.close();
  await providerQueue.close();
  await importQueue.close();
  await pool.end();
}

process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0));
});

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0));
});

logger.info('worker_started');
