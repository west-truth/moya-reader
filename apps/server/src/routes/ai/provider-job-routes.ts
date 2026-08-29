import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { characterAnalysisBundleId, characterGraphIntegrityHash } from '@noveldesk/text-core/identity/ai';
import {
  providerJobId,
  providerOptionsIntegrityHash,
  providerRequestIntegrityHash,
  providerSourceContextIntegrityHash,
} from '@noveldesk/text-core/identity/provider';
import type { ProviderJobType } from '../../../../../src/providers/provider-jobs';
import { normalizeCharacterGraphSnapshot } from '../../../../../src/providers/character-graph-snapshot';
import { resolveCharacterBundleAnalysisRequestProfile } from '../../../../../src/providers/character-bundle-request-profile';
import { resolveCharacterGraphMergeRequestProfile } from '../../../../../src/providers/character-graph-request-profile';
import { resolveChapterLabelRepairRequestProfile } from '../../../../../src/providers/chapter-label-repair-request-profile';
import { resolveChapterLabelingRequestProfile } from '../../../../../src/providers/chapter-labeling-request-profile';
import {
  buildProviderAdmissionSnapshot,
  resolveLLMCapabilitySnapshot,
  resolveProviderTaskProfile,
} from '../../../../../src/providers/provider-capability';
import { providerJobAdmissionLimits, type ServerConfig } from '../../config.js';
import { enqueueProviderJob } from '../../queue.js';
import {
  isServerAIProviderId,
  loadServerAISettings,
  modelIdForProvider,
  providerOptionsForAIProvider,
  serverAIProviderIsImplemented,
} from '../../providers/server-ai-config.js';
import { listServerProviderCatalog } from '../../providers/server-provider-catalog.js';
import {
  loadProviderSettingsBundle,
  modelFromSettings,
  providerEnabledBySettings,
  providerOptionsFromSettings,
} from '../../providers/server-provider-settings.js';
import { providerSecretStatusBundle } from '../../providers/server-provider-secrets.js';
import { advanceBookAIWorkflowsForProviderJob } from '../../services/book-ai-workflow-service.js';
import { isoString } from './database-row-contract.js';
import { mapProviderJob, providerJobProgressRecord, type ProviderJobRow } from './provider-job-contract.js';
import { removeProviderQueueJob } from './provider-job-queue-service.js';
import { loadProviderJob } from './provider-job-query-repository.js';
import { sendProviderJobAdmissionRejection } from './provider-admission-response.js';
import {
  arrayOfStrings,
  optionalStringField,
  recordBody,
  stringField,
  uniqueNonEmptyStrings,
} from './request-contracts.js';
import {
  bookAnalysisSeed,
  bookCorrectionFingerprint,
  bookGraphFingerprint,
  chapterAnalysisSeed,
  chapterAnalysisSeeds,
  chapterSegmentFingerprint,
} from './workflow-query-service.js';

export async function registerProviderJobRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
  providerQueue?: Queue,
): Promise<void> {
  app.post<{
    Params: { bookId: string };
    Body: {
      chapterId?: unknown;
      chapterIds?: unknown;
      providerId?: unknown;
      modelId?: unknown;
      jobType?: unknown;
      force?: unknown;
      discoveredGraph?: unknown;
      sourceContext?: unknown;
    };
  }>('/api/books/:bookId/analysis-jobs', async (request, reply) => {
    const body = recordBody(request.body);
    if (!body) return reply.code(400).send({ error: 'request body is required' });

    const aiSettings = loadServerAISettings();
    const chapterId = stringField(body, 'chapterId');
    const requestedChapterIds = uniqueNonEmptyStrings(arrayOfStrings(body.chapterIds) ?? []);
    const requestedProviderId = optionalStringField(body, 'providerId');
    if (requestedProviderId && !isServerAIProviderId(requestedProviderId)) {
      return reply.code(400).send({ error: 'providerId is invalid' });
    }
    const initialSavedProviderSettings = requestedProviderId
      ? undefined
      : (await loadProviderSettingsBundle(pool, config, process.env, aiSettings)).llmLabeling;
    const savedDefaultProviderId = initialSavedProviderSettings?.defaultProviderId;
    const savedDefaultServerProviderId =
      savedDefaultProviderId && isServerAIProviderId(savedDefaultProviderId) ? savedDefaultProviderId : undefined;
    const providerId =
      requestedProviderId && isServerAIProviderId(requestedProviderId)
        ? requestedProviderId
        : (savedDefaultServerProviderId ?? aiSettings.defaultProviderId);
    const requestedModelId = optionalStringField(body, 'modelId');
    const jobType = (optionalStringField(body, 'jobType') ?? 'chapter_segment_labeling') as ProviderJobType;
    const force = body.force === true;
    const isGraphMergeJob = jobType === 'character_graph_merge';
    const isBundleAnalysisJob = jobType === 'character_bundle_analysis';

    if (!isGraphMergeJob && !isBundleAnalysisJob && !chapterId)
      return reply.code(400).send({ error: 'chapterId is required' });
    const bundleChapterIds = isBundleAnalysisJob
      ? uniqueNonEmptyStrings([...requestedChapterIds, ...(chapterId ? [chapterId] : [])])
      : [];
    if (isBundleAnalysisJob && bundleChapterIds.length === 0)
      return reply
        .code(400)
        .send({ error: 'chapterIds must contain at least one chapter for character_bundle_analysis' });
    const chapterJobId = isGraphMergeJob || isBundleAnalysisJob ? undefined : chapterId;
    if (
      jobType !== 'chapter_segment_labeling' &&
      jobType !== 'chapter_label_repair' &&
      jobType !== 'character_graph_merge' &&
      jobType !== 'character_bundle_analysis'
    ) {
      return reply.code(400).send({ error: 'jobType is not supported yet' });
    }
    if (!serverAIProviderIsImplemented(providerId))
      return reply.code(400).send({ error: 'provider is not implemented on this server yet' });
    const providerCatalog = (
      await providerSecretStatusBundle(pool, config, listServerProviderCatalog(process.env, aiSettings), process.env)
    ).catalog;
    const catalogProvider = providerCatalog.aiProviders.find((provider) => provider.providerId === providerId);
    if (!catalogProvider?.secretConfigured)
      return reply.code(400).send({ error: 'provider secret is not configured on this server yet' });
    const savedProviderSettings =
      initialSavedProviderSettings ??
      (await loadProviderSettingsBundle(pool, config, process.env, aiSettings)).llmLabeling;
    if (!providerEnabledBySettings(savedProviderSettings, providerId)) {
      return reply.code(400).send({ error: 'provider is disabled by saved provider settings' });
    }
    const resolvedProviderOptions = {
      ...providerOptionsForAIProvider(aiSettings, providerId),
      ...providerOptionsFromSettings(savedProviderSettings, providerId),
    };
    let requestProfile:
      | ReturnType<typeof resolveCharacterBundleAnalysisRequestProfile>
      | ReturnType<typeof resolveChapterLabelingRequestProfile>
      | ReturnType<typeof resolveChapterLabelRepairRequestProfile>
      | ReturnType<typeof resolveCharacterGraphMergeRequestProfile>;
    try {
      requestProfile = isBundleAnalysisJob
        ? resolveCharacterBundleAnalysisRequestProfile(resolvedProviderOptions)
        : jobType === 'chapter_label_repair'
          ? resolveChapterLabelRepairRequestProfile(resolvedProviderOptions)
          : isGraphMergeJob
            ? resolveCharacterGraphMergeRequestProfile(resolvedProviderOptions)
            : resolveChapterLabelingRequestProfile(resolvedProviderOptions);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'request profile is invalid' });
    }
    const providerOptionsHash = providerOptionsIntegrityHash(resolvedProviderOptions);
    const modelId =
      requestedModelId ??
      modelFromSettings(savedProviderSettings, providerId) ??
      modelIdForProvider(aiSettings, providerId);
    if (!modelId) return reply.code(400).send({ error: 'modelId is required for this provider' });

    const bookSeed =
      isGraphMergeJob || isBundleAnalysisJob ? await bookAnalysisSeed(pool, config, request.params.bookId) : undefined;
    const seed = chapterJobId
      ? await chapterAnalysisSeed(pool, config, request.params.bookId, chapterJobId)
      : undefined;
    const bundleSeeds = isBundleAnalysisJob
      ? await chapterAnalysisSeeds(pool, config, request.params.bookId, bundleChapterIds)
      : [];
    if ((isGraphMergeJob || isBundleAnalysisJob) && !bookSeed) return reply.code(404).send({ error: 'book not found' });
    if (!isGraphMergeJob && !isBundleAnalysisJob && !seed) return reply.code(404).send({ error: 'chapter not found' });
    if (isBundleAnalysisJob && bundleSeeds.length !== bundleChapterIds.length)
      return reply.code(404).send({ error: 'one or more bundle chapters were not found' });
    if (seed && Number(seed.character_count) > aiSettings.labelingMaxInputCharacters) {
      return reply.code(413).send({
        error: 'chapter is too large for configured AI labeling budget',
        characterCount: Number(seed.character_count),
        maxInputCharacters: aiSettings.labelingMaxInputCharacters,
      });
    }
    const bundleCharacterCount = bundleSeeds.reduce((sum, item) => sum + Number(item.character_count), 0);
    if (isBundleAnalysisJob && bundleCharacterCount > aiSettings.labelingMaxInputCharacters) {
      return reply.code(413).send({
        error: 'chapter bundle is too large for configured AI labeling budget',
        characterCount: bundleCharacterCount,
        maxInputCharacters: aiSettings.labelingMaxInputCharacters,
      });
    }
    let discoveredGraph: ReturnType<typeof normalizeCharacterGraphSnapshot> | undefined;
    let sourceContext: Record<string, unknown> | undefined;
    if (isGraphMergeJob) {
      try {
        discoveredGraph = normalizeCharacterGraphSnapshot(body.discoveredGraph, request.params.bookId);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'discoveredGraph is invalid' });
      }
      sourceContext = body.sourceContext === undefined ? undefined : recordBody(body.sourceContext);
      if (body.sourceContext !== undefined && !sourceContext)
        return reply.code(400).send({ error: 'sourceContext must be an object' });
    } else if (isBundleAnalysisJob) {
      sourceContext = body.sourceContext === undefined ? {} : recordBody(body.sourceContext);
      if (body.sourceContext !== undefined && !sourceContext)
        return reply.code(400).send({ error: 'sourceContext must be an object' });
      sourceContext = {
        ...sourceContext,
        bundleId:
          typeof sourceContext?.bundleId === 'string' && sourceContext.bundleId.trim()
            ? sourceContext.bundleId.trim()
            : characterAnalysisBundleId(request.params.bookId, bundleChapterIds),
        chapterIds: bundleSeeds.map((item) => item.id),
      };
    }
    const [graphFingerprint, correctionFingerprint] =
      isGraphMergeJob || isBundleAnalysisJob
        ? await Promise.all([
            bookGraphFingerprint(pool, request.params.bookId),
            bookCorrectionFingerprint(pool, request.params.bookId),
          ])
        : [undefined, undefined];
    const discoveredGraphHash = discoveredGraph ? characterGraphIntegrityHash(discoveredGraph) : undefined;
    const sourceContextHash = sourceContext ? providerSourceContextIntegrityHash(sourceContext) : undefined;
    const segmentFingerprint =
      jobType === 'chapter_label_repair' && chapterJobId
        ? await chapterSegmentFingerprint(pool, request.params.bookId, chapterJobId)
        : undefined;
    if (jobType === 'chapter_label_repair' && (!segmentFingerprint || segmentFingerprint.segmentCount === 0)) {
      return reply.code(400).send({ error: 'chapter_label_repair requires existing labeled segments' });
    }

    const inputCharacters = isBundleAnalysisJob
      ? bundleCharacterCount
      : seed
        ? Number(seed.character_count)
        : Number(bookSeed?.total_characters ?? 0);
    const capabilitySnapshot = resolveLLMCapabilitySnapshot({
      providerId,
      modelId,
      providerOptions: resolvedProviderOptions,
    });
    const taskProfileSnapshot = resolveProviderTaskProfile({
      jobType,
      requestProfile,
      providerId,
      modelId,
      providerOptions: resolvedProviderOptions,
    });
    const admissionSnapshot = buildProviderAdmissionSnapshot({
      capability: capabilitySnapshot,
      taskProfile: taskProfileSnapshot,
      components: [{ key: 'source', characters: inputCharacters, required: true }],
    });
    if (admissionSnapshot.decision === 'rejected') {
      return reply.code(413).send({
        error: 'provider input exceeds the resolved model capability',
        estimatedInputTokens: admissionSnapshot.estimatedInputTokens,
        availableInputTokens: admissionSnapshot.availableInputTokens,
        capabilitySnapshotId: capabilitySnapshot.id,
      });
    }
    const budgetEstimate = {
      providerId,
      modelId,
      inputCharacters,
      cacheHit: false,
      providerOptionsHash,
      requestProfileId: requestProfile.id,
      capabilitySnapshotId: capabilitySnapshot.id,
      admissionSnapshotId: admissionSnapshot.id,
      ...(isBundleAnalysisJob
        ? {
            bundleId: typeof sourceContext?.bundleId === 'string' ? sourceContext.bundleId : undefined,
            chapterCount: bundleSeeds.length,
            paragraphCount: bundleSeeds.reduce((sum, item) => sum + Number(item.paragraph_count), 0),
          }
        : {}),
      ...(segmentFingerprint ? { segmentCount: segmentFingerprint.segmentCount } : {}),
      ...(graphFingerprint
        ? {
            graphCharacterCount: graphFingerprint.characterCount,
            graphRelationCount: graphFingerprint.relationCount,
          }
        : {}),
      ...(discoveredGraph
        ? {
            discoveredCharacterCount: discoveredGraph.characters.length,
            discoveredRelationCount: discoveredGraph.relations.length,
          }
        : {}),
      ...(correctionFingerprint ? { correctionCount: correctionFingerprint.correctionCount } : {}),
    };

    const inputHash = providerRequestIntegrityHash({
      bookId: request.params.bookId,
      chapterId: chapterJobId,
      jobType,
      providerId,
      modelId,
      requestProfileId: requestProfile.id,
      promptVersion: requestProfile.promptVersion,
      schemaVersion: requestProfile.schemaVersion,
      chapterTextHash: seed?.text_hash,
      chapterUpdatedAt: seed ? isoString(seed.updated_at) : undefined,
      paragraphCount: seed ? Number(seed.paragraph_count) : undefined,
      characterCount: seed ? Number(seed.character_count) : undefined,
      bundleChapters: isBundleAnalysisJob
        ? bundleSeeds.map((item) => ({
            chapterId: item.id,
            textHash: item.text_hash,
            updatedAt: isoString(item.updated_at),
            paragraphCount: Number(item.paragraph_count),
            characterCount: Number(item.character_count),
          }))
        : undefined,
      bundleCharacterCount: isBundleAnalysisJob ? bundleCharacterCount : undefined,
      normalizedTextHash: bookSeed?.normalized_text_hash,
      totalChapters: bookSeed ? Number(bookSeed.total_chapters) : undefined,
      totalCharacters: bookSeed ? Number(bookSeed.total_characters) : undefined,
      totalParagraphs: bookSeed ? Number(bookSeed.total_paragraphs) : undefined,
      graphHash: graphFingerprint?.graphHash,
      graphCharacterCount: graphFingerprint?.characterCount,
      graphRelationCount: graphFingerprint?.relationCount,
      discoveredGraphHash,
      sourceContextHash,
      correctionHash: correctionFingerprint?.correctionHash,
      correctionCount: correctionFingerprint?.correctionCount,
      segmentHash: segmentFingerprint?.segmentHash,
      segmentCount: segmentFingerprint?.segmentCount,
      providerOptionsHash,
      capabilitySnapshotId: capabilitySnapshot.id,
      taskProfileId: taskProfileSnapshot.id,
      admissionSnapshotId: admissionSnapshot.id,
    });
    const jobId = providerJobId({
      userId: config.defaultUserId,
      novelId: request.params.bookId,
      chapterId: chapterJobId,
      jobType,
      providerId,
      modelId,
      inputHash,
    });
    const existing = await pool.query<ProviderJobRow>(
      `
          select id, book_id, chapter_id, job_type, provider_id, model_id, input_hash, status,
                 stage, progress, error_code, error_message, created_at, updated_at, started_at, finished_at,
                 current_attempt_id
          from provider_jobs
          where book_id = $1
            and chapter_id is not distinct from $2
            and job_type = $3
            and provider_id = $4
            and model_id is not distinct from $5
            and input_hash = $6
            and user_id = $7
        `,
      [request.params.bookId, chapterJobId ?? null, jobType, providerId, modelId, inputHash, config.defaultUserId],
    );

    let row = existing.rows[0];
    if (!row) {
      const inserted = await pool.query<ProviderJobRow>(
        `
            insert into provider_jobs (
              id, user_id, book_id, chapter_id, job_type, provider_id, model_id, input_hash,
              status, stage, progress, created_at, updated_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', 'queued', $9, now(), now())
            returning id, book_id, chapter_id, job_type, provider_id, model_id, input_hash, status,
                      stage, progress, error_code, error_message, created_at, updated_at, started_at, finished_at,
                      current_attempt_id
          `,
        [
          jobId,
          config.defaultUserId,
          request.params.bookId,
          chapterJobId ?? null,
          jobType,
          providerId,
          modelId,
          inputHash,
          JSON.stringify({
            budgetEstimate,
            providerOptions: resolvedProviderOptions,
            capabilitySnapshot,
            taskProfileSnapshot,
            admissionSnapshot,
            ...(discoveredGraph ? { discoveredGraph } : {}),
            ...(sourceContext ? { sourceContext } : {}),
            ...(graphFingerprint ? { graphFingerprint } : {}),
            ...(correctionFingerprint ? { correctionFingerprint } : {}),
          }),
        ],
      );
      row = inserted.rows[0];
    } else if (row.status === 'failed' || row.status === 'cancelled' || (force && row.status === 'succeeded')) {
      const expectedStatus = row.status;
      const expectedAttemptId = row.current_attempt_id ?? null;
      const updated = await pool.query<ProviderJobRow>(
        `
            update provider_jobs
            set status = 'queued',
                stage = 'queued',
                progress = $3,
                error_code = null,
                error_message = null,
                started_at = null,
                finished_at = null,
                updated_at = now()
            where id = $1
              and user_id = $2
              and status = $4
              and current_attempt_id is not distinct from $5
            returning id, book_id, chapter_id, job_type, provider_id, model_id, input_hash, status,
                      stage, progress, error_code, error_message, created_at, updated_at, started_at, finished_at,
                      current_attempt_id
          `,
        [
          row.id,
          config.defaultUserId,
          JSON.stringify({
            budgetEstimate,
            providerOptions: resolvedProviderOptions,
            ...(discoveredGraph ? { discoveredGraph } : {}),
            ...(sourceContext ? { sourceContext } : {}),
            ...(graphFingerprint ? { graphFingerprint } : {}),
            ...(correctionFingerprint ? { correctionFingerprint } : {}),
          }),
          expectedStatus,
          expectedAttemptId,
        ],
      );
      row = updated.rows[0] ?? row;
    }

    if (!row) return reply.code(500).send({ error: 'provider job could not be created' });
    if (row.status === 'queued') {
      await pool.query(
        'update library_books set analysis_status = $1, updated_at = now() where id = $2 and user_id = $3',
        ['queued', request.params.bookId, config.defaultUserId],
      );
    }
    if (row.status === 'queued' && providerQueue) {
      try {
        await enqueueProviderJob(pool, providerQueue, row.id, providerJobAdmissionLimits(config));
      } catch (error) {
        const rejection = sendProviderJobAdmissionRejection(reply, error);
        if (rejection) return rejection;
        throw error;
      }
    }

    return reply.code(row.status === 'queued' ? 202 : 200).send({ job: mapProviderJob(row) });
  });

  app.get<{ Params: { jobId: string } }>('/api/provider-jobs/:jobId', async (request, reply) => {
    const row = await loadProviderJob(pool, config, request.params.jobId);
    if (!row) return reply.code(404).send({ error: 'provider job not found' });
    return { job: mapProviderJob(row) };
  });

  app.post<{ Params: { jobId: string } }>('/api/provider-jobs/:jobId/cancel', async (request, reply) => {
    const row = await loadProviderJob(pool, config, request.params.jobId);
    if (!row) return reply.code(404).send({ error: 'provider job not found' });
    if (row.status === 'cancelled') return { job: mapProviderJob(row) };
    if (row.status === 'succeeded' || row.status === 'failed') {
      return reply.code(409).send({ error: 'provider job is already terminal', job: mapProviderJob(row) });
    }

    const cancelRequestedAt = new Date().toISOString();
    const progress = {
      ...providerJobProgressRecord(row.progress),
      cancelled: true,
      cancelRequestedAt,
    };
    const updated = await pool.query<ProviderJobRow>(
      `
          with cancelled_job as (
            update provider_jobs
            set status = 'cancelled',
                stage = 'cancelled',
                progress = $3,
                error_code = 'provider_job_cancelled',
                error_message = $4,
                finished_at = now(),
                updated_at = now()
            where id = $1
              and user_id = $2
              and status = $5
              and current_attempt_id is not distinct from $6
            returning id, book_id, chapter_id, job_type, provider_id, model_id, input_hash, status,
                      stage, progress, error_code, error_message, created_at, updated_at, started_at, finished_at,
                      current_attempt_id
          ),
          cancelled_attempt as (
            update provider_job_attempts attempt
            set status = 'cancelled',
                stage = 'cancelled',
                outcome_state = 'cancelled',
                billing_state = case
                  when attempt.dispatch_started_at is null then 'not_billable'
                  else 'billed_possible'
                end,
                normalized_error_code = 'provider_job_cancelled',
                reconcile_after = null,
                lease_expires_at = null,
                progress = $3,
                error_code = 'provider_job_cancelled',
                error_message = $4,
                finished_at = now(),
                updated_at = now()
            from cancelled_job
            where attempt.id = cancelled_job.current_attempt_id
              and attempt.provider_job_id = cancelled_job.id
              and attempt.status in ('queued', 'running')
            returning attempt.id
          )
          select cancelled_job.* from cancelled_job
        `,
      [
        row.id,
        config.defaultUserId,
        JSON.stringify(progress),
        'Provider job cancelled by user',
        row.status,
        row.current_attempt_id ?? null,
      ],
    );
    const updatedRow = updated.rows[0] ?? (await loadProviderJob(pool, config, row.id));
    if (!updatedRow) return reply.code(404).send({ error: 'provider job not found' });
    if (!updated.rows[0]) {
      if (updatedRow.status === 'cancelled') return { job: mapProviderJob(updatedRow) };
      if (updatedRow.status === 'succeeded' || updatedRow.status === 'failed') {
        return reply.code(409).send({ error: 'provider job is already terminal', job: mapProviderJob(updatedRow) });
      }
      return reply.code(409).send({ error: 'provider job attempt changed', job: mapProviderJob(updatedRow) });
    }
    const queueRemoval = await removeProviderQueueJob(
      pool,
      providerQueue,
      updatedRow.id,
      config.defaultUserId,
      updatedRow.current_attempt_id ?? null,
    );
    const finalizedProgress = {
      ...providerJobProgressRecord(updatedRow.progress),
      queueRemoval,
    };
    const finalized = await pool.query<ProviderJobRow>(
      `
          update provider_jobs
          set progress = $3,
              updated_at = now()
          where id = $1
            and user_id = $2
            and status = 'cancelled'
            and current_attempt_id is not distinct from $4
          returning id, book_id, chapter_id, job_type, provider_id, model_id, input_hash, status,
                    stage, progress, error_code, error_message, created_at, updated_at, started_at, finished_at,
                    current_attempt_id
        `,
      [updatedRow.id, config.defaultUserId, JSON.stringify(finalizedProgress), updatedRow.current_attempt_id ?? null],
    );
    const finalRow = finalized.rows[0] ?? (await loadProviderJob(pool, config, updatedRow.id)) ?? updatedRow;
    await advanceBookAIWorkflowsForProviderJob(pool, config, providerQueue, finalRow.id);
    return { job: mapProviderJob(finalRow) };
  });
}
