import {
  analysisOutputIntegrityHash,
  analysisRunId as createAnalysisRunId,
  characterGraphIntegrityHash,
} from '@noveldesk/text-core/identity/ai';
import type { Chapter } from '@noveldesk/contracts';
import type {
  CharacterBundleAnalysisResult,
  CharacterGraph,
  ChapterLabelingResult,
} from '../../../../../src/providers/ai';
import type { ChapterLabelingValidationSummary } from '../../../../../src/providers/chapter-labeling-validator';
import { materializeLabelingSegmentProsody } from '../../../../../src/providers/analysis-review-correction';
import {
  createAcceptedSpeakerProvenance,
  type SpeakerSegmentProvenanceDraftV1,
} from '../../../../../src/providers/speaker-attribution/accepted-speaker-provenance';
import { speakerSegmentProvenanceDraftsFingerprint } from '../../../../../src/providers/speaker-attribution/speaker-provenance-projection';
import pg from 'pg';
import type { ProviderJobRow, ProviderRequestProfile } from '../provider-jobs/contracts.js';
import {
  deleteSupersededGeneratedCharacters,
  replaceCharacterAliases,
  replaceCharacterRelations,
  replaceGeneratedSegments,
  upsertChapterContext,
  upsertCharacters,
} from '../provider-jobs/entity-write-repository.js';
import { loadCharacterGraph } from '../provider-jobs/job-data-loader.js';
import { lockProviderJobForPersistence, updateProviderJobProgress } from '../provider-jobs/job-lifecycle.js';
import { recordValue } from '../provider-jobs/job-progress.js';
import { AnalysisInputStaleError, type AnalysisInputRevision } from './analysis-input-contracts.js';
import { episodeContextFromResult, insertWorkflowEpisodeContext } from './episode-context-repository.js';
import {
  activeGraphRevisionForArtifact,
  insertPromotedAnalysisRun,
  insertPromotionSyncEvent,
  lockBookPromotionState,
  promoteCharacterGraphRevision,
  updateBookAnalysisStatus,
} from './promotion-repository.js';
import { loadPinnedCorrections, lockBookRevisionState } from './revision-snapshot-repository.js';
import {
  loadAnalysisArtifact,
  markAnalysisArtifactPromoted,
  markAnalysisArtifactStale,
  stageAnalysisArtifact,
} from './staging-artifact-repository.js';
import { withBookAITransaction } from './transaction.js';
import { replaceHostedAcceptedSpeakerProvenanceForParagraphs } from '../speaker-workflow-state-service.js';

interface PromotionCommon {
  readonly pool: pg.Pool;
  readonly job: ProviderJobRow;
  readonly revision: AnalysisInputRevision;
  readonly requestProfile: ProviderRequestProfile;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly analysisStatus: string;
}

export async function verifyAnalysisPromotionFence(
  client: pg.PoolClient,
  revision: AnalysisInputRevision,
  job: ProviderJobRow,
): Promise<void> {
  const state = await lockBookPromotionState(client, revision);
  if (!state || state.activeContentRevisionId !== revision.contentRevisionId) {
    throw new AnalysisInputStaleError('analysis_content_revision_stale', 'Book content changed before promotion');
  }
  if (state.revisionFence !== revision.revisionFence) {
    throw new AnalysisInputStaleError(
      'analysis_revision_fence_stale',
      'Book replacement fence changed before promotion',
    );
  }
  if (
    revision.characterGraphRevisionId !== undefined &&
    state.activeGraphRevisionId !== revision.characterGraphRevisionId
  ) {
    throw new AnalysisInputStaleError('analysis_graph_revision_stale', 'Character graph changed before promotion');
  }
  const currentGraph = await loadCharacterGraph(client, job);
  if (characterGraphIntegrityHash(currentGraph) !== revision.characterGraphFingerprint) {
    throw new AnalysisInputStaleError(
      'analysis_graph_revision_stale',
      'Canonical character graph changed before promotion',
    );
  }
  const revisionState = await lockBookRevisionState(client, revision.userId, revision.bookId, {
    lock: false,
  });
  if (!revisionState) throw new AnalysisInputStaleError('analysis_content_revision_stale', 'Book was removed');
  const corrections = await loadPinnedCorrections(client, revisionState, revision.chapterId);
  if (corrections.fingerprint !== revision.correctionFingerprint) {
    throw new AnalysisInputStaleError('analysis_corrections_stale', 'User corrections changed before promotion');
  }
}

async function lockAutomaticRepairReviewGate(
  client: pg.PoolClient,
  revision: AnalysisInputRevision,
): Promise<string | undefined> {
  if (revision.sourceSnapshot.kind !== 'chapter_label_repair') return undefined;
  const result = await client.query<{ id: string; status: string }>(
    `
      select id, status
      from analysis_review_artifacts
      where staging_artifact_id = $1
      for update
    `,
    [revision.sourceSnapshot.candidateArtifactId],
  );
  const review = result.rows[0];
  if (!review) return undefined;
  if (review.status !== 'open') {
    throw new AnalysisInputStaleError(
      'analysis_review_changed',
      `Analysis review no longer allows automatic repair promotion: ${review.status}`,
    );
  }
  return review.id;
}

async function markAutomaticRepairReviewSuperseded(client: pg.PoolClient, reviewId: string | undefined): Promise<void> {
  if (!reviewId) return;
  const updated = await client.query(
    `
      update analysis_review_artifacts
      set status = 'obsolete', review_revision = review_revision + 1, updated_at = now()
      where id = $1 and status = 'open'
    `,
    [reviewId],
  );
  if (updated.rowCount !== undefined && updated.rowCount !== 1) {
    throw new AnalysisInputStaleError('analysis_review_changed', 'Analysis review changed during repair promotion');
  }
}

async function finishPromotedJob(
  client: pg.PoolClient,
  common: PromotionCommon,
  progress: Readonly<Record<string, unknown>>,
): Promise<void> {
  await updateBookAnalysisStatus(client, common.revision, common.analysisStatus);
  const applied = await updateProviderJobProgress(client, common.job, {
    status: 'succeeded',
    stage: 'ready',
    progress: { ...recordValue(common.job.progress), ...progress },
    errorCode: null,
    errorMessage: null,
    finishedAt: true,
  });
  if (!applied) throw new Error(`Provider job promotion lost its attempt fence: ${common.job.id}`);
}

async function promoteStagedArtifact(
  common: PromotionCommon,
  input: {
    readonly artifactId: string;
    readonly idempotentGraph: boolean;
    readonly promote: (client: pg.PoolClient, artifactId: string) => Promise<void>;
  },
): Promise<void> {
  try {
    await withBookAITransaction(common.pool, async (client) => {
      const artifact = await loadAnalysisArtifact(client, input.artifactId, true);
      if (!artifact) throw new Error(`Analysis staging artifact not found: ${input.artifactId}`);
      if (artifact.status === 'stale' || artifact.status === 'quarantined') {
        throw new AnalysisInputStaleError(
          'analysis_content_revision_stale',
          'Analysis artifact is no longer promotable',
        );
      }
      if (artifact.status === 'promoted') {
        if (input.idempotentGraph) {
          const state = await lockBookPromotionState(client, common.revision);
          if (
            !state ||
            state.activeContentRevisionId !== common.revision.contentRevisionId ||
            state.revisionFence !== common.revision.revisionFence ||
            !(await activeGraphRevisionForArtifact(client, artifact.id))
          ) {
            throw new AnalysisInputStaleError(
              'analysis_graph_revision_stale',
              'Previously promoted graph artifact is no longer active',
            );
          }
        } else {
          await verifyAnalysisPromotionFence(client, common.revision, common.job);
        }
        await lockProviderJobForPersistence(client, common.job);
        await finishPromotedJob(client, common, {
          inputRevisionId: common.revision.id,
          stagingArtifactId: artifact.id,
          idempotentPromotion: true,
        });
        return;
      }
      await verifyAnalysisPromotionFence(client, common.revision, common.job);
      const automaticRepairReviewId = await lockAutomaticRepairReviewGate(client, common.revision);
      await lockProviderJobForPersistence(client, common.job);
      await input.promote(client, artifact.id);
      await markAutomaticRepairReviewSuperseded(client, automaticRepairReviewId);
      await markAnalysisArtifactPromoted(client, artifact.id);
    });
  } catch (error) {
    if (error instanceof AnalysisInputStaleError || (error instanceof Error && error.message.endsWith('_cas_failed'))) {
      await markAnalysisArtifactStale(common.pool, input.artifactId, error.message);
      if (error instanceof AnalysisInputStaleError) throw error;
      throw new AnalysisInputStaleError('analysis_graph_revision_stale', error.message);
    }
    throw error;
  }
}

export async function stageAndPromoteCharacterBundle(
  common: PromotionCommon,
  result: CharacterBundleAnalysisResult,
): Promise<void> {
  const outputHash = analysisOutputIntegrityHash({
    bundleId: result.bundleId,
    sourceChapterIds: result.sourceChapterIds,
    characters: result.discoveredGraph.characters.map((item) => item.id).sort(),
    relations: result.discoveredGraph.relations.map((item) => item.id).sort(),
    bundleSummaryForNext: result.bundleSummaryForNext,
  });
  const artifact = await stageAnalysisArtifact(common.pool, common.revision, 'character_bundle', outputHash, result, {
    ...common.metadata,
  });
  await promoteStagedArtifact(common, {
    artifactId: artifact.id,
    idempotentGraph: false,
    promote: async (client, artifactId) => {
      const lockedArtifact = await loadAnalysisArtifact(client, artifactId, true);
      if (!lockedArtifact) throw new Error(`Analysis staging artifact not found: ${artifactId}`);
      const analysisRunId = createAnalysisRunId({
        novelId: common.job.book_id,
        providerJobId: common.job.id,
        inputHash: common.job.input_hash,
        outputHash,
      });
      await insertPromotedAnalysisRun(client, {
        analysisRunId,
        job: common.job,
        revision: common.revision,
        artifact: lockedArtifact,
        requestProfile: common.requestProfile,
        metadata: common.metadata,
      });
      await finishPromotedJob(client, common, {
        bundleId: result.bundleId,
        sourceChapterIds: result.sourceChapterIds,
        discoveredCharacterCount: result.discoveredGraph.characters.length,
        discoveredRelationCount: result.discoveredGraph.relations.length,
        bundleSummaryForNext: result.bundleSummaryForNext,
        inputRevisionId: common.revision.id,
        stagingArtifactId: artifactId,
        ...common.metadata,
      });
    },
  });
}

export async function stageAndPromoteCharacterGraph(common: PromotionCommon, graph: CharacterGraph): Promise<void> {
  const fingerprint = characterGraphIntegrityHash(graph);
  const outputHash = analysisOutputIntegrityHash({ graphFingerprint: fingerprint });
  const artifact = await stageAnalysisArtifact(common.pool, common.revision, 'character_graph', outputHash, graph, {
    ...common.metadata,
  });
  await promoteStagedArtifact(common, {
    artifactId: artifact.id,
    idempotentGraph: true,
    promote: async (client, artifactId) => {
      const lockedArtifact = await loadAnalysisArtifact(client, artifactId, true);
      if (!lockedArtifact) throw new Error(`Analysis staging artifact not found: ${artifactId}`);
      const analysisRunId = createAnalysisRunId({
        novelId: common.job.book_id,
        providerJobId: common.job.id,
        inputHash: common.job.input_hash,
        outputHash,
      });
      await insertPromotedAnalysisRun(client, {
        analysisRunId,
        job: common.job,
        revision: common.revision,
        artifact: lockedArtifact,
        requestProfile: common.requestProfile,
        metadata: common.metadata,
      });
      const graphRevisionId = await promoteCharacterGraphRevision(client, {
        revision: common.revision,
        artifact: lockedArtifact,
        graph,
        fingerprint,
      });
      await upsertCharacters(client, common.job.book_id, common.job.user_id, graph.characters, {
        graphRevisionId,
        contentRevisionId: common.revision.contentRevisionId,
      });
      await deleteSupersededGeneratedCharacters(
        client,
        common.job.book_id,
        graph.characters.map((item) => item.id),
      );
      await replaceCharacterAliases(client, common.job.book_id, graph.characters, graphRevisionId);
      await replaceCharacterRelations(client, common.job.book_id, graph.relations, graphRevisionId);
      const payload = { mode: 'replace', characters: graph.characters, relations: graph.relations };
      await insertPromotionSyncEvent(client, {
        job: common.job,
        artifact: lockedArtifact,
        type: 'character_graph_updated',
        entityType: 'character_graph',
        entityId: `character_graph_${common.job.book_id}`,
        payload,
      });
      await finishPromotedJob(client, common, {
        characterCount: graph.characters.length,
        relationCount: graph.relations.length,
        graphRevisionId,
        inputRevisionId: common.revision.id,
        stagingArtifactId: artifactId,
        ...common.metadata,
      });
    },
  });
}

export async function stageAndPromoteChapterLabels(
  common: PromotionCommon & {
    readonly chapter: Chapter;
    readonly validation: ChapterLabelingValidationSummary;
  },
  result: ChapterLabelingResult,
  speakerProvenanceDrafts: readonly SpeakerSegmentProvenanceDraftV1[] = [],
): Promise<void> {
  const canonicalSegments = materializeLabelingSegmentProsody(result);
  const speakerProvenanceFingerprint =
    speakerProvenanceDrafts.length > 0 ? speakerSegmentProvenanceDraftsFingerprint(speakerProvenanceDrafts) : undefined;
  const outputHash = analysisOutputIntegrityHash({
    characterIds: result.characters.map((item) => item.id),
    segmentIds: result.segments.map((item) => item.id),
    episodeContext: result.episodeContextSummary,
    uncertainties: result.uncertainties,
    segmentAnnotations: result.segmentAnnotations,
    speakerProvenanceFingerprint,
  });
  const artifact = await stageAnalysisArtifact(common.pool, common.revision, 'chapter_labels', outputHash, result, {
    validation: common.validation,
    ...common.metadata,
    ...(speakerProvenanceFingerprint ? { speakerProvenanceFingerprint, speakerProvenanceDrafts } : {}),
  });
  await promoteStagedArtifact(common, {
    artifactId: artifact.id,
    idempotentGraph: false,
    promote: async (client, artifactId) => {
      const lockedArtifact = await loadAnalysisArtifact(client, artifactId, true);
      if (!lockedArtifact) throw new Error(`Analysis staging artifact not found: ${artifactId}`);
      const analysisRunId = createAnalysisRunId({
        novelId: common.job.book_id,
        providerJobId: common.job.id,
        inputHash: common.job.input_hash,
        outputHash,
      });
      await insertPromotedAnalysisRun(client, {
        analysisRunId,
        job: common.job,
        revision: common.revision,
        artifact: lockedArtifact,
        requestProfile: common.requestProfile,
        metadata: { validation: common.validation, ...common.metadata },
      });
      const paragraphIds = common.revision.windowSpec.paragraphAnchors.map((item) => item.paragraphId);
      await replaceGeneratedSegments(
        client,
        common.job.book_id,
        common.chapter.id,
        analysisRunId,
        canonicalSegments,
        paragraphIds,
        {
          contentRevisionId: common.revision.contentRevisionId,
          graphRevisionId: common.revision.characterGraphRevisionId,
          artifactId,
        },
      );
      await replaceHostedAcceptedSpeakerProvenanceForParagraphs(client, common.job.user_id, {
        bookId: common.job.book_id,
        contentRevisionId: common.revision.contentRevisionId,
        chapterId: common.chapter.id,
        paragraphIds,
        rows: speakerProvenanceDrafts.map((draft) =>
          createAcceptedSpeakerProvenance(draft, artifactId, lockedArtifact.createdAt),
        ),
      });
      const sourceSnapshot = common.revision.sourceSnapshot;
      const sourceParagraphs =
        sourceSnapshot.kind === 'chapter_labeling' || sourceSnapshot.kind === 'chapter_label_repair'
          ? sourceSnapshot.paragraphs
          : sourceSnapshot.kind === 'speaker_attribution_v3'
            ? sourceSnapshot.canonicalSource.paragraphs
            : [];
      const correctionMemoryCursor = common.revision.correctionsSnapshot
        .map((correction) => correction.createdAt)
        .sort()
        .at(-1);
      const episodeContext = episodeContextFromResult(common.chapter.id, result, {
        paragraphs: sourceParagraphs,
        correctionMemoryCursor,
        sourceWindowId: common.revision.windowSpec.windowId,
        sourceArtifactId: artifactId,
        speakerOnly: sourceSnapshot.kind === 'speaker_attribution_v3',
        previousContext: common.revision.episodeContextSnapshot,
      });
      if (episodeContext && common.revision.workflowId) {
        await insertWorkflowEpisodeContext(client, {
          workflowId: common.revision.workflowId,
          bookId: common.job.book_id,
          chapterId: common.chapter.id,
          windowId: common.revision.windowSpec.windowId,
          windowSequence: common.revision.windowSpec.sequence,
          inputRevisionId: common.revision.id,
          artifactId,
          context: episodeContext,
          isChapterAggregate: common.revision.windowSpec.finalWindowForChapter === true,
        });
      }
      if (common.revision.windowSpec.finalWindowForChapter === true) {
        await upsertChapterContext(client, common.job.book_id, common.chapter.id, analysisRunId, result, {
          contentRevisionId: common.revision.contentRevisionId,
          graphRevisionId: common.revision.characterGraphRevisionId,
          artifactId,
        });
      }
      const payload = { mode: 'patch', chapterId: common.chapter.id, paragraphIds, segments: canonicalSegments };
      await insertPromotionSyncEvent(client, {
        job: common.job,
        artifact: lockedArtifact,
        type: 'chapter_segments_updated',
        entityType: 'chapter_segments',
        entityId: `chapter_segments_${common.chapter.id}`,
        payload,
      });
      await finishPromotedJob(client, common, {
        characterCount: result.characters.length,
        segmentCount: result.segments.length,
        validation: common.validation,
        inputRevisionId: common.revision.id,
        stagingArtifactId: artifactId,
        ...common.metadata,
      });
    },
  });
}
