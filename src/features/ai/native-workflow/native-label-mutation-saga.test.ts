import { describe, expect, it, vi } from 'vitest';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { ApplyLabelCorrectionsCommandV2 } from '../../../providers/label-mutation-contract';
import type { NativeBookWorkflowBridge, NativeBookWorkflowView, NativeLabelMutationPrepareRequest } from './contracts';
import {
  prepareNativeAnalysisReviewPromotionSaga,
  prepareNativeLabelMutationSaga,
  recoverNativeLabelMutationSaga,
} from './native-label-mutation-saga';

const command: ApplyLabelCorrectionsCommandV2 = {
  operationId: 'operation_1',
  bookId: 'book_1',
  chapterId: 'chapter_1',
  createdAt: '2026-07-11T00:00:00.000Z',
  expected: {
    contentRevisionId: 'content_1',
    correctionRevisionId: 'corrections_1',
    segmentCollectionRevision: 'segments_1',
  },
  edits: [
    {
      segmentId: 'segment_1',
      expectedSegmentHash: 'segment_hash_1',
      patch: { emotion: 'sad' },
      intent: { kind: 'segment_only' },
    },
  ],
};

const reviewCommand = {
  kind: 'native_review_promotion_v1' as const,
  operationId: 'review_operation_1',
  artifactId: 'review_artifact_1',
  expectedReviewRevision: 2,
  candidateHash: 'sha256:candidate',
  editIntentsHash: 'sha256:intents',
  approvedAt: '2026-07-11T00:00:00.000Z',
};

function workflow(overrides: Partial<NativeBookWorkflowView> = {}): NativeBookWorkflowView {
  return {
    schemaVersion: 2,
    id: 'workflow_1',
    idempotencyKey: 'key_1',
    novelId: 'book_1',
    contentRevision: 'content_1',
    planHash: 'plan_1',
    payloadHash: 'payload_1',
    status: 'needs_review',
    currentStage: 'chapter_labeling',
    fence: 4,
    jobs: [],
    checkpoints: [],
    readinessOutcome: 'needs_review',
    reviewItems: [{}],
    errorCode: 'review_required',
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function harness() {
  const mutation = {
    operationId: command.operationId,
    revisions: { segmentCollectionRevision: 'segments_2', correctionRevisionId: 'corrections_2' },
    updatedSegmentIds: ['segment_1'],
    createdCorrectionIds: ['correction_1'],
    invalidation: { obsoleteReviewArtifactIds: [], staleTTSRenderItemIds: ['segment_1'] },
    syncEventIds: ['sync_1'],
  };
  const prepareLabelMutation = vi.fn(async (request: NativeLabelMutationPrepareRequest) =>
    workflow({
      fence: 5,
      pendingLabelMutation: {
        operationId: request.operationId,
        commandHash: request.commandHash,
        command: request.command,
      },
    }),
  );
  const finalizeLabelMutation = vi.fn(async () => workflow({ fence: 5 }));
  const bridge = { prepareLabelMutation, finalizeLabelMutation } as unknown as NativeBookWorkflowBridge;
  const repository = {
    applyLabelCorrections: vi.fn(async () => mutation),
    promoteNativeAnalysisReview: vi.fn(async () => ({ ...mutation, operationId: reviewCommand.operationId })),
  };
  return { bridge, repository, prepareLabelMutation, finalizeLabelMutation };
}

describe('native label mutation saga', () => {
  it('journals prepare before applying IndexedDB and finalizes the receipt', async () => {
    const test = harness();
    const result = await prepareNativeLabelMutationSaga({
      workflow: workflow(),
      command,
      bridge: test.bridge,
      repository: test.repository,
    });

    expect(test.prepareLabelMutation).toHaveBeenCalledWith(
      expect.objectContaining({ expectedFence: 4, operationId: command.operationId, command }),
    );
    expect(test.repository.applyLabelCorrections).toHaveBeenCalledWith(command);
    expect(test.finalizeLabelMutation).toHaveBeenCalledWith(
      expect.objectContaining({ expectedFence: 5, operationId: command.operationId, receiptHash: expect.any(String) }),
    );
    expect(result.workflow.pendingLabelMutation).toBeUndefined();
  });

  it('replays a pending journal operation after restart', async () => {
    const test = harness();
    const pending = await test.prepareLabelMutation({
      workflowId: 'workflow_1',
      expectedFence: 4,
      operationId: command.operationId,
      commandHash: structuredIntegrityHash(command),
      command,
    });

    await expect(
      recoverNativeLabelMutationSaga({ workflow: pending, bridge: test.bridge, repository: test.repository }),
    ).resolves.toMatchObject({ id: 'workflow_1', fence: 5 });
    expect(test.repository.applyLabelCorrections).toHaveBeenCalledOnce();
    expect(test.finalizeLabelMutation).toHaveBeenCalledOnce();
  });

  it('replays review promotion through the same receipt saga and resumes after finalize', async () => {
    const test = harness();
    await prepareNativeAnalysisReviewPromotionSaga({
      workflow: workflow(),
      command: reviewCommand,
      bridge: test.bridge,
      repository: test.repository,
    });

    expect(test.prepareLabelMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: reviewCommand.operationId,
        commandHash: structuredIntegrityHash(reviewCommand),
        command: reviewCommand,
      }),
    );
    expect(test.repository.promoteNativeAnalysisReview).toHaveBeenCalledWith(reviewCommand);
    expect(test.finalizeLabelMutation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: reviewCommand.operationId, resumeAfterReview: true }),
    );
  });
});
