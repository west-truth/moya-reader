import type { VoiceProfile } from '@noveldesk/contracts';
import type { TTSRenderSpec } from '../../../../../src/providers/tts-render-spec';
import type { ProviderJobRow } from '../provider-jobs/contracts.js';
import type { AnalysisInputRevision } from './analysis-input-contracts.js';
import type { RevisionQueryable } from './analysis-input-repository.js';
import { linkWorkflowJob } from './child-job-repository.js';
import { pinTTSInputRevision, type PinTTSInputRevisionInput } from './tts-input-builder.js';
import { findTTSOwningWorkflow } from './tts-workflow-repository.js';
import {
  insertTTSProviderJob,
  loadTTSProviderJob,
  requeueTTSProviderJob,
  type TTSProviderJobRow,
} from './tts-job-repository.js';

export async function pinAndLinkTTSInputRevision(
  db: RevisionQueryable,
  input: PinTTSInputRevisionInput & { readonly cacheKey: string },
): Promise<AnalysisInputRevision> {
  const workflowId = await findTTSOwningWorkflow(db, {
    userId: input.job.user_id,
    bookId: input.job.book_id,
    chapterId: input.job.chapter_id ?? '',
  });
  const revision = await pinTTSInputRevision(db, { ...input, workflowId });
  if (workflowId) {
    await linkWorkflowJob(db, {
      workflowId,
      providerJobId: input.job.id,
      stage: 'tts_synthesis',
      planItemId: input.cacheKey,
      sequence: 0,
    });
  }
  return revision;
}

export async function preparePinnedTTSWorkflowJob(
  db: RevisionQueryable,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly bookId: string;
    readonly chapterId: string;
    readonly providerId: string;
    readonly modelId?: string;
    readonly inputHash: string;
    readonly progress: Readonly<Record<string, unknown>>;
    readonly force: boolean;
    readonly cacheKey: string;
    readonly renderSpec: TTSRenderSpec;
    readonly renderSpecHash: string;
    readonly voiceProfile: VoiceProfile;
    readonly providerOptions: Readonly<Record<string, unknown>>;
    readonly capabilitySnapshot?: PinTTSInputRevisionInput['capabilitySnapshot'];
    readonly taskProfileSnapshot?: PinTTSInputRevisionInput['taskProfileSnapshot'];
  },
): Promise<TTSProviderJobRow> {
  let row = await loadTTSProviderJob(db, input);
  if (!row) row = await insertTTSProviderJob(db, input);
  if (!row) row = await loadTTSProviderJob(db, input);
  if (!row) throw new Error('TTS provider job could not be created');

  if (row.status === 'failed' || row.status === 'cancelled' || (input.force && row.status === 'succeeded')) {
    row = (await requeueTTSProviderJob(db, row, input.userId, input.progress)) ?? row;
  }
  if (row.status === 'queued' || row.status === 'running') {
    const job: ProviderJobRow = {
      id: row.id,
      user_id: input.userId,
      book_id: row.book_id,
      chapter_id: row.chapter_id,
      job_type: row.job_type,
      provider_id: row.provider_id,
      model_id: row.model_id,
      input_hash: row.input_hash,
      status: row.status,
      progress: row.progress,
      current_attempt_id: row.current_attempt_id,
    };
    await pinAndLinkTTSInputRevision(db, {
      job,
      cacheKey: input.cacheKey,
      renderSpec: input.renderSpec,
      renderSpecHash: input.renderSpecHash,
      voiceProfile: input.voiceProfile,
      providerOptions: input.providerOptions,
      capabilitySnapshot: input.capabilitySnapshot,
      taskProfileSnapshot: input.taskProfileSnapshot,
    });
  }
  return row;
}
