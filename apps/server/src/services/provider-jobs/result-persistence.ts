import pg from 'pg';
import type { Chapter } from '@noveldesk/contracts';
import { analysisOutputIntegrityHash, analysisRunId as createAnalysisRunId } from '@noveldesk/text-core/identity/ai';
import { syncEventId, syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import { normalizeCharacterGraphSnapshot } from '../../../../../src/providers/character-graph-snapshot';
import { materializeLabelingSegmentProsody } from '../../../../../src/providers/analysis-review-correction';
import type {
  CharacterBundleAnalysisResult,
  CharacterGraph,
  ChapterLabelingResult,
} from '../../../../../src/providers/ai';
import type { ChapterLabelingValidationSummary } from '../../../../../src/providers/chapter-labeling-validator';
import { normalizeProviderExecutionMetadata } from '../../../../../src/providers/provider-execution';
import { compareProviderUsageEstimate } from '../../../../../src/providers/provider-capability';
import type { SyncEntityRevision, SyncEntityType, SyncEventType } from '@noveldesk/contracts/sync';
import { ProviderJobCancelledError, type ProviderJobRow, type ProviderRequestProfile } from './contracts.js';
import {
  replaceCharacterAliases,
  replaceCharacterRelations,
  replaceGeneratedSegments,
  upsertChapterContext,
  upsertCharacters,
} from './entity-write-repository.js';
import { saveCharacterGraphObservationsV2 } from '../character-graph-v2-service.js';
import { lockProviderJobForPersistence, updateProviderJobProgress } from './job-lifecycle.js';
import { recordValue, stringArrayValue } from './job-progress.js';
import type { AnalysisInputRevision } from '../book-ai-workflow/analysis-input-contracts.js';
import type { SpeakerSegmentProvenanceDraftV1 } from '../../../../../src/providers/speaker-attribution/accepted-speaker-provenance';
import {
  stageAndPromoteChapterLabels,
  stageAndPromoteCharacterBundle,
  stageAndPromoteCharacterGraph,
} from '../book-ai-workflow/artifact-promotion-service.js';

function providerCapabilityEvidence(
  inputRevision: AnalysisInputRevision | undefined,
  extraMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const capability = inputRevision?.capabilitySnapshot;
  const taskProfile = inputRevision?.taskProfileSnapshot;
  const admission = inputRevision?.admissionSnapshot;
  if (!capability || !taskProfile) return extraMetadata;
  const execution = normalizeProviderExecutionMetadata(extraMetadata.providerExecution);
  return {
    capabilitySnapshotId: capability.id,
    capabilitySnapshot: capability,
    taskProfileSnapshot: taskProfile,
    admissionSnapshot: admission,
    usageEstimate:
      admission && capability.kind === 'llm'
        ? compareProviderUsageEstimate(capability, admission, execution)
        : undefined,
    ...extraMetadata,
  };
}

export function bookAnalysisStatusForSucceededAIProviderJob(job: {
  readonly provider_id?: string;
  readonly providerId?: string;
  readonly job_type?: string;
  readonly jobType?: string;
  readonly progress?: unknown;
}): 'mock_ready' | 'ready' | 'needs_review' | 'building_graph' | 'labeling_segments' {
  const source = recordValue(recordValue(job.progress)?.sourceContext);
  const workflowId = source?.workflowId;
  const workflowStage = source?.workflowStage;
  const isWorkflowChild = typeof workflowId === 'string' && workflowId.trim().length > 0;
  const jobType = typeof job.job_type === 'string' ? job.job_type : job.jobType;
  if (isWorkflowChild) {
    if (
      jobType === 'chapter_segment_labeling' ||
      jobType === 'speaker_attribution_v3' ||
      jobType === 'chapter_label_repair' ||
      workflowStage === 'labeling_chapters'
    ) {
      return 'labeling_segments';
    }
    return 'building_graph';
  }
  if (jobType === 'character_bundle_analysis') return 'needs_review';
  const providerId = typeof job.provider_id === 'string' ? job.provider_id : job.providerId;
  return providerId === 'mock' ? 'mock_ready' : 'ready';
}

function syncRevision(input: {
  entityType: SyncEntityType;
  entityId: string;
  novelId?: string;
  updatedAt?: string;
  payload: unknown;
}): SyncEntityRevision {
  return {
    entityType: input.entityType,
    entityId: input.entityId,
    novelId: input.novelId,
    localSequence: 0,
    updatedAt: input.updatedAt,
    payloadHash: syncPayloadIntegrityHash(input.payload),
  };
}

async function insertProviderSyncEvent(
  client: pg.PoolClient,
  job: ProviderJobRow,
  input: {
    seed: string;
    type: SyncEventType;
    entityType: SyncEntityType;
    entityId: string;
    payload: unknown;
    createdAt: string;
  },
): Promise<void> {
  await client.query(
    `
      insert into sync_events (id, user_id, device_id, type, book_id, entity_id, payload, revision, created_at)
      values ($1, $2, null, $3, $4, $5, $6, $7, $8)
      on conflict (id) do nothing
    `,
    [
      syncEventId({
        userId: job.user_id,
        type: input.type,
        novelId: job.book_id,
        entityId: input.entityId,
        seed: input.seed,
      }),
      job.user_id,
      input.type,
      job.book_id,
      input.entityId,
      JSON.stringify(input.payload),
      JSON.stringify(
        syncRevision({
          entityType: input.entityType,
          entityId: input.entityId,
          novelId: job.book_id,
          updatedAt: input.createdAt,
          payload: input.payload,
        }),
      ),
      input.createdAt,
    ],
  );
}

export async function persistChapterLabelingResult(
  pool: pg.Pool,
  job: ProviderJobRow,
  chapter: Chapter,
  result: ChapterLabelingResult,
  validation: { summary: ChapterLabelingValidationSummary },
  requestProfile: ProviderRequestProfile,
  extraMetadata: Record<string, unknown> = {},
  inputRevision?: AnalysisInputRevision,
  speakerProvenanceDrafts: readonly SpeakerSegmentProvenanceDraftV1[] = [],
): Promise<void> {
  const capabilityMetadata = providerCapabilityEvidence(inputRevision, extraMetadata);
  if (inputRevision) {
    await stageAndPromoteChapterLabels(
      {
        pool,
        job,
        revision: inputRevision,
        requestProfile,
        metadata: capabilityMetadata,
        analysisStatus: bookAnalysisStatusForSucceededAIProviderJob(job),
        chapter,
        validation: validation.summary,
      },
      result,
      speakerProvenanceDrafts,
    );
    return;
  }
  const outputHash = analysisOutputIntegrityHash({
    characterIds: result.characters.map((character) => character.id),
    segmentIds: result.segments.map((segment) => segment.id),
    uncertainties: result.uncertainties,
    segmentAnnotations: result.segmentAnnotations,
  });
  const analysisRunId = createAnalysisRunId({
    novelId: job.book_id,
    providerJobId: job.id,
    inputHash: job.input_hash,
    outputHash,
  });
  const eventCreatedAt = new Date().toISOString();
  const paragraphIds = stringArrayValue(extraMetadata.paragraphIds);
  const canonicalSegments = materializeLabelingSegmentProsody(result);
  const coversFullChapter = extraMetadata.coversFullChapter === true || paragraphIds.length === 0;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await lockProviderJobForPersistence(client, job);
    await client.query(
      `
        insert into analysis_runs (
          id, book_id, chapter_id, run_type, provider_id, model_id, prompt_version,
          input_hash, output_hash, status, metadata, started_at, finished_at, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'succeeded', $10, now(), now(), now())
        on conflict (id) do update
          set output_hash = excluded.output_hash,
              status = 'succeeded',
              metadata = excluded.metadata,
              finished_at = now()
      `,
      [
        analysisRunId,
        job.book_id,
        chapter.id,
        job.job_type,
        job.provider_id,
        job.model_id,
        requestProfile.promptVersion,
        job.input_hash,
        outputHash,
        JSON.stringify({
          characterCount: result.characters.length,
          segmentCount: result.segments.length,
          requestProfileId: requestProfile.id,
          schemaVersion: requestProfile.schemaVersion,
          validation: validation.summary,
          uncertainties: result.uncertainties,
          segmentAnnotations: result.segmentAnnotations,
          ...capabilityMetadata,
        }),
      ],
    );
    await upsertCharacters(client, job.book_id, job.user_id, result.characters);
    await replaceGeneratedSegments(client, job.book_id, chapter.id, analysisRunId, canonicalSegments, paragraphIds);
    if (coversFullChapter) await upsertChapterContext(client, job.book_id, chapter.id, analysisRunId, result);
    await client.query(
      'update library_books set analysis_status = $1, updated_at = now() where id = $2 and user_id = $3',
      [bookAnalysisStatusForSucceededAIProviderJob(job), job.book_id, job.user_id],
    );
    const completionApplied = await updateProviderJobProgress(client, job, {
      status: 'succeeded',
      stage: 'ready',
      progress: {
        ...recordValue(job.progress),
        characterCount: result.characters.length,
        segmentCount: result.segments.length,
        validation: validation.summary,
        ...capabilityMetadata,
      },
      errorCode: null,
      errorMessage: null,
      finishedAt: true,
    });
    if (!completionApplied) throw new ProviderJobCancelledError(job.id);
    if (result.characters.length) {
      const graphPayload = { mode: 'patch', characters: result.characters };
      await insertProviderSyncEvent(client, job, {
        seed: `character_graph_updated:${job.id}:${analysisRunId}:${eventCreatedAt}`,
        type: 'character_graph_updated',
        entityType: 'character_graph',
        entityId: `character_graph_${job.book_id}`,
        payload: graphPayload,
        createdAt: eventCreatedAt,
      });
    }
    const segmentsPayload =
      paragraphIds.length > 0
        ? { mode: 'patch', chapterId: chapter.id, paragraphIds, segments: canonicalSegments }
        : { chapterId: chapter.id, segments: canonicalSegments };
    await insertProviderSyncEvent(client, job, {
      seed: `chapter_segments_updated:${job.id}:${analysisRunId}:${eventCreatedAt}`,
      type: 'chapter_segments_updated',
      entityType: 'chapter_segments',
      entityId: `chapter_segments_${chapter.id}`,
      payload: segmentsPayload,
      createdAt: eventCreatedAt,
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function persistCharacterGraphMergeResult(
  pool: pg.Pool,
  job: ProviderJobRow,
  result: CharacterGraph,
  requestProfile: ProviderRequestProfile,
  extraMetadata: Record<string, unknown> = {},
  inputRevision?: AnalysisInputRevision,
): Promise<void> {
  const capabilityMetadata = providerCapabilityEvidence(inputRevision, extraMetadata);
  if (inputRevision) {
    await stageAndPromoteCharacterGraph(
      {
        pool,
        job,
        revision: inputRevision,
        requestProfile,
        metadata: capabilityMetadata,
        analysisStatus: bookAnalysisStatusForSucceededAIProviderJob(job),
      },
      result,
    );
    return;
  }
  const outputHash = analysisOutputIntegrityHash({
    characters: [...result.characters]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((character) => ({
        id: character.id,
        canonicalName: character.canonicalName,
        aliases: [...character.aliases].sort(),
        color: character.color,
        description: character.description,
        confidence: character.confidence,
        isUserConfirmed: character.isUserConfirmed,
      })),
    relations: [...result.relations]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((relation) => ({
        id: relation.id,
        sourceCharacterId: relation.sourceCharacterId,
        targetCharacterId: relation.targetCharacterId,
        relationLabel: relation.relationLabel,
        termsUsedBySource: [...relation.termsUsedBySource].sort(),
        termsUsedByTarget: [...relation.termsUsedByTarget].sort(),
        confidence: relation.confidence,
        evidence: [...(relation.evidence ?? [])].sort(),
      })),
  });
  const analysisRunId = createAnalysisRunId({
    novelId: job.book_id,
    providerJobId: job.id,
    inputHash: job.input_hash,
    outputHash,
  });
  const eventCreatedAt = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await lockProviderJobForPersistence(client, job);
    await client.query(
      `
        insert into analysis_runs (
          id, book_id, chapter_id, run_type, provider_id, model_id, prompt_version,
          input_hash, output_hash, status, metadata, started_at, finished_at, created_at
        )
        values ($1, $2, null, $3, $4, $5, $6, $7, $8, 'succeeded', $9, now(), now(), now())
        on conflict (id) do update
          set output_hash = excluded.output_hash,
              status = 'succeeded',
              metadata = excluded.metadata,
              finished_at = now()
      `,
      [
        analysisRunId,
        job.book_id,
        job.job_type,
        job.provider_id,
        job.model_id,
        requestProfile.promptVersion,
        job.input_hash,
        outputHash,
        JSON.stringify({
          characterCount: result.characters.length,
          relationCount: result.relations.length,
          requestProfileId: requestProfile.id,
          schemaVersion: requestProfile.schemaVersion,
          ...capabilityMetadata,
        }),
      ],
    );
    await upsertCharacters(client, job.book_id, job.user_id, result.characters);
    await replaceCharacterAliases(client, job.book_id, result.characters);
    await replaceCharacterRelations(client, job.book_id, result.relations);
    await client.query(
      'update library_books set analysis_status = $1, updated_at = now() where id = $2 and user_id = $3',
      [bookAnalysisStatusForSucceededAIProviderJob(job), job.book_id, job.user_id],
    );
    const completionApplied = await updateProviderJobProgress(client, job, {
      status: 'succeeded',
      stage: 'ready',
      progress: {
        ...recordValue(job.progress),
        characterCount: result.characters.length,
        relationCount: result.relations.length,
        ...capabilityMetadata,
      },
      errorCode: null,
      errorMessage: null,
      finishedAt: true,
    });
    if (!completionApplied) throw new ProviderJobCancelledError(job.id);
    const graphPayload = { mode: 'replace', characters: result.characters, relations: result.relations };
    await insertProviderSyncEvent(client, job, {
      seed: `character_graph_updated:${job.id}:${analysisRunId}:${eventCreatedAt}`,
      type: 'character_graph_updated',
      entityType: 'character_graph',
      entityId: `character_graph_${job.book_id}`,
      payload: graphPayload,
      createdAt: eventCreatedAt,
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function persistCharacterBundleAnalysisResult(
  pool: pg.Pool,
  job: ProviderJobRow,
  result: CharacterBundleAnalysisResult,
  requestProfile: ProviderRequestProfile,
  extraMetadata: Record<string, unknown> = {},
  inputRevision?: AnalysisInputRevision,
): Promise<void> {
  const capabilityMetadata = providerCapabilityEvidence(inputRevision, extraMetadata);
  if (inputRevision) {
    await stageAndPromoteCharacterBundle(
      {
        pool,
        job,
        revision: inputRevision,
        requestProfile,
        metadata: capabilityMetadata,
        analysisStatus: bookAnalysisStatusForSucceededAIProviderJob(job),
      },
      { ...result, discoveredGraph: normalizeCharacterGraphSnapshot(result.discoveredGraph, job.book_id) },
    );
    if (result.observationsV2) {
      await saveCharacterGraphObservationsV2(pool, job.user_id, result.observationsV2);
    }
    return;
  }
  const discoveredGraph = normalizeCharacterGraphSnapshot(result.discoveredGraph, job.book_id);
  const outputHash = analysisOutputIntegrityHash({
    bundleId: result.bundleId,
    sourceChapterIds: result.sourceChapterIds,
    characters: discoveredGraph.characters.map((character) => character.id).sort(),
    relations: discoveredGraph.relations.map((relation) => relation.id).sort(),
    bundleSummaryForNext: result.bundleSummaryForNext,
  });
  const analysisRunId = createAnalysisRunId({
    novelId: job.book_id,
    providerJobId: job.id,
    inputHash: job.input_hash,
    outputHash,
  });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await lockProviderJobForPersistence(client, job);
    await client.query(
      `
        insert into analysis_runs (
          id, book_id, chapter_id, run_type, provider_id, model_id, prompt_version,
          input_hash, output_hash, status, metadata, started_at, finished_at, created_at
        )
        values ($1, $2, null, $3, $4, $5, $6, $7, $8, 'succeeded', $9, now(), now(), now())
        on conflict (id) do update
          set output_hash = excluded.output_hash,
              status = 'succeeded',
              metadata = excluded.metadata,
              finished_at = now()
      `,
      [
        analysisRunId,
        job.book_id,
        job.job_type,
        job.provider_id,
        job.model_id,
        requestProfile.promptVersion,
        job.input_hash,
        outputHash,
        JSON.stringify({
          bundleId: result.bundleId,
          sourceChapterIds: result.sourceChapterIds,
          discoveredCharacterCount: discoveredGraph.characters.length,
          discoveredRelationCount: discoveredGraph.relations.length,
          bundleSummaryForNext: result.bundleSummaryForNext,
          discoveredGraph,
          requestProfileId: requestProfile.id,
          schemaVersion: requestProfile.schemaVersion,
          ...capabilityMetadata,
        }),
      ],
    );
    await client.query(
      'update library_books set analysis_status = $1, updated_at = now() where id = $2 and user_id = $3',
      [bookAnalysisStatusForSucceededAIProviderJob(job), job.book_id, job.user_id],
    );
    const completionApplied = await updateProviderJobProgress(client, job, {
      status: 'succeeded',
      stage: 'ready',
      progress: {
        ...recordValue(job.progress),
        bundleId: result.bundleId,
        sourceChapterIds: result.sourceChapterIds,
        discoveredCharacterCount: discoveredGraph.characters.length,
        discoveredRelationCount: discoveredGraph.relations.length,
        bundleSummaryForNext: result.bundleSummaryForNext,
        discoveredGraph,
        ...capabilityMetadata,
      },
      errorCode: null,
      errorMessage: null,
      finishedAt: true,
    });
    if (!completionApplied) throw new ProviderJobCancelledError(job.id);
    await client.query('commit');
    if (result.observationsV2) {
      await saveCharacterGraphObservationsV2(pool, job.user_id, result.observationsV2);
    }
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
