import { isIntegrityHash } from '../../domain/id-hash-contract';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { analysisOutputIntegrityHash, labeledSegmentId } from '../../domain/identity/ai-identities';
import { chapterSegmentsRevision, correctionsRevision } from '../../domain/resource-revisions';
import type { Character, LabeledSegment, Novel, UserCorrection } from '../../domain/types';
import type { CharacterRelation } from '../../providers/ai';
import {
  buildAnalysisReviewCorrectionPlanV2,
  materializeLabelingSegmentProsody,
} from '../../providers/analysis-review-correction';
import {
  createAcceptedSpeakerProvenance,
  createManualReviewSpeakerProvenanceDraft,
  type AcceptedSpeakerProvenanceV1,
} from '../../providers/speaker-attribution/accepted-speaker-provenance';
import { createSpeakerArtifactDependency } from '../../providers/speaker-attribution/artifact-dependency';
import type {
  ApplyLabelCorrectionsResultV2,
  LabelMutationOperationReceiptV2,
} from '../../providers/label-mutation-contract';
import type { RevisionParagraphPageRow, RevisionParagraphRefRow } from '../content-revision-store';
import { requestToPromise, transactionDone } from '../indexeddb-transaction';
import { LABEL_MUTATION_STORES } from '../label-mutation-schema';
import { openReaderDb } from '../reader-database';
import { SPEAKER_WORKFLOW_STORES } from '../speaker-workflow-schema';
import {
  mergeSpeakerSequenceDecisionsForChapterInTransaction,
  putSpeakerArtifactDependenciesInTransaction,
  replaceAcceptedSpeakerProvenanceForParagraphsInTransaction,
} from '../speaker-workflow-store';
import { jsonValue, nowIso, queueSyncEventInTransaction } from '../sync-event-store';
import {
  canonicalCharacterGraph,
  nativeAnalysisCorrectionFingerprint,
  nativeAnalysisGraphFingerprint,
  nativeAnalysisOutputHash,
} from './fingerprints';
import { NATIVE_ANALYSIS_STORES } from './schema';
import {
  buildNativeLabelSourceIndex,
  segmentsOverlap,
  validateNativeLabelSegmentAnchors,
} from './segment-source-validation';
import { nativeAnalysisProvenanceId, nativeAnalysisWorkflowRecordId } from './staging-store';
import type {
  NativeAnalysisPromotionProvenance,
  NativeAnalysisPromotionResult,
  NativeAnalysisReviewPromotionCommand,
  NativeAnalysisStagedOutput,
  NativeAnalysisWorkflowFenceRecord,
  NativeAnalysisWorkflowJobPlan,
} from './types';

const PROMOTION_STORES = [
  NATIVE_ANALYSIS_STORES.workflows,
  NATIVE_ANALYSIS_STORES.staging,
  NATIVE_ANALYSIS_STORES.provenance,
  'novels',
  'book_content_paragraphs',
  'book_content_paragraph_pages',
  'characters',
  'character_relations',
  'corrections',
  'segments',
  'devices',
  'sync_outbox',
  'sync_state',
  LABEL_MUTATION_STORES.receipts,
  LABEL_MUTATION_STORES.invalidations,
  LABEL_MUTATION_STORES.relabelPlans,
  SPEAKER_WORKFLOW_STORES.sequenceDecisions,
  SPEAKER_WORKFLOW_STORES.artifactDependencies,
  SPEAKER_WORKFLOW_STORES.acceptedSpeakerProvenance,
] as const;

interface StoredReviewPromotionReceipt extends LabelMutationOperationReceiptV2 {
  readonly id: string;
  readonly novelId: string;
  readonly chapterId: string;
}

function reviewPromotionResult(receipt: StoredReviewPromotionReceipt): ApplyLabelCorrectionsResultV2 {
  return {
    operationId: receipt.operationId,
    revisions: receipt.revisions,
    updatedSegmentIds: receipt.updatedSegmentIds,
    createdCorrectionIds: receipt.createdCorrectionIds,
    invalidation: receipt.invalidation,
    syncEventIds: receipt.syncEventIds,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stoppedResult(
  tx: IDBTransaction,
  artifact: NativeAnalysisStagedOutput,
  status: 'stale' | 'quarantined',
  reason: string,
): Extract<NativeAnalysisPromotionResult, { status: 'stale' | 'rejected' }> {
  const updated = { ...artifact, status, staleReason: reason } as NativeAnalysisStagedOutput;
  tx.objectStore(NATIVE_ANALYSIS_STORES.staging).put(updated);
  return { status: status === 'stale' ? 'stale' : 'rejected', artifact: updated, reason };
}

function jobMatchesArtifact(
  job: NativeAnalysisWorkflowJobPlan | undefined,
  artifact: NativeAnalysisStagedOutput,
): boolean {
  return Boolean(
    job &&
    job.artifactType === artifact.artifactType &&
    job.chapterId === artifact.chapterId &&
    sameStrings(job.plannedParagraphIds, artifact.plannedParagraphIds),
  );
}

async function promotedReplay(
  tx: IDBTransaction,
  artifact: NativeAnalysisStagedOutput,
): Promise<NativeAnalysisPromotionResult> {
  const provenance = await requestToPromise<NativeAnalysisPromotionProvenance | undefined>(
    tx.objectStore(NATIVE_ANALYSIS_STORES.provenance).index('artifactId').get(artifact.id),
  );
  if (!provenance) throw new Error(`Promoted native analysis artifact lacks provenance: ${artifact.id}`);
  return { status: 'already_promoted', artifact, provenance };
}

function validateGraphArtifact(
  artifact: NativeAnalysisStagedOutput,
  existingCharacters: readonly Character[],
): { characters: Character[]; relations: CharacterRelation[] } | string {
  if (artifact.payload.kind !== 'character_graph' || artifact.payload.graph.novelId !== artifact.novelId) {
    return 'graph_payload_mismatch';
  }
  const graph = artifact.payload.graph;
  const characterIds = new Set<string>();
  for (const character of graph.characters) {
    if (!character.id || character.novelId !== artifact.novelId || characterIds.has(character.id)) {
      return 'graph_character_invalid';
    }
    characterIds.add(character.id);
  }
  const existingConfirmed = new Map(
    existingCharacters.filter((character) => character.isUserConfirmed).map((character) => [character.id, character]),
  );
  const characters = graph.characters.map((character) => existingConfirmed.get(character.id) ?? character);
  for (const character of existingConfirmed.values()) {
    if (!characterIds.has(character.id)) characters.push(character);
  }
  const finalIds = new Set(characters.map((character) => character.id));
  const relationIds = new Set<string>();
  for (const relation of graph.relations) {
    if (
      !relation.id ||
      relation.novelId !== artifact.novelId ||
      relationIds.has(relation.id) ||
      relation.sourceCharacterId === relation.targetCharacterId ||
      !finalIds.has(relation.sourceCharacterId) ||
      !finalIds.has(relation.targetCharacterId)
    ) {
      return 'graph_relation_invalid';
    }
    relationIds.add(relation.id);
  }
  return canonicalCharacterGraph(artifact.novelId, characters, graph.relations);
}

function validateGeneratedSegments(artifact: NativeAnalysisStagedOutput): LabeledSegment[] | string {
  if (artifact.payload.kind !== 'label_window' || artifact.payload.chapterId !== artifact.chapterId) {
    return 'label_payload_mismatch';
  }
  const planned = new Set(artifact.plannedParagraphIds);
  const ids = new Set<string>();
  for (const segment of artifact.payload.segments) {
    const expectedId = labeledSegmentId({
      novelId: segment.novelId,
      chapterId: segment.chapterId,
      paragraphId: segment.paragraphId,
      startOffset: segment.startOffset,
      endOffset: segment.endOffset,
      segmentTextHash: segment.segmentTextHash,
    });
    if (
      !segment.id ||
      ids.has(segment.id) ||
      segment.id !== expectedId ||
      segment.novelId !== artifact.novelId ||
      segment.chapterId !== artifact.chapterId ||
      !planned.has(segment.paragraphId) ||
      !Number.isSafeInteger(segment.startOffset) ||
      !Number.isSafeInteger(segment.endOffset) ||
      segment.startOffset < 0 ||
      segment.endOffset <= segment.startOffset ||
      !isIntegrityHash(segment.segmentTextHash) ||
      !segment.speakerId ||
      !segment.emotion ||
      !Array.isArray(segment.candidateSpeakers) ||
      !Array.isArray(segment.listenerIds) ||
      !Number.isFinite(segment.confidence) ||
      segment.confidence < 0 ||
      segment.confidence > 1 ||
      segment.isUserCorrected
    ) {
      return !planned.has(segment.paragraphId) ? 'segment_outside_planned_paragraphs' : 'generated_segment_invalid';
    }
    ids.add(segment.id);
  }
  return artifact.payload.segments.map((segment) => ({ ...segment, isUserCorrected: false }));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renumberChapterSegments(
  segments: readonly LabeledSegment[],
  paragraphRows: readonly RevisionParagraphRefRow[],
): LabeledSegment[] {
  const paragraphRank = new Map(paragraphRows.map((paragraph) => [paragraph.id, paragraph.index]));
  return [...segments]
    .sort((left, right) => {
      const paragraphDiff =
        (paragraphRank.get(left.paragraphId) ?? Number.MAX_SAFE_INTEGER) -
        (paragraphRank.get(right.paragraphId) ?? Number.MAX_SAFE_INTEGER);
      return (
        paragraphDiff ||
        left.startOffset - right.startOffset ||
        left.endOffset - right.endOffset ||
        compareText(left.id, right.id)
      );
    })
    .map((segment, segmentIndex) => ({ ...segment, segmentIndex }));
}

async function persistSpeakerWorkflowPromotion(
  tx: IDBTransaction,
  artifact: NativeAnalysisStagedOutput,
  promotedSegments: readonly LabeledSegment[],
  createdAt: string,
  manualReview = false,
  changedFieldsBySegment: Readonly<Record<string, readonly string[]>> = {},
): Promise<void> {
  if (artifact.payload.kind !== 'label_window' || !artifact.chapterId) return;
  const speakerWorkflow = artifact.payload.speakerWorkflow;
  const promotedById = new Map(promotedSegments.map((segment) => [segment.id, segment]));
  const acceptedRows: AcceptedSpeakerProvenanceV1[] = [];

  if (speakerWorkflow) {
    await mergeSpeakerSequenceDecisionsForChapterInTransaction(tx, {
      contentRevisionId: artifact.expectedContentRevisionId,
      chapterId: artifact.chapterId,
      records: speakerWorkflow.sequenceRecords,
    });
    await putSpeakerArtifactDependenciesInTransaction(tx, [
      createSpeakerArtifactDependency({
        bookId: artifact.novelId,
        contentRevisionId: artifact.expectedContentRevisionId,
        chapterId: artifact.chapterId,
        artifactId: artifact.id,
        artifactKind: 'speaker_labels',
        level: 'L3_speaker',
        dependencyIds: speakerWorkflow.artifactDependencyIds,
        createdAt,
      }),
    ]);

    for (const draft of speakerWorkflow.speakerProvenanceDrafts) {
      const promotedSegment = promotedById.get(draft.segmentId);
      if (!promotedSegment) continue;
      const reconciledDraft = manualReview
        ? createManualReviewSpeakerProvenanceDraft({
            draft,
            promotedSpeakerId: promotedSegment.speakerId,
            speakerEntityIdByCanonicalSpeakerId: speakerWorkflow.speakerEntityIdByCanonicalSpeakerId,
            speakerEdited: changedFieldsBySegment[promotedSegment.id]?.includes('speakerId') ?? false,
          })
        : draft;
      acceptedRows.push(createAcceptedSpeakerProvenance(reconciledDraft, artifact.id, createdAt));
    }
  }

  await replaceAcceptedSpeakerProvenanceForParagraphsInTransaction(tx, {
    bookId: artifact.novelId,
    contentRevisionId: artifact.expectedContentRevisionId,
    chapterId: artifact.chapterId,
    paragraphIds: artifact.plannedParagraphIds,
    rows: acceptedRows,
  });
}

async function promoteGraph(
  tx: IDBTransaction,
  artifact: NativeAnalysisStagedOutput,
  existingCharacters: readonly Character[],
  existingRelations: readonly CharacterRelation[],
): Promise<NativeAnalysisPromotionResult> {
  const graph = validateGraphArtifact(artifact, existingCharacters);
  if (typeof graph === 'string') return stoppedResult(tx, artifact, 'quarantined', graph);

  const characterStore = tx.objectStore('characters');
  const relationStore = tx.objectStore('character_relations');
  const finalCharacterIds = new Set(graph.characters.map((character) => character.id));
  for (const character of existingCharacters) {
    if (!character.isUserConfirmed && !finalCharacterIds.has(character.id)) characterStore.delete(character.id);
  }
  for (const relation of existingRelations) relationStore.delete(relation.id);
  for (const character of graph.characters) characterStore.put(character);
  for (const relation of graph.relations) relationStore.put(relation);

  const syncItem = await queueSyncEventInTransaction(
    tx,
    'character_graph_updated',
    jsonValue({ mode: 'replace', characters: graph.characters, relations: graph.relations }),
    { novelId: artifact.novelId, entityId: `character_graph_${artifact.novelId}` },
  );
  return finishPromotion(
    tx,
    artifact,
    nativeAnalysisGraphFingerprint(artifact.novelId, graph.characters, graph.relations),
    syncItem,
  );
}

async function promoteLabelWindow(
  tx: IDBTransaction,
  artifact: NativeAnalysisStagedOutput,
  contentRevisionId: string,
): Promise<NativeAnalysisPromotionResult> {
  const generated = validateGeneratedSegments(artifact);
  if (typeof generated === 'string') return stoppedResult(tx, artifact, 'quarantined', generated);
  const chapterId = artifact.chapterId!;
  const [paragraphRows, pageRows] = await Promise.all([
    requestToPromise<RevisionParagraphRefRow[]>(
      tx
        .objectStore('book_content_paragraphs')
        .index('contentRevisionId_chapterId')
        .getAll([contentRevisionId, chapterId]),
    ),
    requestToPromise<RevisionParagraphPageRow[]>(
      tx
        .objectStore('book_content_paragraph_pages')
        .index('contentRevisionId_chapterId')
        .getAll([contentRevisionId, chapterId]),
    ),
  ]);
  const sourceIndex = buildNativeLabelSourceIndex(artifact, contentRevisionId, paragraphRows, pageRows);
  if (!sourceIndex.ok) {
    return stoppedResult(tx, artifact, sourceIndex.stale ? 'stale' : 'quarantined', sourceIndex.reason);
  }
  const generatedAnchorError = validateNativeLabelSegmentAnchors(generated, {
    novelId: artifact.novelId,
    chapterId,
    paragraphTextById: sourceIndex.paragraphTextById,
    requiredParagraphIds: artifact.plannedParagraphIds,
    reasonPrefix: 'generated',
  });
  if (generatedAnchorError) return stoppedResult(tx, artifact, 'quarantined', generatedAnchorError);

  const segmentStore = tx.objectStore('segments');
  const existing = await requestToPromise<LabeledSegment[]>(segmentStore.index('chapterId').getAll(chapterId));
  const planned = new Set(artifact.plannedParagraphIds);
  const corrected = existing.filter((segment) => segment.isUserCorrected);
  const correctedIds = new Set(corrected.map((segment) => segment.id));
  const siblingIds = new Set(
    existing.filter((segment) => !planned.has(segment.paragraphId)).map((segment) => segment.id),
  );
  if (generated.some((segment) => siblingIds.has(segment.id))) {
    return stoppedResult(tx, artifact, 'quarantined', 'generated_segment_collides_with_sibling');
  }
  const promotedGenerated = generated.filter(
    (segment) =>
      !correctedIds.has(segment.id) &&
      !corrected.some((correctedSegment) => segmentsOverlap(segment, correctedSegment)),
  );
  const retained = existing.filter((segment) => !planned.has(segment.paragraphId) || segment.isUserCorrected);
  const renumbered = renumberChapterSegments([...retained, ...promotedGenerated], paragraphRows);
  const canonicalAnchorError = validateNativeLabelSegmentAnchors(renumbered, {
    novelId: artifact.novelId,
    chapterId,
    paragraphTextById: sourceIndex.paragraphTextById,
    reasonPrefix: 'canonical',
  });
  if (canonicalAnchorError) return stoppedResult(tx, artifact, 'quarantined', canonicalAnchorError);

  const finalIds = new Set(renumbered.map((segment) => segment.id));
  for (const segment of existing) {
    if (!finalIds.has(segment.id)) segmentStore.delete(segment.id);
  }
  for (const segment of renumbered) segmentStore.put(segment);

  await persistSpeakerWorkflowPromotion(tx, artifact, promotedGenerated, nowIso());

  const payload = {
    mode: 'replace',
    chapterId,
    segments: renumbered,
  };
  const syncItem = await queueSyncEventInTransaction(tx, 'chapter_segments_updated', jsonValue(payload), {
    novelId: artifact.novelId,
    entityId: `chapter_segments_${chapterId}`,
  });
  return finishPromotion(tx, artifact, analysisOutputIntegrityHash(payload), syncItem);
}

async function finishPromotion(
  tx: IDBTransaction,
  artifact: NativeAnalysisStagedOutput,
  canonicalOutputFingerprint: string,
  syncItem: { readonly id: string; readonly event: { readonly id: string } },
): Promise<NativeAnalysisPromotionResult> {
  const promotedAt = nowIso();
  const promotedArtifact: NativeAnalysisStagedOutput = {
    ...artifact,
    status: 'promoted',
    staleReason: undefined,
    promotedAt,
  };
  const provenance: NativeAnalysisPromotionProvenance = {
    id: nativeAnalysisProvenanceId(artifact.id),
    artifactId: artifact.id,
    artifactType: artifact.artifactType,
    workflowId: artifact.workflowId,
    jobId: artifact.jobId,
    novelId: artifact.novelId,
    chapterId: artifact.chapterId,
    contentRevisionId: artifact.expectedContentRevisionId,
    workflowFence: artifact.workflowFence,
    planHash: artifact.planHash,
    expectedGraphFingerprint: artifact.expectedGraphFingerprint,
    correctionFingerprint: artifact.correctionFingerprint,
    plannedParagraphIds: artifact.plannedParagraphIds,
    outputHash: artifact.outputHash,
    canonicalOutputFingerprint,
    syncOutboxItemId: syncItem.id,
    syncEventId: syncItem.event.id,
    promotedAt,
  };
  tx.objectStore(NATIVE_ANALYSIS_STORES.provenance).put(provenance);
  tx.objectStore(NATIVE_ANALYSIS_STORES.staging).put(promotedArtifact);
  return { status: 'promoted', artifact: promotedArtifact, provenance };
}

export async function promoteNativeAnalysisOutput(artifactId: string): Promise<NativeAnalysisPromotionResult> {
  const db = await openReaderDb();
  const tx = db.transaction([...PROMOTION_STORES], 'readwrite');
  const artifact = await requestToPromise<NativeAnalysisStagedOutput | undefined>(
    tx.objectStore(NATIVE_ANALYSIS_STORES.staging).get(artifactId),
  );
  if (!artifact) {
    tx.abort();
    throw new Error(`Native analysis staged output not found: ${artifactId}`);
  }
  if (artifact.status === 'promoted') {
    const result = await promotedReplay(tx, artifact);
    await transactionDone(tx);
    return result;
  }
  if (artifact.status === 'stale' || artifact.status === 'quarantined') {
    await transactionDone(tx);
    return {
      status: artifact.status === 'stale' ? 'stale' : 'rejected',
      artifact,
      reason: artifact.staleReason ?? artifact.status,
    };
  }

  const [workflow, priorJobPromotion, novel, characters, relations, corrections] = await Promise.all([
    requestToPromise<NativeAnalysisWorkflowFenceRecord | undefined>(
      tx.objectStore(NATIVE_ANALYSIS_STORES.workflows).get(nativeAnalysisWorkflowRecordId(artifact.workflowId)),
    ),
    requestToPromise<NativeAnalysisPromotionProvenance | undefined>(
      tx
        .objectStore(NATIVE_ANALYSIS_STORES.provenance)
        .index('workflowId_jobId_fence')
        .get([artifact.workflowId, artifact.jobId, artifact.workflowFence]),
    ),
    requestToPromise<Novel | undefined>(tx.objectStore('novels').get(artifact.novelId)),
    requestToPromise<Character[]>(tx.objectStore('characters').index('novelId').getAll(artifact.novelId)),
    requestToPromise<CharacterRelation[]>(
      tx.objectStore('character_relations').index('novelId').getAll(artifact.novelId),
    ),
    requestToPromise<UserCorrection[]>(tx.objectStore('corrections').index('novelId').getAll(artifact.novelId)),
  ]);
  const job = workflow?.jobs.find((candidate) => candidate.jobId === artifact.jobId);
  let result: NativeAnalysisPromotionResult;
  if (priorJobPromotion) {
    result = stoppedResult(tx, artifact, 'quarantined', 'job_output_already_promoted');
  } else if (!workflow || !jobMatchesArtifact(job, artifact)) {
    result = stoppedResult(tx, artifact, 'stale', 'workflow_plan_stale');
  } else if (
    workflow.planHash !== artifact.planHash ||
    workflow.fence !== artifact.workflowFence ||
    workflow.novelId !== artifact.novelId ||
    workflow.contentRevisionId !== artifact.expectedContentRevisionId
  ) {
    result = stoppedResult(tx, artifact, 'stale', 'workflow_fence_stale');
  } else if (novel?.activeContentRevisionId !== artifact.expectedContentRevisionId) {
    result = stoppedResult(tx, artifact, 'stale', 'content_revision_stale');
  } else if (nativeAnalysisOutputHash(artifact.payload) !== artifact.outputHash) {
    result = stoppedResult(tx, artifact, 'quarantined', 'output_hash_mismatch');
  } else if (
    nativeAnalysisGraphFingerprint(artifact.novelId, characters, relations) !== artifact.expectedGraphFingerprint
  ) {
    result = stoppedResult(tx, artifact, 'stale', 'graph_fingerprint_stale');
  } else if (nativeAnalysisCorrectionFingerprint(corrections, artifact.chapterId) !== artifact.correctionFingerprint) {
    result = stoppedResult(tx, artifact, 'stale', 'correction_fingerprint_stale');
  } else if (artifact.artifactType === 'character_graph') {
    result = await promoteGraph(tx, artifact, characters, relations);
  } else {
    result = await promoteLabelWindow(tx, artifact, artifact.expectedContentRevisionId);
  }
  await transactionDone(tx);
  return result;
}

export async function promoteNativeAnalysisReview(
  command: NativeAnalysisReviewPromotionCommand,
): Promise<ApplyLabelCorrectionsResultV2> {
  const db = await openReaderDb();
  const tx = db.transaction([...PROMOTION_STORES], 'readwrite');
  const done = transactionDone(tx);
  try {
    const receiptStore = tx.objectStore(LABEL_MUTATION_STORES.receipts);
    const existingReceipt = await requestToPromise<StoredReviewPromotionReceipt | undefined>(
      receiptStore.get(command.operationId),
    );
    const commandHash = structuredIntegrityHash(command);
    if (existingReceipt) {
      if (existingReceipt.commandHash !== commandHash) throw new Error('Native review promotion operation was reused');
      await done;
      return reviewPromotionResult(existingReceipt);
    }

    const artifact = await requestToPromise<NativeAnalysisStagedOutput | undefined>(
      tx.objectStore(NATIVE_ANALYSIS_STORES.staging).get(command.artifactId),
    );
    if (!artifact || artifact.payload.kind !== 'label_window' || !artifact.payload.result || !artifact.chapterId) {
      throw new Error(`Native analysis review artifact is unavailable: ${command.artifactId}`);
    }
    const reviewRevision = artifact.reviewRevision ?? 1;
    const candidate = artifact.reviewDraft ?? artifact.payload.result;
    const editIntents = artifact.reviewEditIntents ?? {};
    if (
      artifact.status !== 'staged' ||
      artifact.reviewStatus === 'rejected' ||
      reviewRevision !== command.expectedReviewRevision ||
      structuredIntegrityHash(candidate) !== command.candidateHash ||
      structuredIntegrityHash(editIntents) !== command.editIntentsHash
    ) {
      throw new Error('Native analysis review changed before promotion');
    }

    const [workflow, priorJobPromotion, novel, characters, relations, corrections, existingSegments] =
      await Promise.all([
        requestToPromise<NativeAnalysisWorkflowFenceRecord | undefined>(
          tx.objectStore(NATIVE_ANALYSIS_STORES.workflows).get(nativeAnalysisWorkflowRecordId(artifact.workflowId)),
        ),
        requestToPromise<NativeAnalysisPromotionProvenance | undefined>(
          tx
            .objectStore(NATIVE_ANALYSIS_STORES.provenance)
            .index('workflowId_jobId_fence')
            .get([artifact.workflowId, artifact.jobId, artifact.workflowFence]),
        ),
        requestToPromise<Novel | undefined>(tx.objectStore('novels').get(artifact.novelId)),
        requestToPromise<Character[]>(tx.objectStore('characters').index('novelId').getAll(artifact.novelId)),
        requestToPromise<CharacterRelation[]>(
          tx.objectStore('character_relations').index('novelId').getAll(artifact.novelId),
        ),
        requestToPromise<UserCorrection[]>(tx.objectStore('corrections').index('novelId').getAll(artifact.novelId)),
        requestToPromise<LabeledSegment[]>(tx.objectStore('segments').index('chapterId').getAll(artifact.chapterId)),
      ]);
    const job = workflow?.jobs.find((candidateJob) => candidateJob.jobId === artifact.jobId);
    if (
      priorJobPromotion ||
      !workflow ||
      !jobMatchesArtifact(job, artifact) ||
      workflow.planHash !== artifact.planHash ||
      workflow.fence !== artifact.workflowFence ||
      novel?.activeContentRevisionId !== artifact.expectedContentRevisionId ||
      nativeAnalysisGraphFingerprint(artifact.novelId, characters, relations) !== artifact.expectedGraphFingerprint ||
      nativeAnalysisCorrectionFingerprint(corrections, artifact.chapterId) !== artifact.correctionFingerprint
    ) {
      throw new Error('Native analysis review source fence is stale');
    }

    const approvedWithProsody = {
      ...candidate,
      segments: materializeLabelingSegmentProsody(candidate).map((segment) => ({ ...segment, isUserCorrected: false })),
    };
    const validationArtifact: NativeAnalysisStagedOutput = {
      ...artifact,
      payload: { ...artifact.payload, segments: approvedWithProsody.segments },
    };
    const generated = validateGeneratedSegments(validationArtifact);
    if (typeof generated === 'string') throw new Error(`Native analysis review candidate is invalid: ${generated}`);

    const [paragraphRows, pageRows] = await Promise.all([
      requestToPromise<RevisionParagraphRefRow[]>(
        tx
          .objectStore('book_content_paragraphs')
          .index('contentRevisionId_chapterId')
          .getAll([artifact.expectedContentRevisionId, artifact.chapterId]),
      ),
      requestToPromise<RevisionParagraphPageRow[]>(
        tx
          .objectStore('book_content_paragraph_pages')
          .index('contentRevisionId_chapterId')
          .getAll([artifact.expectedContentRevisionId, artifact.chapterId]),
      ),
    ]);
    const sourceIndex = buildNativeLabelSourceIndex(
      validationArtifact,
      artifact.expectedContentRevisionId,
      paragraphRows,
      pageRows,
    );
    if (!sourceIndex.ok) throw new Error(`Native analysis review source is invalid: ${sourceIndex.reason}`);
    const anchorError = validateNativeLabelSegmentAnchors(generated, {
      novelId: artifact.novelId,
      chapterId: artifact.chapterId,
      paragraphTextById: sourceIndex.paragraphTextById,
      requiredParagraphIds: artifact.plannedParagraphIds,
      reasonPrefix: 'generated',
    });
    if (anchorError) throw new Error(`Native analysis review candidate is invalid: ${anchorError}`);

    const plan = buildAnalysisReviewCorrectionPlanV2({
      operationId: command.operationId,
      reviewArtifactId: artifact.id,
      bookId: artifact.novelId,
      chapterId: artifact.chapterId,
      windowId: artifact.jobId,
      createdAt: command.approvedAt,
      original: {
        ...artifact.payload.result,
        segments: materializeLabelingSegmentProsody(artifact.payload.result),
      },
      approved: approvedWithProsody,
      editIntents,
    });
    const planned = new Set(artifact.plannedParagraphIds);
    const existingCorrected = existingSegments.filter((segment) => segment.isUserCorrected);
    const retained = existingSegments.filter((segment) => !planned.has(segment.paragraphId) || segment.isUserCorrected);
    const promotedIds = new Set<string>();
    const reviewed = plan.segments.filter((segment) => {
      if (existingCorrected.some((corrected) => corrected.id === segment.id || segmentsOverlap(corrected, segment))) {
        return false;
      }
      promotedIds.add(segment.id);
      return true;
    });
    const canonical = renumberChapterSegments([...retained, ...reviewed], paragraphRows);
    const canonicalAnchorError = validateNativeLabelSegmentAnchors(canonical, {
      novelId: artifact.novelId,
      chapterId: artifact.chapterId,
      paragraphTextById: sourceIndex.paragraphTextById,
      reasonPrefix: 'canonical',
    });
    if (canonicalAnchorError) throw new Error(`Native analysis review candidate is invalid: ${canonicalAnchorError}`);

    const segmentStore = tx.objectStore('segments');
    const finalIds = new Set(canonical.map((segment) => segment.id));
    for (const segment of existingSegments) if (!finalIds.has(segment.id)) segmentStore.delete(segment.id);
    for (const segment of canonical) segmentStore.put(segment);
    await persistSpeakerWorkflowPromotion(
      tx,
      artifact,
      reviewed,
      command.approvedAt,
      true,
      plan.changedFieldsBySegment,
    );
    const reviewCorrections = plan.corrections.filter((correction) =>
      Boolean(correction.segmentId && promotedIds.has(correction.segmentId)),
    );
    for (const correction of reviewCorrections) tx.objectStore('corrections').put(correction);

    const syncItems = [
      await queueSyncEventInTransaction(
        tx,
        'chapter_segments_updated',
        jsonValue({
          compoundOperationId: command.operationId,
          mode: 'replace',
          chapterId: artifact.chapterId,
          segments: canonical,
        }),
        { novelId: artifact.novelId, entityId: `chapter_segments_${artifact.chapterId}` },
      ),
    ];
    for (const correction of reviewCorrections) {
      syncItems.push(
        await queueSyncEventInTransaction(
          tx,
          'user_correction_created',
          jsonValue({ compoundOperationId: command.operationId, correction }),
          { novelId: artifact.novelId, entityId: correction.id },
        ),
      );
    }

    const staleTTSSegmentIds = plan.staleTTSSegmentIds.filter((segmentId) => promotedIds.has(segmentId));
    tx.objectStore(LABEL_MUTATION_STORES.invalidations).put({
      id: command.operationId,
      operationId: command.operationId,
      novelId: artifact.novelId,
      chapterId: artifact.chapterId,
      contextFromWindowId: plan.contextFromWindowId,
      staleTTSSegmentIds,
      status: 'pending',
      createdAt: command.approvedAt,
    });
    if (plan.relabelPlanId) {
      tx.objectStore(LABEL_MUTATION_STORES.relabelPlans).put({
        id: plan.relabelPlanId,
        operationId: command.operationId,
        novelId: artifact.novelId,
        chapterId: artifact.chapterId,
        contextFromWindowId: plan.contextFromWindowId,
        status: 'pending',
        createdAt: command.approvedAt,
      });
    }

    const promoted = await finishPromotion(
      tx,
      {
        ...artifact,
        reviewStatus: 'approved',
        reviewRevision: reviewRevision + 1,
        reviewUpdatedAt: command.approvedAt,
      },
      analysisOutputIntegrityHash({ mode: 'replace', chapterId: artifact.chapterId, segments: canonical }),
      syncItems[0],
    );
    if (promoted.status !== 'promoted') throw new Error('Native analysis review promotion did not complete');
    const nextCorrections = [
      ...corrections.filter((correction) => !reviewCorrections.some((item) => item.id === correction.id)),
      ...reviewCorrections,
    ];
    const result: ApplyLabelCorrectionsResultV2 = {
      operationId: command.operationId,
      revisions: {
        segmentCollectionRevision: chapterSegmentsRevision(canonical),
        correctionRevisionId: correctionsRevision(nextCorrections),
      },
      updatedSegmentIds: Object.keys(plan.changedFieldsBySegment)
        .filter((id) => promotedIds.has(id))
        .sort(),
      createdCorrectionIds: reviewCorrections.map((correction) => correction.id).sort(),
      invalidation: {
        contextFromWindowId: plan.contextFromWindowId,
        relabelPlanId: plan.relabelPlanId,
        obsoleteReviewArtifactIds: [],
        staleTTSRenderItemIds: staleTTSSegmentIds,
      },
      syncEventIds: syncItems.map((item) => item.event.id),
    };
    receiptStore.put({
      id: command.operationId,
      novelId: artifact.novelId,
      chapterId: artifact.chapterId,
      ...result,
      commandHash,
      appliedAt: command.approvedAt,
    } satisfies StoredReviewPromotionReceipt);
    await done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already be complete.
    }
    await done.catch(() => undefined);
    throw error;
  }
}
