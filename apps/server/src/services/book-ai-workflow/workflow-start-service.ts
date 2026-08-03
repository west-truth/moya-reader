import type { Queue } from 'bullmq';
import { bookAIWorkflowId, bookAIWorkflowPlanIntegrityHash } from '@noveldesk/text-core/identity/workflow';
import type { BookAIWorkflowPlan } from '../../../../../src/providers/book-ai-workflow-plan';
import type { ProviderRequestProfile } from '../provider-jobs/contracts.js';
import type pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { ensureCanonicalGraphRevision, lockBookRevisionState } from './revision-snapshot-repository.js';
import { enqueueGraphBootstrapJob } from './stage-advancement.js';
import { withBookAITransaction } from './transaction.js';
import type { BookAIWorkflowRow } from './workflow-contracts.js';
import {
  findActiveWorkflow,
  insertWorkflow,
  lockWorkflowStartKey,
  markBookWorkflowStarted,
} from './workflow-start-repository.js';

export interface StartBookAIWorkflowInput {
  readonly bookId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly plan: BookAIWorkflowPlan;
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly requestProfile: ProviderRequestProfile;
}

export interface StartBookAIWorkflowResult {
  readonly workflowId: string;
  readonly reused: boolean;
  readonly childAdmitted: boolean;
}

export async function startBookAIWorkflow(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  input: StartBookAIWorkflowInput,
): Promise<StartBookAIWorkflowResult> {
  const planHash = bookAIWorkflowPlanIntegrityHash(input.plan);
  const startedAt = new Date().toISOString();
  const transactionResult = await withBookAITransaction(pool, async (client) => {
    const locked = await lockBookRevisionState(client, config.defaultUserId, input.bookId);
    if (!locked) throw new Error(`Book not found for analysis workflow: ${input.bookId}`);
    const state = await ensureCanonicalGraphRevision(client, locked);
    const identity = {
      userId: config.defaultUserId,
      bookId: input.bookId,
      providerId: input.providerId,
      modelId: input.modelId,
      contentRevisionId: state.contentRevisionId,
    };
    await lockWorkflowStartKey(client, identity);
    const active = await findActiveWorkflow(client, identity);
    if (active) return { workflow: active, reused: true };

    const workflowId = bookAIWorkflowId({
      userId: config.defaultUserId,
      novelId: input.bookId,
      providerId: input.providerId,
      modelId: input.modelId,
      planHash,
      startedAt,
    });
    const workflow = await insertWorkflow(client, {
      id: workflowId,
      userId: config.defaultUserId,
      bookId: input.bookId,
      providerId: input.providerId,
      modelId: input.modelId,
      planHash,
      plan: input.plan,
      contentRevisionId: state.contentRevisionId,
      graphRevisionId: state.graphRevisionId,
      revisionFence: state.revisionFence,
      providerOptions: input.providerOptions,
    });
    await markBookWorkflowStarted(client, {
      userId: config.defaultUserId,
      bookId: input.bookId,
      contentRevisionId: state.contentRevisionId,
      fence: state.revisionFence,
    });
    return { workflow, reused: false };
  });

  if (transactionResult.reused) {
    return { workflowId: transactionResult.workflow.id, reused: true, childAdmitted: true };
  }
  const childAdmitted = await enqueueFirstGraphJob(
    pool,
    config,
    queue,
    transactionResult.workflow,
    input.plan,
    input.requestProfile,
  );
  return { workflowId: transactionResult.workflow.id, reused: false, childAdmitted };
}

async function enqueueFirstGraphJob(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  workflow: BookAIWorkflowRow,
  plan: BookAIWorkflowPlan,
  requestProfile: ProviderRequestProfile,
): Promise<boolean> {
  const firstWindow = plan.bundleWindows[0];
  if (!firstWindow) return true;
  if (
    requestProfile.id.length === 0 ||
    requestProfile.promptVersion.length === 0 ||
    requestProfile.schemaVersion.length === 0
  ) {
    throw new Error('Analysis workflow request profile is invalid');
  }
  return enqueueGraphBootstrapJob(pool, config, queue, workflow, firstWindow, undefined);
}
