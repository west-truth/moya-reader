import type { Character, LabeledSegment, Novel, UserCorrection } from '../domain/types';
import type { CharacterRelation } from '../providers/ai';
import {
  chapterSegmentsRevision,
  characterGraphRevision,
  correctionsRevision,
  ResourceRevisionConflictError,
} from '../domain/resource-revisions';
import {
  buildLabelMutationPlanV2,
  labelMutationCommandHash,
  LabelMutationConflictError,
  type ApplyLabelCorrectionsCommandV2,
  type ApplyLabelCorrectionsResultV2,
  type LabelMutationOperationReceiptV2,
} from '../providers/label-mutation-contract';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { LABEL_MUTATION_STORES } from './label-mutation-schema';
import { openReaderDb } from './reader-database';
import { jsonValue, queueSyncEventInTransaction } from './sync-event-store';
import {
  markSpeakerArtifactDependencyStale,
  type SpeakerArtifactDependencyV1,
} from '../providers/speaker-attribution/artifact-dependency';
import { SPEAKER_WORKFLOW_STORES } from './speaker-workflow-schema';

interface StoredLabelMutationReceipt extends LabelMutationOperationReceiptV2 {
  readonly id: string;
  readonly novelId: string;
  readonly chapterId: string;
}

interface StoredLabelMutationInvalidation {
  readonly id: string;
  readonly operationId: string;
  readonly novelId: string;
  readonly chapterId: string;
  readonly contextFromWindowId?: string;
  readonly staleTTSSegmentIds: readonly string[];
  readonly status: 'pending';
  readonly createdAt: string;
}

interface StoredLabelReanalysisPlan {
  readonly id: string;
  readonly operationId: string;
  readonly novelId: string;
  readonly chapterId: string;
  readonly contextFromWindowId?: string;
  readonly status: 'pending';
  readonly createdAt: string;
}

function assertFence(label: string, expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) throw new ResourceRevisionConflictError(label, expected, actual);
}

function resultFromReceipt(receipt: StoredLabelMutationReceipt): ApplyLabelCorrectionsResultV2 {
  return {
    operationId: receipt.operationId,
    revisions: receipt.revisions,
    updatedSegmentIds: receipt.updatedSegmentIds,
    createdCorrectionIds: receipt.createdCorrectionIds,
    invalidation: receipt.invalidation,
    syncEventIds: receipt.syncEventIds,
  };
}

export async function applyLocalLabelCorrections(
  command: ApplyLabelCorrectionsCommandV2,
): Promise<ApplyLabelCorrectionsResultV2> {
  const db = await openReaderDb();
  const tx = db.transaction(
    [
      'novels',
      'segments',
      'corrections',
      'characters',
      'character_relations',
      LABEL_MUTATION_STORES.receipts,
      LABEL_MUTATION_STORES.invalidations,
      LABEL_MUTATION_STORES.relabelPlans,
      SPEAKER_WORKFLOW_STORES.artifactDependencies,
      'devices',
      'sync_outbox',
      'sync_state',
    ],
    'readwrite',
  );
  const done = transactionDone(tx);
  try {
    const receiptStore = tx.objectStore(LABEL_MUTATION_STORES.receipts);
    const segmentStore = tx.objectStore('segments');
    const correctionStore = tx.objectStore('corrections');
    const [existingReceipt, novel, segments, corrections, characters, relations] = await Promise.all([
      requestToPromise<StoredLabelMutationReceipt | undefined>(receiptStore.get(command.operationId)),
      requestToPromise<Novel | undefined>(tx.objectStore('novels').get(command.bookId)),
      requestToPromise<LabeledSegment[]>(segmentStore.index('chapterId').getAll(command.chapterId)),
      requestToPromise<UserCorrection[]>(correctionStore.index('novelId').getAll(command.bookId)),
      requestToPromise<Character[]>(tx.objectStore('characters').index('novelId').getAll(command.bookId)),
      requestToPromise<CharacterRelation[]>(
        tx.objectStore('character_relations').index('novelId').getAll(command.bookId),
      ),
    ]);
    if (existingReceipt) {
      if (existingReceipt.commandHash !== labelMutationCommandHash(command)) {
        throw new LabelMutationConflictError(`operation id was reused: ${command.operationId}`, 'operation_reused');
      }
      await done;
      return resultFromReceipt(existingReceipt);
    }
    if (!novel) throw new LabelMutationConflictError(`book is missing: ${command.bookId}`, 'fence_changed');
    assertFence('content_revision', command.expected.contentRevisionId, novel.activeContentRevisionId ?? 'legacy');
    assertFence('chapter_segments', command.expected.segmentCollectionRevision, chapterSegmentsRevision(segments));
    assertFence('user_corrections', command.expected.correctionRevisionId, correctionsRevision(corrections));
    if (command.expected.graphRevisionId || command.expected.graphFingerprint) {
      const graphRevision = characterGraphRevision(characters, relations);
      assertFence('character_graph', command.expected.graphRevisionId, graphRevision);
      assertFence('character_graph_fingerprint', command.expected.graphFingerprint, graphRevision);
    }
    const plan = buildLabelMutationPlanV2(command, segments);

    const changedFields = new Set(Object.values(plan.changedFieldsBySegment).flat());
    const invalidatedDependencyLevels =
      changedFields.has('speakerId') || changedFields.has('listenerIds') || changedFields.has('segmentType')
        ? new Set(['L3_speaker', 'L4_voice'])
        : new Set(['L4_voice']);
    const dependencyStore = tx.objectStore(SPEAKER_WORKFLOW_STORES.artifactDependencies);
    const dependencies = await requestToPromise<SpeakerArtifactDependencyV1[]>(
      dependencyStore
        .index('contentRevisionId_chapterId')
        .getAll([novel.activeContentRevisionId ?? 'legacy', command.chapterId]),
    );
    dependencies
      .filter((row) => row.status === 'active' && invalidatedDependencyLevels.has(row.level))
      .forEach((row) =>
        dependencyStore.put(markSpeakerArtifactDependencyStale(row, `label_mutation:${command.operationId}`)),
      );

    for (const segmentId of Object.keys(plan.changedFieldsBySegment)) {
      const segment = plan.segments.find((item) => item.id === segmentId);
      if (segment) segmentStore.put(segment);
    }
    for (const correction of plan.corrections) correctionStore.put(correction);

    const syncItems = [
      await queueSyncEventInTransaction(
        tx,
        'chapter_segments_updated',
        jsonValue({
          compoundOperationId: command.operationId,
          chapterId: command.chapterId,
          segments: plan.segments,
        }),
        { novelId: command.bookId, entityId: `chapter_segments_${command.chapterId}` },
      ),
    ];
    for (const correction of plan.corrections) {
      syncItems.push(
        await queueSyncEventInTransaction(
          tx,
          'user_correction_created',
          jsonValue({ compoundOperationId: command.operationId, correction }),
          {
            novelId: command.bookId,
            entityId: correction.id,
          },
        ),
      );
    }

    const invalidation: StoredLabelMutationInvalidation = {
      id: command.operationId,
      operationId: command.operationId,
      novelId: command.bookId,
      chapterId: command.chapterId,
      contextFromWindowId: plan.contextFromWindowId,
      staleTTSSegmentIds: plan.staleTTSSegmentIds,
      status: 'pending',
      createdAt: command.createdAt,
    };
    tx.objectStore(LABEL_MUTATION_STORES.invalidations).put(invalidation);
    if (plan.relabelPlanId) {
      const relabelPlan: StoredLabelReanalysisPlan = {
        id: plan.relabelPlanId,
        operationId: command.operationId,
        novelId: command.bookId,
        chapterId: command.chapterId,
        contextFromWindowId: plan.contextFromWindowId,
        status: 'pending',
        createdAt: command.createdAt,
      };
      tx.objectStore(LABEL_MUTATION_STORES.relabelPlans).put(relabelPlan);
    }

    const nextCorrections = [
      ...corrections.filter((correction) => !plan.corrections.some((item) => item.id === correction.id)),
      ...plan.corrections,
    ];
    const result: ApplyLabelCorrectionsResultV2 = {
      operationId: command.operationId,
      revisions: {
        segmentCollectionRevision: chapterSegmentsRevision(plan.segments),
        correctionRevisionId: correctionsRevision(nextCorrections),
      },
      updatedSegmentIds: Object.keys(plan.changedFieldsBySegment).sort(),
      createdCorrectionIds: plan.corrections.map((correction) => correction.id).sort(),
      invalidation: {
        contextFromWindowId: plan.contextFromWindowId,
        relabelPlanId: plan.relabelPlanId,
        obsoleteReviewArtifactIds: [],
        staleTTSRenderItemIds: plan.staleTTSSegmentIds,
      },
      syncEventIds: syncItems.map((item) => item.event.id),
    };
    const receipt: StoredLabelMutationReceipt = {
      id: command.operationId,
      novelId: command.bookId,
      chapterId: command.chapterId,
      ...result,
      commandHash: plan.commandHash,
      appliedAt: command.createdAt,
    };
    receiptStore.put(receipt);
    await done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already be completed or aborted.
    }
    await done.catch(() => undefined);
    throw error;
  }
}
