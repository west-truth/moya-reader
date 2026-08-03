import { persistentId128 } from '../../domain/id-hash-contract';
import { analysisOutputIntegrityHash } from '../../domain/identity/ai-identities';
import { requestToPromise, transactionDone } from '../indexeddb-transaction';
import { openReaderDb } from '../reader-database';
import { nowIso } from '../sync-event-store';
import { NATIVE_ANALYSIS_STORES } from './schema';
import type {
  NativeAnalysisPromotionProvenance,
  NativeAnalysisStagedOutput,
  NativeAnalysisWorkflowFenceInput,
  NativeAnalysisWorkflowFenceRecord,
  NativeAnalysisWorkflowJobPlan,
  StageNativeAnalysisOutputInput,
} from './types';
import type { ChapterLabelingResult } from '../../providers/ai';
import type { AnalysisReviewEditIntentMap } from '../../providers/analysis-review-correction';

export function nativeAnalysisWorkflowRecordId(workflowId: string): string {
  return persistentId128('native_analysis_workflow', [workflowId]);
}

export function nativeAnalysisStagedOutputId(
  input: Pick<
    StageNativeAnalysisOutputInput,
    | 'workflowId'
    | 'jobId'
    | 'novelId'
    | 'artifactType'
    | 'chapterId'
    | 'workflowFence'
    | 'planHash'
    | 'expectedContentRevisionId'
    | 'expectedGraphFingerprint'
    | 'correctionFingerprint'
    | 'plannedParagraphIds'
    | 'outputHash'
  >,
): string {
  return persistentId128('analysis_staging_artifact', [
    input.workflowId,
    input.jobId,
    input.novelId,
    input.artifactType,
    input.chapterId ?? '',
    String(input.workflowFence),
    input.planHash,
    input.expectedContentRevisionId,
    input.expectedGraphFingerprint,
    input.correctionFingerprint,
    JSON.stringify(input.plannedParagraphIds),
    input.outputHash,
  ]);
}

export function nativeAnalysisProvenanceId(artifactId: string): string {
  return persistentId128('analysis_promotion_provenance', [artifactId]);
}

function assertText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  const result = values.map((value) => value.trim());
  if (result.some((value) => !value)) throw new Error(`${label} must contain non-empty strings`);
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  return result;
}

function normalizeJob(job: NativeAnalysisWorkflowJobPlan): NativeAnalysisWorkflowJobPlan {
  assertText(job.jobId, 'native analysis job id');
  const plannedParagraphIds = uniqueStrings(job.plannedParagraphIds, `planned paragraphs for ${job.jobId}`);
  if (job.artifactType === 'label_window' && !job.chapterId) {
    throw new Error(`Label-window job ${job.jobId} requires a chapter id`);
  }
  if (job.artifactType === 'character_graph' && (job.chapterId || plannedParagraphIds.length > 0)) {
    throw new Error(`Character-graph job ${job.jobId} cannot plan chapter paragraphs`);
  }
  return { ...job, jobId: job.jobId.trim(), chapterId: job.chapterId?.trim(), plannedParagraphIds };
}

function normalizeFence(
  input: NativeAnalysisWorkflowFenceInput,
): Omit<NativeAnalysisWorkflowFenceRecord, 'createdAt' | 'updatedAt'> {
  assertText(input.workflowId, 'native analysis workflow id');
  assertText(input.novelId, 'native analysis novel id');
  assertText(input.contentRevisionId, 'native analysis content revision id');
  assertText(input.planHash, 'native analysis plan hash');
  if (!Number.isSafeInteger(input.fence) || input.fence < 0) {
    throw new Error('native analysis workflow fence must be a non-negative integer');
  }
  const jobs = input.jobs.map(normalizeJob);
  if (new Set(jobs.map((job) => job.jobId)).size !== jobs.length) {
    throw new Error('native analysis workflow jobs must have unique ids');
  }
  return {
    id: nativeAnalysisWorkflowRecordId(input.workflowId),
    workflowId: input.workflowId.trim(),
    novelId: input.novelId.trim(),
    contentRevisionId: input.contentRevisionId.trim(),
    planHash: input.planHash.trim(),
    fence: input.fence,
    jobs,
  };
}

function immutableFenceHash(
  record: Pick<
    NativeAnalysisWorkflowFenceRecord,
    'id' | 'workflowId' | 'novelId' | 'contentRevisionId' | 'planHash' | 'jobs'
  >,
): string {
  return analysisOutputIntegrityHash({
    id: record.id,
    workflowId: record.workflowId,
    novelId: record.novelId,
    contentRevisionId: record.contentRevisionId,
    planHash: record.planHash,
    jobs: record.jobs,
  });
}

export async function saveNativeAnalysisWorkflowFence(
  input: NativeAnalysisWorkflowFenceInput,
): Promise<NativeAnalysisWorkflowFenceRecord> {
  const normalized = normalizeFence(input);
  const db = await openReaderDb();
  const tx = db.transaction(NATIVE_ANALYSIS_STORES.workflows, 'readwrite');
  const store = tx.objectStore(NATIVE_ANALYSIS_STORES.workflows);
  const existing = await requestToPromise<NativeAnalysisWorkflowFenceRecord | undefined>(store.get(normalized.id));
  if (existing) {
    if (immutableFenceHash(existing) !== immutableFenceHash(normalized)) {
      tx.abort();
      throw new Error(`Native analysis workflow ${input.workflowId} changed its immutable plan`);
    }
    if (normalized.fence < existing.fence) {
      tx.abort();
      throw new Error(`Native analysis workflow ${input.workflowId} fence moved backwards`);
    }
  }
  const timestamp = nowIso();
  const record: NativeAnalysisWorkflowFenceRecord = {
    ...normalized,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  store.put(record);
  await transactionDone(tx);
  return record;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertStageMatchesPlan(
  input: StageNativeAnalysisOutputInput,
  workflow: NativeAnalysisWorkflowFenceRecord,
): void {
  if (
    workflow.workflowId !== input.workflowId ||
    workflow.novelId !== input.novelId ||
    workflow.contentRevisionId !== input.expectedContentRevisionId ||
    workflow.planHash !== input.planHash ||
    workflow.fence !== input.workflowFence
  ) {
    throw new Error('Native analysis checkpoint does not match the active workflow fence');
  }
  const job = workflow.jobs.find((candidate) => candidate.jobId === input.jobId);
  if (
    !job ||
    job.artifactType !== input.artifactType ||
    job.chapterId !== input.chapterId ||
    !sameStrings(job.plannedParagraphIds, input.plannedParagraphIds)
  ) {
    throw new Error('Native analysis checkpoint does not match its planned job');
  }
}

export async function stageNativeAnalysisOutput(
  input: StageNativeAnalysisOutputInput,
): Promise<NativeAnalysisStagedOutput> {
  const plannedParagraphIds = uniqueStrings(input.plannedParagraphIds, 'native analysis planned paragraph ids');
  const calculatedHash = analysisOutputIntegrityHash(input.payload);
  if (calculatedHash !== input.outputHash) throw new Error('Native analysis checkpoint output hash mismatch');
  if (input.payload.kind !== input.artifactType) throw new Error('Native analysis checkpoint payload type mismatch');
  if (input.payload.kind === 'label_window' && input.payload.chapterId !== input.chapterId) {
    throw new Error('Native analysis label checkpoint chapter mismatch');
  }

  const db = await openReaderDb();
  const tx = db.transaction([NATIVE_ANALYSIS_STORES.workflows, NATIVE_ANALYSIS_STORES.staging], 'readwrite');
  const workflow = await requestToPromise<NativeAnalysisWorkflowFenceRecord | undefined>(
    tx.objectStore(NATIVE_ANALYSIS_STORES.workflows).get(nativeAnalysisWorkflowRecordId(input.workflowId)),
  );
  if (!workflow) {
    tx.abort();
    throw new Error(`Native analysis workflow fence not found: ${input.workflowId}`);
  }
  assertStageMatchesPlan({ ...input, plannedParagraphIds }, workflow);

  const store = tx.objectStore(NATIVE_ANALYSIS_STORES.staging);
  const id = nativeAnalysisStagedOutputId({ ...input, plannedParagraphIds });
  const existing = await requestToPromise<NativeAnalysisStagedOutput | undefined>(store.get(id));
  if (existing) {
    await transactionDone(tx);
    return existing;
  }
  const record: NativeAnalysisStagedOutput = {
    ...input,
    id,
    plannedParagraphIds,
    status: 'staged',
    createdAt: nowIso(),
  };
  store.put(record);
  await transactionDone(tx);
  return record;
}

export async function getNativeAnalysisStagedOutput(
  artifactId: string,
): Promise<NativeAnalysisStagedOutput | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(NATIVE_ANALYSIS_STORES.staging, 'readonly');
  const record = await requestToPromise<NativeAnalysisStagedOutput | undefined>(
    tx.objectStore(NATIVE_ANALYSIS_STORES.staging).get(artifactId),
  );
  await transactionDone(tx);
  return record;
}

export async function listNativeAnalysisStagedOutputs(workflowId: string): Promise<NativeAnalysisStagedOutput[]> {
  const db = await openReaderDb();
  const tx = db.transaction(NATIVE_ANALYSIS_STORES.staging, 'readonly');
  const records = await requestToPromise<NativeAnalysisStagedOutput[]>(
    tx.objectStore(NATIVE_ANALYSIS_STORES.staging).index('workflowId').getAll(workflowId),
  );
  await transactionDone(tx);
  return records.sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

export async function saveNativeAnalysisReviewDraft(input: {
  artifactId: string;
  expectedReviewRevision: number;
  candidate: ChapterLabelingResult;
  editIntents: AnalysisReviewEditIntentMap;
}): Promise<NativeAnalysisStagedOutput> {
  const db = await openReaderDb();
  const tx = db.transaction(NATIVE_ANALYSIS_STORES.staging, 'readwrite');
  const store = tx.objectStore(NATIVE_ANALYSIS_STORES.staging);
  const artifact = await requestToPromise<NativeAnalysisStagedOutput | undefined>(store.get(input.artifactId));
  if (!artifact) {
    tx.abort();
    throw new Error(`Native analysis review artifact not found: ${input.artifactId}`);
  }
  const currentRevision = artifact.reviewRevision ?? 1;
  if (currentRevision !== input.expectedReviewRevision || artifact.status !== 'staged') {
    tx.abort();
    throw new Error('Native analysis review changed before the draft was saved');
  }
  const updated: NativeAnalysisStagedOutput = {
    ...artifact,
    reviewDraft: JSON.parse(JSON.stringify(input.candidate)) as ChapterLabelingResult,
    reviewEditIntents: JSON.parse(JSON.stringify(input.editIntents)) as AnalysisReviewEditIntentMap,
    reviewRevision: currentRevision + 1,
    reviewStatus: 'editing',
    reviewUpdatedAt: nowIso(),
  };
  store.put(updated);
  await transactionDone(tx);
  return updated;
}

export async function rejectNativeAnalysisReview(input: {
  artifactId: string;
  expectedReviewRevision: number;
  reason?: string;
}): Promise<NativeAnalysisStagedOutput> {
  const db = await openReaderDb();
  const tx = db.transaction(NATIVE_ANALYSIS_STORES.staging, 'readwrite');
  const store = tx.objectStore(NATIVE_ANALYSIS_STORES.staging);
  const artifact = await requestToPromise<NativeAnalysisStagedOutput | undefined>(store.get(input.artifactId));
  if (!artifact) {
    tx.abort();
    throw new Error(`Native analysis review artifact not found: ${input.artifactId}`);
  }
  const currentRevision = artifact.reviewRevision ?? 1;
  if (currentRevision !== input.expectedReviewRevision || artifact.status !== 'staged') {
    tx.abort();
    throw new Error('Native analysis review changed before it was rejected');
  }
  const updated: NativeAnalysisStagedOutput = {
    ...artifact,
    reviewRevision: currentRevision + 1,
    reviewStatus: 'rejected',
    reviewReason: input.reason?.trim() || undefined,
    reviewUpdatedAt: nowIso(),
  };
  store.put(updated);
  await transactionDone(tx);
  return updated;
}

export async function listNativeAnalysisProvenance(novelId: string): Promise<NativeAnalysisPromotionProvenance[]> {
  const db = await openReaderDb();
  const tx = db.transaction(NATIVE_ANALYSIS_STORES.provenance, 'readonly');
  const records = await requestToPromise<NativeAnalysisPromotionProvenance[]>(
    tx.objectStore(NATIVE_ANALYSIS_STORES.provenance).index('novelId').getAll(novelId),
  );
  await transactionDone(tx);
  return records.sort((left, right) => left.promotedAt.localeCompare(right.promotedAt));
}
