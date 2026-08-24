import type { Queue } from 'bullmq';
import { bookAIWorkflowId, bookAIWorkflowPlanIntegrityHash } from '@noveldesk/text-core/identity/workflow';
import type { BookAIWorkflowPlan } from '../../../../../src/providers/book-ai-workflow-plan';
import {
  resolveBookAIWorkflowDefinitionReference,
  type BookAIWorkflowDefinitionReference,
} from '../../../../../src/providers/book-ai-workflow-definition';
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

export interface StartBookAIWorkflowInput extends Partial<BookAIWorkflowDefinitionReference> {
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

export class ActiveBookAIWorkflowIdentityConflictError extends Error {
  readonly code = 'active_workflow_identity_conflict';

  constructor(
    readonly active: {
      readonly workflowId: string;
      readonly workflowDefinitionId: string;
      readonly workflowVersion: string;
      readonly planHash: string;
    },
    readonly requested: {
      readonly workflowDefinitionId: string;
      readonly workflowVersion: string;
      readonly planHash: string;
    },
  ) {
    super('A different AI workflow is already active for this book, provider, model, and content revision.');
    this.name = 'ActiveBookAIWorkflowIdentityConflictError';
  }
}

export async function startBookAIWorkflow(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  input: StartBookAIWorkflowInput,
): Promise<StartBookAIWorkflowResult> {
  const workflowDefinition = resolveBookAIWorkflowDefinitionReference(input);
  if (!workflowDefinition) throw new Error('Unsupported book AI workflow definition reference');
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
    if (active) {
      const exactIdentity =
        active.workflow_definition_id === workflowDefinition.workflowDefinitionId &&
        active.workflow_version === workflowDefinition.workflowVersion &&
        active.plan_hash === planHash;
      if (exactIdentity) return { workflow: active, reused: true };
      throw new ActiveBookAIWorkflowIdentityConflictError(
        {
          workflowId: active.id,
          workflowDefinitionId: active.workflow_definition_id,
          workflowVersion: active.workflow_version,
          planHash: active.plan_hash,
        },
        {
          workflowDefinitionId: workflowDefinition.workflowDefinitionId,
          workflowVersion: workflowDefinition.workflowVersion,
          planHash,
        },
      );
    }

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
      workflowDefinitionId: workflowDefinition.workflowDefinitionId,
      workflowVersion: workflowDefinition.workflowVersion,
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
