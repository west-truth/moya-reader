import { analysisRunId as createAnalysisRunId } from '@noveldesk/text-core/identity/ai';
import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { Queue } from 'bullmq';
import type pg from 'pg';
import type { ChapterLabelAnalysisReviewArtifact } from '../../../../../src/providers/analysis-review';
import { buildAnalysisReviewCorrectionPlanV2 } from '../../../../../src/providers/analysis-review-correction';
import {
  createAcceptedSpeakerProvenance,
  createManualReviewSpeakerProvenanceDraft,
  parseSpeakerSegmentProvenanceDrafts,
} from '../../../../../src/providers/speaker-attribution/accepted-speaker-provenance';
import { speakerSegmentProvenanceDraftsFingerprint } from '../../../../../src/providers/speaker-attribution/speaker-provenance-projection';
import { validateChapterLabelingQuality } from '../../../../../src/providers/chapter-labeling-quality';
import { validateChapterLabelingResult } from '../../../../../src/providers/chapter-labeling-validator';
import type { ServerConfig } from '../../config.js';
import { replaceGeneratedSegments, upsertChapterContext } from '../provider-jobs/entity-write-repository.js';
import {
  loadProviderJob,
  lockProviderJobForPersistence,
  updateProviderJobProgress,
} from '../provider-jobs/job-lifecycle.js';
import { recordValue } from '../provider-jobs/job-progress.js';
import { advanceBookAIWorkflow } from './workflow-orchestrator.js';
import { loadAnalysisInputRevision } from './analysis-input-repository.js';
import { AnalysisInputStaleError } from './analysis-input-contracts.js';
import { analysisReviewRequestProfile, requireAnalysisReviewChapterSource } from './analysis-review-source.js';
import {
  completeAnalysisReviewReconciliation,
  loadAnalysisReviewArtifact,
  obsoleteAnalysisReviewReconciliation,
  persistAnalysisReviewDecision,
} from './analysis-review-repository.js';
import {
  AnalysisReviewConflictError,
  AnalysisReviewInputError,
  AnalysisReviewNotFoundError,
} from './analysis-review-service.js';
import { verifyAnalysisPromotionFence } from './artifact-promotion-service.js';
import { episodeContextFromResult, insertWorkflowEpisodeContext } from './episode-context-repository.js';
import {
  insertPromotedAnalysisRun,
  insertPromotionSyncEvent,
  updateBookAnalysisStatus,
} from './promotion-repository.js';
import {
  loadAnalysisArtifact,
  markAnalysisArtifactPromoted,
  stageAnalysisArtifact,
} from './staging-artifact-repository.js';
import { withBookAITransaction } from './transaction.js';
import { cancelWorkflowProviderJob, loadActiveWorkflowJobs } from './workflow-cancellation-repository.js';
import { persistAnalysisReviewCorrectionPlan } from './analysis-review-correction-service.js';
import {
  rebaseHostedSpeakerArtifactDependencies,
  replaceHostedAcceptedSpeakerProvenanceForParagraphs,
} from '../speaker-workflow-state-service.js';

async function validateApprovedReview(client: pg.PoolClient, review: ChapterLabelAnalysisReviewArtifact) {
  const revision = await loadAnalysisInputRevision(client, review.inputRevisionId);
  if (!revision) {
    throw new AnalysisReviewConflictError('Analysis review source revision is unavailable');
  }
  const source = requireAnalysisReviewChapterSource(revision);
  const profile = analysisReviewRequestProfile(revision);
  const validation = validateChapterLabelingResult({
    novelId: revision.bookId,
    chapter: source.chapter,
    paragraphs: [...source.paragraphs],
    knownCharacters: revision.graphSnapshot.characters,
    characterGraph: revision.graphSnapshot,
    previousEpisodeContext: revision.episodeContextSnapshot,
    userCorrections: [...revision.correctionsSnapshot],
    validationPolicy: profile.validationPolicy,
    result: review.candidate,
  });
  const quality = validateChapterLabelingQuality({
    chapter: source.chapter,
    paragraphs: [...source.paragraphs],
    result: review.candidate,
  });
  if (!validation.ok || !quality.ok) {
    throw new AnalysisReviewInputError('Analysis review candidate must pass validation and quality before approval');
  }
  return { revision, source, profile, validation, quality };
}

export async function promoteApprovedAnalysisReview(
  pool: pg.Pool,
  config: ServerConfig,
  reviewId: string,
  queue: Queue | undefined,
): Promise<ChapterLabelAnalysisReviewArtifact> {
  const workflowId = await withBookAITransaction(pool, async (client) => {
    const review = await loadAnalysisReviewArtifact(client, reviewId, config.defaultUserId, true);
    if (!review) throw new AnalysisReviewNotFoundError(reviewId);
    if (review.status === 'promoted') return review.workflowId;
    if (!['approved', 'promoting'].includes(review.status)) {
      throw new AnalysisReviewConflictError(`Analysis review is not approved: ${review.status}`);
    }
    const { revision, source, profile, validation, quality } = await validateApprovedReview(client, review);
    const job = await loadProviderJob(client, review.providerJobId, config.defaultUserId);
    await verifyAnalysisPromotionFence(client, revision, job);
    await lockProviderJobForPersistence(client, job);
    const promoting = await client.query(
      `
        update analysis_review_artifacts
        set status = 'promoting', updated_at = now()
        where id = $1 and user_id = $2 and status in ('approved', 'promoting')
      `,
      [review.id, config.defaultUserId],
    );
    if (promoting.rowCount !== undefined && promoting.rowCount !== 1) {
      throw new AnalysisReviewConflictError('Analysis review changed before promotion');
    }

    const correctionPlan = buildAnalysisReviewCorrectionPlanV2({
      operationId: persistentId128('analysis_review_label_mutation', [review.id, String(review.reviewRevision)]),
      reviewArtifactId: review.id,
      bookId: revision.bookId,
      chapterId: source.chapter.id,
      windowId: review.windowId,
      createdAt: new Date().toISOString(),
      original: review.originalCandidate,
      approved: review.candidate,
      editIntents: review.editIntents,
    });
    const promotedCandidate = { ...review.candidate, segments: [...correctionPlan.segments] };
    const sourceArtifact = await loadAnalysisArtifact(client, review.stagingArtifactId);
    const sourceSpeakerProvenanceDrafts = parseSpeakerSegmentProvenanceDrafts(
      sourceArtifact?.metadata.speakerProvenanceDrafts,
    );
    const promotedSegmentById = new Map(correctionPlan.segments.map((segment) => [segment.id, segment] as const));
    const speakerEntityIdByCanonicalSpeakerId =
      revision.sourceSnapshot.kind === 'speaker_attribution_v3'
        ? Object.fromEntries(
            Object.entries(revision.sourceSnapshot.canonicalSource.speakerIdByEntityId)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([speakerEntityId, canonicalSpeakerId]) => [canonicalSpeakerId, speakerEntityId]),
          )
        : {};
    const promotedSpeakerProvenanceDrafts = sourceSpeakerProvenanceDrafts.map((draft) => {
      const segment = promotedSegmentById.get(draft.segmentId);
      if (!segment) throw new AnalysisReviewConflictError(`Speaker provenance segment is missing: ${draft.segmentId}`);
      return createManualReviewSpeakerProvenanceDraft({
        draft,
        promotedSpeakerId: segment.speakerId,
        speakerEntityIdByCanonicalSpeakerId,
        speakerEdited: correctionPlan.changedFieldsBySegment[segment.id]?.includes('speakerId') === true,
      });
    });
    if (
      sourceSpeakerProvenanceDrafts.length > 0 &&
      promotedSpeakerProvenanceDrafts.length !== correctionPlan.segments.length
    ) {
      throw new AnalysisReviewConflictError('Speaker provenance does not cover the promoted review window');
    }
    const speakerProvenanceFingerprint =
      promotedSpeakerProvenanceDrafts.length > 0
        ? speakerSegmentProvenanceDraftsFingerprint(promotedSpeakerProvenanceDrafts)
        : undefined;
    const outputHash = structuredIntegrityHash({ promotedCandidate, speakerProvenanceFingerprint });
    const artifact = await stageAnalysisArtifact(client, revision, 'chapter_labels', outputHash, promotedCandidate, {
      reviewArtifactId: review.id,
      reviewRevision: review.reviewRevision,
      validation: validation.summary,
      quality: quality.summary,
      promotionKind: 'manual_review',
      ...(speakerProvenanceFingerprint
        ? { speakerProvenanceFingerprint, speakerProvenanceDrafts: promotedSpeakerProvenanceDrafts }
        : {}),
    });
    if (revision.sourceSnapshot.kind === 'speaker_attribution_v3') {
      await rebaseHostedSpeakerArtifactDependencies(client, revision.userId, {
        bookId: revision.bookId,
        contentRevisionId: revision.contentRevisionId,
        sourceArtifactId: review.stagingArtifactId,
        targetArtifactId: artifact.id,
        additionalDependencyIds: [correctionPlan.operationId],
        staleSourceReason: 'manual_review_promoted_replacement',
      });
    }
    const analysisRunId = createAnalysisRunId({
      novelId: revision.bookId,
      providerJobId: job.id,
      inputHash: job.input_hash,
      outputHash,
    });
    await client.query(
      `
        update analysis_episode_contexts
        set status = 'stale', updated_at = now()
        where workflow_id = $1 and window_sequence >= $2 and status = 'active'
      `,
      [review.workflowId, revision.windowSpec.sequence],
    );
    await insertPromotedAnalysisRun(client, {
      analysisRunId,
      job,
      revision,
      artifact,
      requestProfile: profile,
      metadata: {
        reviewArtifactId: review.id,
        reviewRevision: review.reviewRevision,
        validation: validation.summary,
        quality: quality.summary,
        promotionKind: 'manual_review',
      },
    });
    const paragraphIds = revision.windowSpec.paragraphAnchors.map((anchor) => anchor.paragraphId);
    await replaceGeneratedSegments(
      client,
      revision.bookId,
      source.chapter.id,
      analysisRunId,
      [...correctionPlan.segments],
      paragraphIds,
      {
        contentRevisionId: revision.contentRevisionId,
        graphRevisionId: revision.characterGraphRevisionId,
        artifactId: artifact.id,
      },
    );
    await replaceHostedAcceptedSpeakerProvenanceForParagraphs(client, revision.userId, {
      bookId: revision.bookId,
      contentRevisionId: revision.contentRevisionId,
      chapterId: source.chapter.id,
      paragraphIds,
      rows: promotedSpeakerProvenanceDrafts.map((draft) =>
        createAcceptedSpeakerProvenance(draft, artifact.id, artifact.createdAt),
      ),
    });
    const correctionResult = await persistAnalysisReviewCorrectionPlan(client, config, review, correctionPlan);
    const correctionMemoryCursor = revision.correctionsSnapshot
      .map((correction) => correction.createdAt)
      .concat(correctionPlan.corrections.map((correction) => correction.createdAt))
      .sort()
      .at(-1);
    const episodeContext = episodeContextFromResult(source.chapter.id, promotedCandidate, {
      paragraphs: source.paragraphs,
      correctionMemoryCursor,
      sourceWindowId: revision.windowSpec.windowId,
      sourceArtifactId: artifact.id,
      speakerOnly: revision.sourceSnapshot.kind === 'speaker_attribution_v3',
      previousContext: revision.episodeContextSnapshot,
    });
    if (episodeContext) {
      await insertWorkflowEpisodeContext(client, {
        workflowId: review.workflowId,
        bookId: revision.bookId,
        chapterId: source.chapter.id,
        windowId: revision.windowSpec.windowId,
        windowSequence: revision.windowSpec.sequence,
        inputRevisionId: revision.id,
        artifactId: artifact.id,
        context: episodeContext,
        isChapterAggregate: revision.windowSpec.finalWindowForChapter === true,
      });
    }
    if (revision.windowSpec.finalWindowForChapter === true) {
      await upsertChapterContext(client, revision.bookId, source.chapter.id, analysisRunId, promotedCandidate, {
        contentRevisionId: revision.contentRevisionId,
        graphRevisionId: revision.characterGraphRevisionId,
        artifactId: artifact.id,
      });
    }
    await insertPromotionSyncEvent(client, {
      job,
      artifact,
      type: 'chapter_segments_updated',
      entityType: 'chapter_segments',
      entityId: `chapter_segments_${source.chapter.id}`,
      payload: {
        mode: 'patch',
        chapterId: source.chapter.id,
        paragraphIds,
        segments: correctionPlan.segments,
        labelMutationOperationId: correctionPlan.operationId,
        correctionIds: correctionResult.createdCorrectionIds,
      },
    });
    await updateBookAnalysisStatus(client, revision, 'labeling_segments');
    await markAnalysisArtifactPromoted(client, artifact.id);
    const parentMarkedPromoted = await updateProviderJobProgress(client, job, {
      mergeProgress: {
        manualReview: {
          status: 'promoted',
          reviewArtifactId: review.id,
          promotedArtifactId: artifact.id,
          promotedAt: new Date().toISOString(),
        },
      },
    });
    if (!parentMarkedPromoted) {
      throw new AnalysisReviewConflictError('Analysis review parent job changed before promotion');
    }

    const activeJobs = await loadActiveWorkflowJobs(client, review.workflowId, config.defaultUserId);
    for (const activeJob of activeJobs) {
      if (activeJob.job_type !== 'chapter_label_repair') continue;
      const progress = {
        ...recordValue(activeJob.progress),
        manualReview: { status: 'superseded', reviewArtifactId: review.id },
      };
      await cancelWorkflowProviderJob(client, activeJob, progress);
    }
    await client.query(
      `
        update provider_jobs job
        set progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
              'manualReview', jsonb_build_object('status', 'superseded', 'reviewArtifactId', $2::text)
            ),
            updated_at = now()
        from book_ai_workflow_jobs link
        where link.workflow_id = $1
          and link.provider_job_id = job.id
          and job.job_type = 'chapter_label_repair'
          and job.status in ('failed', 'cancelled')
      `,
      [review.workflowId, review.id],
    );
    const promotedReview = await client.query(
      `
        update analysis_review_artifacts
        set status = 'promoted', promoted_artifact_id = $2,
            review_revision = review_revision + 1,
            promoted_at = now(), next_reconcile_at = now(), updated_at = now()
        where id = $1 and status = 'promoting'
      `,
      [review.id, artifact.id],
    );
    if (promotedReview.rowCount !== undefined && promotedReview.rowCount !== 1) {
      throw new AnalysisReviewConflictError('Analysis review changed before promotion completed');
    }
    const resumedWorkflow = await client.query(
      `
        update book_ai_workflows
        set status = 'running', stage = 'labeling_chapters',
            error_code = null, error_message = null, finished_at = null,
            progress = coalesce(progress, '{}'::jsonb) || jsonb_build_object(
              'manualReviewResume', jsonb_build_object(
                'reviewArtifactId', $3::text,
                'windowId', $4::text,
                'resumedFromSequence', $5::integer
              )
            ),
            updated_at = now()
        where id = $1 and user_id = $2 and status in ('running', 'needs_review', 'failed')
      `,
      [review.workflowId, config.defaultUserId, review.id, review.windowId, revision.windowSpec.sequence],
    );
    if (resumedWorkflow.rowCount !== undefined && resumedWorkflow.rowCount !== 1) {
      throw new AnalysisReviewConflictError('Analysis workflow changed before review resume');
    }
    return review.workflowId;
  });
  await advanceBookAIWorkflow(pool, config, queue, workflowId);
  const promoted = await loadAnalysisReviewArtifact(pool, reviewId, config.defaultUserId);
  if (!promoted) throw new AnalysisReviewNotFoundError(reviewId);
  return promoted;
}

export async function approveAnalysisReview(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  reviewId: string,
  expectedReviewRevision: number,
): Promise<ChapterLabelAnalysisReviewArtifact> {
  if (!Number.isInteger(expectedReviewRevision) || expectedReviewRevision <= 0) {
    throw new AnalysisReviewInputError('expectedReviewRevision must be a positive integer');
  }
  const approved = await withBookAITransaction(pool, async (client) => {
    const review = await loadAnalysisReviewArtifact(client, reviewId, config.defaultUserId, true);
    if (!review) throw new AnalysisReviewNotFoundError(reviewId);
    if (review.reviewRevision !== expectedReviewRevision) {
      throw new AnalysisReviewConflictError(
        `Analysis review revision changed: expected ${expectedReviewRevision}, actual ${review.reviewRevision}`,
      );
    }
    if (review.status === 'approved' || review.status === 'promoting' || review.status === 'promoted') return review;
    if (!['open', 'editing', 'validating'].includes(review.status)) {
      throw new AnalysisReviewConflictError(`Analysis review is not approvable: ${review.status}`);
    }
    const { validation, quality } = await validateApprovedReview(client, review);
    const updated = await persistAnalysisReviewDecision(client, {
      reviewId,
      userId: config.defaultUserId,
      expectedReviewRevision,
      action: 'approve',
      status: 'approved',
      validation,
      quality,
      patch: { candidateHash: review.candidateHash },
      provenance: { validation: validation.summary, quality: quality.summary },
    });
    if (!updated) throw new AnalysisReviewConflictError('Analysis review changed before approval');
    return updated;
  });
  if (approved.status === 'promoted') {
    await advanceBookAIWorkflow(pool, config, queue, approved.workflowId);
    return (await loadAnalysisReviewArtifact(pool, reviewId, config.defaultUserId)) ?? approved;
  }
  try {
    const promoted = await promoteApprovedAnalysisReview(pool, config, reviewId, queue);
    await completeAnalysisReviewReconciliation(pool, {
      reviewId,
      userId: config.defaultUserId,
    });
    return promoted;
  } catch (error) {
    if (error instanceof AnalysisInputStaleError) {
      await obsoleteAnalysisReviewReconciliation(pool, {
        reviewId,
        userId: config.defaultUserId,
        errorCode: 'stale_fence',
      });
    }
    throw error;
  }
}
