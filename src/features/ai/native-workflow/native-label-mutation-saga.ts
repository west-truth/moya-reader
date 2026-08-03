import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { AnalysisArtifactRepository } from '../../../repositories/reader-repository';
import type { NativeAnalysisReviewPromotionCommand } from '../../../storage/native-analysis-workflow';
import {
  labelMutationCommandHash,
  normalizeApplyLabelCorrectionsCommandV2,
  type ApplyLabelCorrectionsCommandV2,
  type ApplyLabelCorrectionsResultV2,
} from '../../../providers/label-mutation-contract';
import type { NativeBookWorkflowBridge, NativeBookWorkflowView } from './contracts';

type LabelMutationRepository = Pick<AnalysisArtifactRepository, 'applyLabelCorrections'> & {
  promoteNativeAnalysisReview?(command: NativeAnalysisReviewPromotionCommand): Promise<ApplyLabelCorrectionsResultV2>;
};

export interface NativeLabelMutationSagaResult {
  readonly workflow: NativeBookWorkflowView;
  readonly mutation: ApplyLabelCorrectionsResultV2;
}

function requireSagaBridge(bridge: NativeBookWorkflowBridge) {
  if (!bridge.prepareLabelMutation || !bridge.finalizeLabelMutation) {
    throw new Error('Native label mutation saga is unavailable in this desktop build');
  }
  return {
    prepare: bridge.prepareLabelMutation.bind(bridge),
    finalize: bridge.finalizeLabelMutation.bind(bridge),
  };
}

function isReviewPromotionCommand(command: unknown): command is NativeAnalysisReviewPromotionCommand {
  return Boolean(
    command && typeof command === 'object' && (command as { kind?: unknown }).kind === 'native_review_promotion_v1',
  );
}

function sagaCommandHash(command: ApplyLabelCorrectionsCommandV2 | NativeAnalysisReviewPromotionCommand): string {
  return isReviewPromotionCommand(command) ? structuredIntegrityHash(command) : labelMutationCommandHash(command);
}

async function applyAndFinalize(
  workflow: NativeBookWorkflowView,
  bridge: NativeBookWorkflowBridge,
  repository: LabelMutationRepository,
): Promise<NativeLabelMutationSagaResult> {
  const pending = workflow.pendingLabelMutation;
  if (!pending) throw new Error('Native label mutation is not pending');
  if (sagaCommandHash(pending.command) !== pending.commandHash) {
    throw new Error('Native label mutation command hash changed before IndexedDB apply');
  }
  const reviewPromotion = isReviewPromotionCommand(pending.command);
  if (reviewPromotion && !repository.promoteNativeAnalysisReview) {
    throw new Error('Native analysis review promotion is unavailable');
  }
  const mutation = reviewPromotion
    ? await repository.promoteNativeAnalysisReview!(pending.command)
    : await repository.applyLabelCorrections(pending.command);
  const receiptHash = structuredIntegrityHash(mutation);
  const finalize = requireSagaBridge(bridge).finalize;
  return {
    mutation,
    workflow: await finalize({
      workflowId: workflow.id,
      expectedFence: workflow.fence,
      operationId: pending.operationId,
      commandHash: pending.commandHash,
      receiptHash,
      resumeAfterReview: reviewPromotion || undefined,
    }),
  };
}

export async function prepareNativeAnalysisReviewPromotionSaga(input: {
  readonly workflow: NativeBookWorkflowView;
  readonly command: NativeAnalysisReviewPromotionCommand;
  readonly bridge: NativeBookWorkflowBridge;
  readonly repository: LabelMutationRepository;
}): Promise<NativeLabelMutationSagaResult> {
  const commandHash = structuredIntegrityHash(input.command);
  const prepared = await requireSagaBridge(input.bridge).prepare({
    workflowId: input.workflow.id,
    expectedFence: input.workflow.fence,
    operationId: input.command.operationId,
    commandHash,
    command: input.command,
  });
  return applyAndFinalize(prepared, input.bridge, input.repository);
}

export async function prepareNativeLabelMutationSaga(input: {
  readonly workflow: NativeBookWorkflowView;
  readonly command: ApplyLabelCorrectionsCommandV2;
  readonly bridge: NativeBookWorkflowBridge;
  readonly repository: LabelMutationRepository;
}): Promise<NativeLabelMutationSagaResult> {
  const command = normalizeApplyLabelCorrectionsCommandV2(input.command);
  const commandHash = labelMutationCommandHash(command);
  const prepared = await requireSagaBridge(input.bridge).prepare({
    workflowId: input.workflow.id,
    expectedFence: input.workflow.fence,
    operationId: command.operationId,
    commandHash,
    command,
  });
  return applyAndFinalize(prepared, input.bridge, input.repository);
}

export async function recoverNativeLabelMutationSaga(input: {
  readonly workflow: NativeBookWorkflowView;
  readonly bridge: NativeBookWorkflowBridge;
  readonly repository: LabelMutationRepository;
}): Promise<NativeBookWorkflowView> {
  if (!input.workflow.pendingLabelMutation) return input.workflow;
  return (await applyAndFinalize(input.workflow, input.bridge, input.repository)).workflow;
}
