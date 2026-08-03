import { persistentId128 } from '@noveldesk/text-core/hash';
import type pg from 'pg';
import type {
  AnalysisReviewDecisionAction,
  AnalysisReviewStatus,
  ChapterLabelAnalysisReviewArtifact,
} from '../../../../../src/providers/analysis-review';
import type { ChapterLabelingResult } from '../../../../../src/providers/ai';
import type { ChapterLabelingQualityReport } from '../../../../../src/providers/chapter-labeling-quality';
import type { ChapterLabelingValidationReport } from '../../../../../src/providers/chapter-labeling-validator';
import type { ProviderExecutionMetadata } from '../../../../../src/providers/provider-execution';
import type { AnalysisInputRevision, AnalysisStagingArtifact } from './analysis-input-contracts.js';
import { loadAnalysisInputRevision } from './analysis-input-repository.js';
import type { RevisionQueryable } from './analysis-input-repository.js';
import { requireAnalysisReviewChapterSource } from './analysis-review-source.js';

interface AnalysisReviewRow extends pg.QueryResultRow {
  id: string;
  workflow_id: string;
  provider_job_id: string;
  input_revision_id: string;
  staging_artifact_id: string;
  review_kind: 'chapter_labeling';
  window_id: string;
  chapter_id: string;
  normalized_candidate: unknown;
  candidate_hash: string;
  generated_candidate: unknown;
  generated_candidate_hash: string;
  edit_intents: unknown;
  validation_issues: unknown;
  quality_issues: unknown;
  validation_summary: unknown;
  quality_summary: unknown;
  provider_execution_metadata: unknown;
  status: AnalysisReviewStatus;
  review_revision: number | string;
  content_revision_id: string;
  revision_fence: number | string;
  graph_revision_id: string | null;
  graph_fingerprint: string;
  correction_fingerprint: string;
  promoted_artifact_id: string | null;
  promotion_attempt_count: number | string;
  promotion_last_error_code: string | null;
  promotion_last_error_at: Date | string | null;
  next_reconcile_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  promoted_at: Date | string | null;
  expires_at: Date | string | null;
}

const reviewColumns = `
  id, workflow_id, provider_job_id, input_revision_id, staging_artifact_id,
  review_kind, window_id, chapter_id, normalized_candidate, candidate_hash,
  generated_candidate, generated_candidate_hash, edit_intents,
  validation_issues, quality_issues, validation_summary, quality_summary,
  provider_execution_metadata, status, review_revision, content_revision_id,
  revision_fence, graph_revision_id, graph_fingerprint, correction_fingerprint,
  promoted_artifact_id, promotion_attempt_count, promotion_last_error_code,
  promotion_last_error_at, next_reconcile_at, created_at, updated_at, promoted_at, expires_at
`;

function iso(value: Date | string | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function recordValue<T>(value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as T;
  return value as T;
}

async function mapReviewArtifact(
  db: RevisionQueryable,
  row: AnalysisReviewRow,
): Promise<ChapterLabelAnalysisReviewArtifact> {
  const revision = await loadAnalysisInputRevision(db, row.input_revision_id);
  if (!revision) {
    throw new Error(`Analysis review input revision is unavailable: ${row.input_revision_id}`);
  }
  const source = requireAnalysisReviewChapterSource(revision);
  return {
    id: row.id,
    workflowId: row.workflow_id,
    providerJobId: row.provider_job_id,
    inputRevisionId: row.input_revision_id,
    stagingArtifactId: row.staging_artifact_id,
    reviewKind: row.review_kind,
    windowId: row.window_id,
    chapterId: row.chapter_id,
    chapter: source.chapter,
    paragraphs: [...source.paragraphs],
    haloParagraphs:
      revision.sourceSnapshot.kind === 'chapter_labeling'
        ? [...(revision.sourceSnapshot.contextPacket?.halo ?? [])]
        : [],
    characterOptions: revision.graphSnapshot.characters.map((character) => ({
      id: character.id,
      canonicalName: character.canonicalName,
      aliases: [...character.aliases],
    })),
    candidate: row.normalized_candidate as ChapterLabelingResult,
    candidateHash: row.candidate_hash,
    originalCandidate: row.generated_candidate as ChapterLabelingResult,
    originalCandidateHash: row.generated_candidate_hash,
    editIntents: recordValue(row.edit_intents),
    validationIssues: arrayValue(row.validation_issues),
    qualityIssues: arrayValue(row.quality_issues),
    validationSummary: recordValue(row.validation_summary),
    qualitySummary: recordValue(row.quality_summary),
    providerExecution: row.provider_execution_metadata
      ? recordValue<ProviderExecutionMetadata>(row.provider_execution_metadata)
      : undefined,
    status: row.status,
    reviewRevision: Number(row.review_revision),
    contentRevisionId: row.content_revision_id,
    revisionFence: Number(row.revision_fence),
    graphRevisionId: row.graph_revision_id ?? undefined,
    graphFingerprint: row.graph_fingerprint,
    correctionFingerprint: row.correction_fingerprint,
    promotedArtifactId: row.promoted_artifact_id ?? undefined,
    promotionAttemptCount: Number(row.promotion_attempt_count ?? 0),
    promotionLastErrorCode: row.promotion_last_error_code ?? undefined,
    promotionLastErrorAt: iso(row.promotion_last_error_at),
    nextReconcileAt: iso(row.next_reconcile_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    promotedAt: iso(row.promoted_at),
    expiresAt: iso(row.expires_at),
  };
}

export async function ensureChapterLabelAnalysisReview(
  db: RevisionQueryable,
  input: {
    readonly revision: AnalysisInputRevision;
    readonly artifact: AnalysisStagingArtifact;
    readonly candidate: ChapterLabelingResult;
    readonly validation: ChapterLabelingValidationReport;
    readonly quality: ChapterLabelingQualityReport;
    readonly attemptId?: string;
    readonly providerExecution?: ProviderExecutionMetadata;
  },
): Promise<ChapterLabelAnalysisReviewArtifact> {
  if (!input.revision.workflowId || !input.revision.chapterId) {
    throw new Error('Analysis review requires a workflow-owned chapter input revision');
  }
  requireAnalysisReviewChapterSource(input.revision);
  const id = persistentId128('analysis_review_artifact', [input.artifact.id, input.artifact.outputHash]);
  await db.query(
    `
      insert into analysis_review_artifacts (
        id, workflow_id, provider_job_id, attempt_id, user_id, book_id, chapter_id,
        input_revision_id, staging_artifact_id, review_kind, window_id,
        normalized_candidate, candidate_hash, generated_candidate, generated_candidate_hash,
        edit_intents, validation_issues, quality_issues,
        validation_summary, quality_summary, provider_execution_metadata,
        content_revision_id, revision_fence, graph_revision_id,
        graph_fingerprint, correction_fingerprint, status, created_at, updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, 'chapter_labeling', $10,
        $11, $12, $11, $12, '{}'::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
        'open', now(), now()
      )
      on conflict (staging_artifact_id) do nothing
    `,
    [
      id,
      input.revision.workflowId,
      input.revision.providerJobId,
      input.attemptId ?? null,
      input.revision.userId,
      input.revision.bookId,
      input.revision.chapterId,
      input.revision.id,
      input.artifact.id,
      input.revision.windowSpec.windowId,
      JSON.stringify(input.candidate),
      input.artifact.outputHash,
      JSON.stringify(input.validation.issues),
      JSON.stringify(input.quality.issues),
      JSON.stringify(input.validation.summary),
      JSON.stringify(input.quality.summary),
      input.providerExecution ? JSON.stringify(input.providerExecution) : null,
      input.revision.contentRevisionId,
      input.revision.revisionFence,
      input.revision.characterGraphRevisionId ?? null,
      input.revision.characterGraphFingerprint,
      input.revision.correctionFingerprint,
    ],
  );
  const review = await loadAnalysisReviewArtifact(db, id, input.revision.userId);
  if (!review) throw new Error(`Analysis review artifact could not be loaded: ${id}`);
  return review;
}

export async function loadAnalysisReviewArtifact(
  db: RevisionQueryable,
  reviewId: string,
  userId: string,
  lock = false,
): Promise<ChapterLabelAnalysisReviewArtifact | undefined> {
  const result = await db.query<AnalysisReviewRow>(
    `select ${reviewColumns} from analysis_review_artifacts where id = $1 and user_id = $2${lock ? ' for update' : ''}`,
    [reviewId, userId],
  );
  return result.rows[0] ? mapReviewArtifact(db, result.rows[0]) : undefined;
}

export async function listAnalysisReviewArtifacts(
  db: RevisionQueryable,
  workflowId: string,
  userId: string,
): Promise<ChapterLabelAnalysisReviewArtifact[]> {
  const result = await db.query<AnalysisReviewRow>(
    `
      select ${reviewColumns}
      from analysis_review_artifacts
      where workflow_id = $1 and user_id = $2
      order by created_at asc, id asc
    `,
    [workflowId, userId],
  );
  return Promise.all(result.rows.map((row) => mapReviewArtifact(db, row)));
}

export async function analysisReviewStatusForStagingArtifact(
  db: RevisionQueryable,
  stagingArtifactId: string,
): Promise<AnalysisReviewStatus | undefined> {
  const result = await db.query<{ status: AnalysisReviewStatus }>(
    `select status from analysis_review_artifacts where staging_artifact_id = $1`,
    [stagingArtifactId],
  );
  return result.rows[0]?.status;
}

export async function persistAnalysisReviewDecision(
  db: RevisionQueryable,
  input: {
    readonly reviewId: string;
    readonly userId: string;
    readonly expectedReviewRevision: number;
    readonly action: AnalysisReviewDecisionAction;
    readonly status: AnalysisReviewStatus;
    readonly candidate?: ChapterLabelingResult;
    readonly candidateHash?: string;
    readonly editIntents?: ChapterLabelAnalysisReviewArtifact['editIntents'];
    readonly validation?: ChapterLabelingValidationReport;
    readonly quality?: ChapterLabelingQualityReport;
    readonly patch?: Readonly<Record<string, unknown>>;
    readonly provenance?: Readonly<Record<string, unknown>>;
  },
): Promise<ChapterLabelAnalysisReviewArtifact | undefined> {
  const resultingRevision = input.expectedReviewRevision + 1;
  const updated = await db.query<AnalysisReviewRow>(
    `
      update analysis_review_artifacts
      set status = $4,
          normalized_candidate = coalesce($5::jsonb, normalized_candidate),
          candidate_hash = coalesce($6, candidate_hash),
          edit_intents = coalesce($7::jsonb, edit_intents),
          validation_issues = coalesce($8::jsonb, validation_issues),
          quality_issues = coalesce($9::jsonb, quality_issues),
          validation_summary = coalesce($10::jsonb, validation_summary),
          quality_summary = coalesce($11::jsonb, quality_summary),
          review_revision = $12,
          promotion_attempt_count = case
            when $4 = 'approved' then promotion_attempt_count + 1
            else promotion_attempt_count
          end,
          next_reconcile_at = case when $4 = 'approved' then now() else next_reconcile_at end,
          promotion_last_error_code = case when $4 = 'approved' then null else promotion_last_error_code end,
          promotion_last_error_at = case when $4 = 'approved' then null else promotion_last_error_at end,
          updated_at = now()
      where id = $1 and user_id = $2 and review_revision = $3
        and status in ('open', 'editing', 'validating')
      returning ${reviewColumns}
    `,
    [
      input.reviewId,
      input.userId,
      input.expectedReviewRevision,
      input.status,
      input.candidate ? JSON.stringify(input.candidate) : null,
      input.candidateHash ?? null,
      input.editIntents ? JSON.stringify(input.editIntents) : null,
      input.validation ? JSON.stringify(input.validation.issues) : null,
      input.quality ? JSON.stringify(input.quality.issues) : null,
      input.validation ? JSON.stringify(input.validation.summary) : null,
      input.quality ? JSON.stringify(input.quality.summary) : null,
      resultingRevision,
    ],
  );
  if (!updated.rows[0]) return undefined;
  const decisionId = persistentId128('analysis_review_decision', [
    input.reviewId,
    String(resultingRevision),
    input.action,
  ]);
  await db.query(
    `
      insert into analysis_review_decisions (
        id, review_artifact_id, expected_review_revision, resulting_review_revision,
        action, patch, actor_type, actor_id, decision_provenance, created_at
      )
      values ($1, $2, $3, $4, $5, $6, 'user', $7, $8, now())
    `,
    [
      decisionId,
      input.reviewId,
      input.expectedReviewRevision,
      resultingRevision,
      input.action,
      input.patch ? JSON.stringify(input.patch) : null,
      input.userId,
      JSON.stringify(input.provenance ?? {}),
    ],
  );
  return mapReviewArtifact(db, updated.rows[0]);
}

export interface AnalysisReviewReconcileClaim {
  readonly reviewId: string;
  readonly reviewRevision: number;
  readonly status: 'approved' | 'promoting' | 'promoted';
  readonly attemptCount: number;
}

export async function claimAnalysisReviewsForReconciliation(
  db: RevisionQueryable,
  input: {
    readonly userId: string;
    readonly owner: string;
    readonly limit: number;
    readonly leaseMs: number;
  },
): Promise<AnalysisReviewReconcileClaim[]> {
  const result = await db.query<{
    id: string;
    review_revision: number | string;
    status: AnalysisReviewReconcileClaim['status'];
    promotion_attempt_count: number | string;
  }>(
    `
      with due as (
        select id
        from analysis_review_artifacts
        where user_id = $1
          and status in ('approved', 'promoting', 'promoted')
          and next_reconcile_at <= now()
          and (reconcile_lease_expires_at is null or reconcile_lease_expires_at <= now())
        order by next_reconcile_at asc, id asc
        limit $3
        for update skip locked
      )
      update analysis_review_artifacts review
      set reconcile_lease_owner = $2,
          reconcile_lease_expires_at = now() + ($4::integer * interval '1 millisecond'),
          promotion_attempt_count = promotion_attempt_count + 1,
          updated_at = now()
      from due
      where review.id = due.id
      returning review.id, review.review_revision, review.status, review.promotion_attempt_count
    `,
    [input.userId, input.owner, input.limit, input.leaseMs],
  );
  return result.rows.map((row) => ({
    reviewId: row.id,
    reviewRevision: Number(row.review_revision),
    status: row.status,
    attemptCount: Number(row.promotion_attempt_count),
  }));
}

export async function completeAnalysisReviewReconciliation(
  db: RevisionQueryable,
  input: { readonly reviewId: string; readonly userId: string; readonly owner?: string },
): Promise<boolean> {
  const result = await db.query(
    `
      update analysis_review_artifacts
      set reconcile_lease_owner = null,
          reconcile_lease_expires_at = null,
          next_reconcile_at = null,
          promotion_last_error_code = null,
          promotion_last_error_at = null,
          updated_at = now()
      where id = $1 and user_id = $2
        and (
          ($3::text is null and reconcile_lease_owner is null)
          or reconcile_lease_owner = $3
        )
    `,
    [input.reviewId, input.userId, input.owner ?? null],
  );
  return result.rowCount == null ? true : result.rowCount > 0;
}

export async function deferAnalysisReviewReconciliation(
  db: RevisionQueryable,
  input: {
    readonly reviewId: string;
    readonly userId: string;
    readonly owner: string;
    readonly errorCode: string;
    readonly retryAfterMs?: number;
  },
): Promise<boolean> {
  const result = await db.query(
    `
      update analysis_review_artifacts
      set reconcile_lease_owner = null,
          reconcile_lease_expires_at = null,
          next_reconcile_at = case
            when $5::integer is null then null
            else now() + ($5::integer * interval '1 millisecond')
          end,
          promotion_last_error_code = $4,
          promotion_last_error_at = now(),
          updated_at = now()
      where id = $1 and user_id = $2 and reconcile_lease_owner = $3
    `,
    [input.reviewId, input.userId, input.owner, input.errorCode, input.retryAfterMs ?? null],
  );
  return result.rowCount == null ? true : result.rowCount > 0;
}

export async function obsoleteAnalysisReviewReconciliation(
  db: RevisionQueryable,
  input: {
    readonly reviewId: string;
    readonly userId: string;
    readonly errorCode: string;
    readonly owner?: string;
  },
): Promise<boolean> {
  const result = await db.query(
    `
      update analysis_review_artifacts
      set status = 'obsolete',
          review_revision = review_revision + 1,
          reconcile_lease_owner = null,
          reconcile_lease_expires_at = null,
          next_reconcile_at = null,
          promotion_last_error_code = $4,
          promotion_last_error_at = now(),
          updated_at = now()
      where id = $1 and user_id = $2
        and status in ('approved', 'promoting')
        and (
          ($3::text is null and reconcile_lease_owner is null)
          or reconcile_lease_owner = $3
        )
    `,
    [input.reviewId, input.userId, input.owner ?? null, input.errorCode],
  );
  return result.rowCount == null ? true : result.rowCount > 0;
}
