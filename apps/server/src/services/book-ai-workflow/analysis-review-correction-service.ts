import { aggregateSyncEntityId, resourceCollectionRevision, syncEventId } from '@noveldesk/text-core/identity/sync';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { UserCorrection } from '@noveldesk/contracts';
import type pg from 'pg';
import type { LabeledSegment } from '@noveldesk/contracts';
import type { ChapterLabelAnalysisReviewArtifact } from '../../../../../src/providers/analysis-review';
import type { AnalysisReviewCorrectionPlanV2 } from '../../../../../src/providers/analysis-review-correction';
import type { ApplyLabelCorrectionsResultV2 } from '../../../../../src/providers/label-mutation-contract';
import type { ServerConfig } from '../../config.js';
import { mapCorrection } from '../../routes/ai/artifact-row-mappers.js';
import { insertServerSyncEvent, serverRevision } from '../../routes/ai/sync-event-repository.js';
import { resolveExactParagraphSourceAnchor } from '../book-revision/source-anchor-repository.js';

const chapterSegmentsRevision = (segments: readonly LabeledSegment[]) =>
  resourceCollectionRevision('chapter_segments', segments);
const correctionsRevision = (corrections: readonly UserCorrection[]) =>
  resourceCollectionRevision('user_corrections', corrections);

async function activeCorrections(client: pg.PoolClient, bookId: string): Promise<UserCorrection[]> {
  const result = await client.query(
    `
      select id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
             before_json, after_json, apply_scope, operation_id, intent_kind, intent_json,
             provenance_kind, source_review_artifact_id, created_at
      from user_corrections
      where book_id = $1 and lifecycle_state = 'active'
      order by created_at asc, id asc
      for update
    `,
    [bookId],
  );
  return result.rows.map(mapCorrection);
}

export async function persistAnalysisReviewCorrectionPlan(
  client: pg.PoolClient,
  config: ServerConfig,
  review: ChapterLabelAnalysisReviewArtifact,
  plan: AnalysisReviewCorrectionPlanV2,
): Promise<ApplyLabelCorrectionsResultV2> {
  const bookId = review.candidate.segments[0]?.novelId;
  if (!bookId) throw new Error('Analysis review candidate has no book id');
  const existingCorrections = await activeCorrections(client, bookId);

  for (const correction of plan.corrections) {
    const anchor = correction.paragraphId
      ? await resolveExactParagraphSourceAnchor(client, config.defaultUserId, bookId, correction.paragraphId)
      : undefined;
    await client.query(
      `
        insert into user_corrections (
          id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
          before_json, after_json, apply_scope, source_content_revision_id,
          source_anchor, source_anchor_hash, lifecycle_state, operation_id,
          intent_kind, intent_json, provenance_kind, source_review_artifact_id, created_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
          $11::jsonb, $12, 'active', $13, $14, $15::jsonb, $16, $17, $18
        )
        on conflict (id) do nothing
      `,
      [
        correction.id,
        bookId,
        review.chapterId,
        correction.paragraphId ?? null,
        correction.segmentId ?? null,
        correction.correctionType,
        correction.beforeJson ?? null,
        correction.afterJson,
        correction.applyScope,
        anchor?.contentRevisionId ?? review.contentRevisionId,
        anchor ? JSON.stringify(anchor.anchor) : null,
        anchor?.hash ?? null,
        plan.operationId,
        correction.intentKind ?? null,
        correction.intentJson ?? null,
        correction.provenanceKind ?? 'user_label_mutation',
        review.id,
        correction.createdAt,
      ],
    );
  }

  const staleTTS =
    plan.staleTTSSegmentIds.length > 0
      ? await client.query<{ id: string }>(
          `
            update tts_audio_cache
            set lifecycle_state = 'stale', updated_at = now()
            where book_id = $1 and lifecycle_state = 'active' and segment_ids ?| $2::text[]
            returning id
          `,
          [bookId, plan.staleTTSSegmentIds],
        )
      : { rows: [] as { id: string }[] };
  const obsolete = await client.query<{ id: string }>(
    `
      update analysis_review_artifacts
      set status = 'obsolete', review_revision = review_revision + 1,
          promotion_last_error_code = 'review_edit_superseded',
          promotion_last_error_at = now(), next_reconcile_at = null, updated_at = now()
      where user_id = $1 and book_id = $2 and chapter_id = $3 and id <> $4
        and status in ('open', 'editing', 'validating', 'approved', 'promoting')
      returning id
    `,
    [config.defaultUserId, bookId, review.chapterId, review.id],
  );

  const correctionSyncEventIds: string[] = [];
  for (const correction of plan.corrections) {
    const payload = { correction };
    const seed = `review_correction:${plan.operationId}:${correction.id}`;
    await insertServerSyncEvent(client, config.defaultUserId, {
      seed,
      type: 'user_correction_created',
      bookId,
      entityId: correction.id,
      payload,
      revision: serverRevision({
        entityType: 'user_correction',
        entityId: correction.id,
        novelId: bookId,
        updatedAt: correction.createdAt,
        payload,
      }),
      createdAt: correction.createdAt,
    });
    correctionSyncEventIds.push(
      syncEventId({
        userId: config.defaultUserId,
        type: 'user_correction_created',
        novelId: bookId,
        entityId: correction.id,
        seed,
      }),
    );
  }

  const segmentEntityId = aggregateSyncEntityId({
    entityType: 'chapter_segments',
    novelId: bookId,
    chapterId: review.chapterId,
  });
  const result: ApplyLabelCorrectionsResultV2 = {
    operationId: plan.operationId,
    revisions: {
      segmentCollectionRevision: chapterSegmentsRevision(plan.segments),
      correctionRevisionId: correctionsRevision([...existingCorrections, ...plan.corrections]),
    },
    updatedSegmentIds: Object.keys(plan.changedFieldsBySegment).sort(),
    createdCorrectionIds: plan.corrections.map((correction) => correction.id).sort(),
    invalidation: {
      contextFromWindowId: plan.contextFromWindowId,
      relabelPlanId: plan.relabelPlanId,
      obsoleteReviewArtifactIds: obsolete.rows.map((row) => row.id).sort(),
      staleTTSRenderItemIds: staleTTS.rows.map((row) => row.id).sort(),
    },
    syncEventIds: correctionSyncEventIds,
  };
  const command = {
    kind: 'analysis_review_approval',
    operationId: plan.operationId,
    reviewArtifactId: review.id,
    originalCandidateHash: review.originalCandidateHash,
    approvedCandidateHash: review.candidateHash,
    editIntents: review.editIntents,
    segmentEntityId,
  };
  await client.query(
    `
      insert into label_mutation_operations (
        id, user_id, book_id, chapter_id, source_review_artifact_id,
        command_hash, command_json, expected_fences, result_json, applied_at, created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, now())
      on conflict (id) do nothing
    `,
    [
      plan.operationId,
      config.defaultUserId,
      bookId,
      review.chapterId,
      review.id,
      structuredIntegrityHash(command),
      JSON.stringify(command),
      JSON.stringify({
        contentRevisionId: review.contentRevisionId,
        graphRevisionId: review.graphRevisionId,
        graphFingerprint: review.graphFingerprint,
        correctionFingerprint: review.correctionFingerprint,
        reviewRevision: review.reviewRevision,
      }),
      JSON.stringify(result),
      plan.corrections[0]?.createdAt ?? review.updatedAt,
    ],
  );
  if (plan.relabelPlanId) {
    await client.query(
      `
        insert into label_reanalysis_plans (
          id, operation_id, user_id, book_id, chapter_id, from_window_id, intent_json, status, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', now(), now())
        on conflict (id) do nothing
      `,
      [
        plan.relabelPlanId,
        plan.operationId,
        config.defaultUserId,
        bookId,
        review.chapterId,
        plan.contextFromWindowId ?? review.windowId,
        JSON.stringify(review.editIntents),
      ],
    );
  }
  await client.query(
    `
      insert into label_mutation_invalidations (
        operation_id, book_id, chapter_id, context_from_window_id,
        obsolete_review_artifact_ids, stale_tts_render_item_ids, created_at
      )
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
      on conflict (operation_id) do nothing
    `,
    [
      plan.operationId,
      bookId,
      review.chapterId,
      plan.contextFromWindowId ?? null,
      JSON.stringify(result.invalidation.obsoleteReviewArtifactIds),
      JSON.stringify(result.invalidation.staleTTSRenderItemIds),
    ],
  );
  return result;
}
