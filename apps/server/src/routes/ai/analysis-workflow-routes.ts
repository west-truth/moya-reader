import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { resolveCharacterBundleAnalysisRequestProfile } from '../../../../../src/providers/character-bundle-request-profile';
import { resolveLabelingContextCapability } from '../../../../../src/providers/labeling-context-packet';
import type { ServerConfig } from '../../config.js';
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
import {
  refreshBookAIWorkflowTTSCacheReadiness,
  resumeBookAIWorkflow,
} from '../../services/book-ai-workflow-service.js';
import { cancelBookAIWorkflow } from '../../services/book-ai-workflow/workflow-cancellation-service.js';
import { startBookAIWorkflow } from '../../services/book-ai-workflow/workflow-start-service.js';
import {
  AnalysisReviewConflictError,
  AnalysisReviewInputError,
  AnalysisReviewNotFoundError,
  getAnalysisReview,
  listWorkflowAnalysisReviews,
  rejectAnalysisReview,
  saveChapterLabelReviewDraft,
} from '../../services/book-ai-workflow/analysis-review-service.js';
import type { ChapterLabelingResult } from '../../../../../src/providers/ai';
import type { SaveChapterLabelReviewDraftInput } from '../../../../../src/providers/analysis-review';
import { approveAnalysisReview } from '../../services/book-ai-workflow/analysis-review-promotion-service.js';
import { AnalysisInputStaleError } from '../../services/book-ai-workflow/analysis-input-contracts.js';
import { sendProviderJobAdmissionRejection } from './provider-admission-response.js';
import { optionalStringField, recordBody, workflowPlanOptionsFromQuery } from './request-contracts.js';
import {
  bookAnalysisSeed,
  buildHostedBookAIWorkflowPlan,
  chapterAnalysisSeeds,
  loadBookAIWorkflow,
  mapBookAIWorkflow,
} from './workflow-query-service.js';

export async function registerAnalysisWorkflowRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
  providerQueue?: Queue,
): Promise<void> {
  app.get<{
    Params: { bookId: string };
    Querystring: {
      maxBundleChapters?: string;
      targetBundleCharacters?: string;
      maxLabelingParagraphs?: string;
      targetLabelingCharacters?: string;
    };
  }>('/api/books/:bookId/analysis-workflow-plan', async (request, reply) => {
    const parsedOptions = workflowPlanOptionsFromQuery(request.query as Record<string, unknown>);
    if ('error' in parsedOptions) return reply.code(400).send({ error: parsedOptions.error });
    const plan = await buildHostedBookAIWorkflowPlan(pool, config, request.params.bookId, parsedOptions.options);
    if (!plan) return reply.code(404).send({ error: 'book not found' });

    return { plan };
  });

  app.get<{ Params: { workflowId: string } }>('/api/analysis-workflows/:workflowId', async (request, reply) => {
    const workflow = await loadBookAIWorkflow(pool, config, request.params.workflowId);
    if (!workflow) return reply.code(404).send({ error: 'analysis workflow not found' });
    return { workflow: mapBookAIWorkflow(workflow.row, workflow.jobs) };
  });

  app.get<{ Params: { workflowId: string } }>('/api/analysis-workflows/:workflowId/reviews', async (request, reply) => {
    const workflow = await loadBookAIWorkflow(pool, config, request.params.workflowId);
    if (!workflow) return reply.code(404).send({ error: 'analysis workflow not found' });
    return {
      reviews: await listWorkflowAnalysisReviews(pool, request.params.workflowId, config.defaultUserId),
    };
  });

  app.get<{ Params: { reviewId: string } }>('/api/analysis-review-artifacts/:reviewId', async (request, reply) => {
    const review = await getAnalysisReview(pool, request.params.reviewId, config.defaultUserId);
    return review ? { review } : reply.code(404).send({ error: 'analysis review artifact not found' });
  });

  app.post<{
    Params: { reviewId: string };
    Body: {
      action?: unknown;
      expectedReviewRevision?: unknown;
      candidate?: unknown;
      editIntents?: unknown;
      reason?: unknown;
    };
  }>('/api/analysis-review-artifacts/:reviewId/decisions', async (request, reply) => {
    const body = recordBody(request.body) ?? {};
    const action = typeof body.action === 'string' ? body.action : '';
    const expectedReviewRevision = Number(body.expectedReviewRevision);
    try {
      if (action === 'save_draft') {
        if (body.candidate === undefined) return reply.code(400).send({ error: 'candidate is required' });
        const review = await saveChapterLabelReviewDraft(pool, request.params.reviewId, config.defaultUserId, {
          expectedReviewRevision,
          candidate: body.candidate as ChapterLabelingResult,
          editIntents: body.editIntents as SaveChapterLabelReviewDraftInput['editIntents'],
        });
        return { review };
      }
      if (action === 'reject') {
        const review = await rejectAnalysisReview(pool, request.params.reviewId, config.defaultUserId, {
          expectedReviewRevision,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        });
        return { review };
      }
      if (action === 'approve') {
        const review = await approveAnalysisReview(
          pool,
          config,
          providerQueue,
          request.params.reviewId,
          expectedReviewRevision,
        );
        return { review };
      }
      return reply.code(400).send({
        error: 'unsupported analysis review action',
        supportedActions: ['save_draft', 'approve', 'reject'],
      });
    } catch (error) {
      if (error instanceof AnalysisReviewNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      if (error instanceof AnalysisReviewConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof AnalysisInputStaleError) {
        return reply.code(409).send({ error: error.message, errorCode: error.code });
      }
      if (error instanceof AnalysisReviewInputError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { workflowId: string }; Body: { action?: string } }>(
    '/api/analysis-workflows/:workflowId/retry',
    async (request, reply) => {
      const action = request.body?.action ?? 'retry_same_request';
      if (action !== 'retry_same_request') {
        return reply.code(400).send({
          error: 'unsupported workflow retry action',
          supportedActions: ['retry_same_request'],
        });
      }
      let resumed;
      try {
        resumed = await resumeBookAIWorkflow(pool, config, providerQueue, request.params.workflowId);
      } catch (error) {
        const rejection = sendProviderJobAdmissionRejection(reply, error);
        if (rejection) return rejection;
        throw error;
      }
      if (!resumed) return reply.code(404).send({ error: 'analysis workflow not found' });
      const workflow = await loadBookAIWorkflow(pool, config, request.params.workflowId);
      if (!workflow) return reply.code(404).send({ error: 'analysis workflow not found' });
      return { workflow: mapBookAIWorkflow(workflow.row, workflow.jobs) };
    },
  );

  app.post<{ Params: { workflowId: string } }>(
    '/api/analysis-workflows/:workflowId/tts-cache-readiness',
    async (request, reply) => {
      const report = await refreshBookAIWorkflowTTSCacheReadiness(pool, config, request.params.workflowId);
      if (!report) return reply.code(404).send({ error: 'analysis workflow not found' });
      const workflow = await loadBookAIWorkflow(pool, config, request.params.workflowId);
      if (!workflow) return reply.code(404).send({ error: 'analysis workflow not found' });
      return { workflow: mapBookAIWorkflow(workflow.row, workflow.jobs), ttsCacheReadiness: report };
    },
  );

  app.post<{ Params: { workflowId: string } }>('/api/analysis-workflows/:workflowId/cancel', async (request, reply) => {
    const result = await cancelBookAIWorkflow(pool, config, providerQueue, request.params.workflowId);
    if (result.kind === 'not_found') return reply.code(404).send({ error: 'analysis workflow not found' });

    const workflow = await loadBookAIWorkflow(pool, config, request.params.workflowId);
    if (!workflow) return reply.code(404).send({ error: 'analysis workflow not found' });
    if (result.kind === 'terminal') {
      return reply.code(409).send({
        error: 'analysis workflow is already terminal',
        workflow: mapBookAIWorkflow(workflow.row, workflow.jobs),
      });
    }
    return { workflow: mapBookAIWorkflow(workflow.row, workflow.jobs) };
  });

  app.post<{
    Params: { bookId: string };
    Body: {
      providerId?: unknown;
      modelId?: unknown;
      planOptions?: unknown;
      force?: unknown;
    };
  }>('/api/books/:bookId/analysis-workflows', async (request, reply) => {
    const body = recordBody(request.body) ?? {};
    const rawPlanOptions: Record<string, unknown> =
      body.planOptions === undefined ? {} : (recordBody(body.planOptions) ?? {});
    if (body.planOptions !== undefined && !rawPlanOptions) {
      return reply.code(400).send({ error: 'planOptions must be an object' });
    }
    const parsedOptions = workflowPlanOptionsFromQuery(rawPlanOptions);
    if ('error' in parsedOptions) return reply.code(400).send({ error: parsedOptions.error });
    const aiSettings = loadServerAISettings();
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
    let requestProfile: ReturnType<typeof resolveCharacterBundleAnalysisRequestProfile>;
    try {
      requestProfile = resolveCharacterBundleAnalysisRequestProfile(resolvedProviderOptions);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'request profile is invalid' });
    }
    const requestedModelId = optionalStringField(body, 'modelId');
    const modelId =
      requestedModelId ??
      modelFromSettings(savedProviderSettings, providerId) ??
      modelIdForProvider(aiSettings, providerId);
    if (!modelId) return reply.code(400).send({ error: 'modelId is required for this provider' });

    const [plan, bookSeed] = await Promise.all([
      buildHostedBookAIWorkflowPlan(
        pool,
        config,
        request.params.bookId,
        parsedOptions.options,
        resolveLabelingContextCapability({ providerId, modelId, providerOptions: resolvedProviderOptions }),
      ),
      bookAnalysisSeed(pool, config, request.params.bookId),
    ]);
    if (!plan || !bookSeed) return reply.code(404).send({ error: 'book not found' });
    if (plan.bundleWindows.length === 0) return reply.code(400).send({ error: 'book has no chapters to analyze' });

    for (const window of plan.bundleWindows) {
      const bundleSeeds = await chapterAnalysisSeeds(pool, config, request.params.bookId, window.chapterIds);
      if (bundleSeeds.length !== window.chapterIds.length)
        return reply.code(404).send({ error: 'one or more bundle chapters were not found' });
      const bundleCharacterCount = bundleSeeds.reduce((sum, item) => sum + Number(item.character_count), 0);
      if (bundleCharacterCount > aiSettings.labelingMaxInputCharacters) {
        return reply.code(413).send({
          error: 'chapter bundle is too large for configured AI labeling budget',
          workflowWindowId: window.id,
          characterCount: bundleCharacterCount,
          maxInputCharacters: aiSettings.labelingMaxInputCharacters,
        });
      }
    }
    let started;
    try {
      started = await startBookAIWorkflow(pool, config, providerQueue, {
        bookId: request.params.bookId,
        providerId,
        modelId,
        plan,
        providerOptions: resolvedProviderOptions,
        requestProfile,
      });
    } catch (error) {
      const rejection = sendProviderJobAdmissionRejection(reply, error);
      if (rejection) return rejection;
      throw error;
    }
    const loaded = await loadBookAIWorkflow(pool, config, started.workflowId);
    if (!loaded) return reply.code(500).send({ error: 'analysis workflow could not be loaded' });
    return reply.code(started.reused ? 200 : 202).send({
      workflow: mapBookAIWorkflow(loaded.row, loaded.jobs),
    });
  });
}
