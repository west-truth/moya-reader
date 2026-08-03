import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { classifyProviderError } from '../../providers/provider-error-classification.js';
import { processChapterLabelingJob } from './chapter-labeling-handler.js';
import { processCharacterBundleAnalysisJob, processCharacterGraphMergeJob } from './character-graph-handlers.js';
import {
  ChapterLabelingValidationError,
  ProviderJobCancelledError,
  type ProviderJobExecutionIdentity,
  type ProviderJobServiceDeps,
} from './contracts.js';
import {
  assertProviderJobNotCancelled,
  claimProviderJob,
  createProviderJobAbortMonitor,
  markProviderJobDispatchStarted,
  quarantineProviderJobLateResult,
  updateProviderJobProgress,
} from './job-lifecycle.js';
import { recordValue } from './job-progress.js';
import { processTTSJob } from './tts-handler.js';
import { processSpeakerAttributionJob } from './speaker-attribution-handler.js';
import { AnalysisInputStaleError } from '../book-ai-workflow/analysis-input-contracts.js';
import { loadAnalysisInputRevisionForJob } from '../book-ai-workflow/analysis-input-repository.js';
import { providerExecutionMetadataFromError } from '../../../../../src/providers/provider-execution';

function workflowIdFromProgress(progress: unknown): string | undefined {
  const source = recordValue(recordValue(progress)?.sourceContext);
  return typeof source?.workflowId === 'string' && source.workflowId.trim() ? source.workflowId : undefined;
}

export async function processProviderJob(
  pool: pg.Pool,
  config: ServerConfig,
  jobId: string,
  deps: ProviderJobServiceDeps = {},
  execution?: ProviderJobExecutionIdentity,
): Promise<void> {
  const job = await claimProviderJob(pool, jobId, config.defaultUserId, execution);
  if (!job) return;

  const abortMonitor = createProviderJobAbortMonitor(pool, job, deps.cancellationPollMs);
  try {
    await assertProviderJobNotCancelled(pool, job);
    const requiresPinnedInput = Boolean(job.analysis_input_revision_id || workflowIdFromProgress(job.progress));
    const inputRevision = requiresPinnedInput ? await loadAnalysisInputRevisionForJob(pool, job.id) : undefined;
    if (requiresPinnedInput && !inputRevision) {
      throw new AnalysisInputStaleError(
        'analysis_source_stale',
        `Provider job is missing its immutable input revision: ${job.id}`,
      );
    }
    if (
      ![
        'tts_synthesis',
        'character_bundle_analysis',
        'character_graph_merge',
        'chapter_segment_labeling',
        'speaker_attribution_v3',
        'chapter_label_repair',
      ].includes(job.job_type)
    ) {
      throw new Error(`Unsupported provider job type: ${job.job_type}`);
    }
    const executionDeps: ProviderJobServiceDeps = {
      ...deps,
      beforeProviderDispatch: () => markProviderJobDispatchStarted(pool, job),
    };
    if (job.job_type === 'tts_synthesis') {
      await processTTSJob(pool, config, job, executionDeps, abortMonitor.signal, inputRevision);
      return;
    }
    if (job.job_type === 'character_bundle_analysis') {
      await processCharacterBundleAnalysisJob(pool, config, job, executionDeps, abortMonitor.signal, inputRevision);
      return;
    }
    if (job.job_type === 'character_graph_merge') {
      await processCharacterGraphMergeJob(pool, config, job, executionDeps, abortMonitor.signal, inputRevision);
      return;
    }
    if (job.job_type === 'speaker_attribution_v3') {
      await processSpeakerAttributionJob(pool, config, job, executionDeps, abortMonitor.signal, inputRevision);
      return;
    }
    await processChapterLabelingJob(pool, config, job, executionDeps, abortMonitor.signal, inputRevision);
  } catch (error) {
    if (error instanceof AnalysisInputStaleError) {
      await updateProviderJobProgress(pool, job, {
        status: 'cancelled',
        stage: 'stale',
        mergeProgress: {
          stale: true,
          staleReason: error.code,
        },
        errorCode: error.code,
        errorMessage: error.message,
        finishedAt: true,
      });
      return;
    }
    if (error instanceof ProviderJobCancelledError) {
      await quarantineProviderJobLateResult(pool, job, 'late_result_after_lease_loss_or_cancel');
      await updateProviderJobProgress(pool, job, {
        status: 'cancelled',
        stage: 'cancelled',
        errorCode: 'provider_job_cancelled',
        errorMessage: 'Provider job cancelled',
        finishedAt: true,
      });
      return;
    }
    try {
      await assertProviderJobNotCancelled(pool, job);
    } catch (cancelError) {
      if (cancelError instanceof ProviderJobCancelledError) {
        await quarantineProviderJobLateResult(pool, job, 'late_result_after_lease_loss_or_cancel');
        await updateProviderJobProgress(pool, job, {
          status: 'cancelled',
          stage: 'cancelled',
          errorCode: 'provider_job_cancelled',
          errorMessage: 'Provider job cancelled',
          finishedAt: true,
        });
        return;
      }
      throw cancelError;
    }
    const classification = classifyProviderError(error);
    const validation = error instanceof ChapterLabelingValidationError ? error.validation : undefined;
    const quality = error instanceof ChapterLabelingValidationError ? error.quality : undefined;
    const providerExecution = providerExecutionMetadataFromError(error);
    const failedCurrentAttempt = await updateProviderJobProgress(pool, job, {
      status: 'failed',
      stage: 'failed',
      mergeProgress: {
        failed: true,
        errorCategory: classification.category,
        retryable: classification.retryable,
        ...(validation ? { validation } : {}),
        ...(quality ? { quality } : {}),
        ...(providerExecution ? { providerExecution } : {}),
      },
      errorCode: classification.errorCode,
      errorMessage: classification.safeMessage,
      finishedAt: true,
    });
    if (failedCurrentAttempt && job.job_type !== 'tts_synthesis') {
      await pool.query(
        'update library_books set analysis_status = $1, updated_at = now() where id = $2 and user_id = $3',
        ['failed', job.book_id, job.user_id],
      );
    }
    throw error;
  } finally {
    abortMonitor.stop();
  }
}
