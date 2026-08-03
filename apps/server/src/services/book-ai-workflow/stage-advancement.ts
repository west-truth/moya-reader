import type { Queue } from 'bullmq';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { characterGraphIntegrityHash, workflowCharacterBundleId } from '@noveldesk/text-core/identity/ai';
import {
  providerOptionsIntegrityHash,
  providerRequestIntegrityHash,
  providerSourceContextIntegrityHash,
} from '@noveldesk/text-core/identity/provider';
import type {
  BookAIWorkflowBundleWindow,
  BookAIWorkflowPlan,
} from '../../../../../src/providers/book-ai-workflow-plan';
import type { CharacterBundleAnalysisResult, CharacterGraph } from '../../../../../src/providers/ai';
import { resolveCharacterBundleAnalysisRequestProfile } from '../../../../../src/providers/character-bundle-request-profile';
import { resolveCharacterGraphMergeRequestProfile } from '../../../../../src/providers/character-graph-request-profile';
import { resolveChapterLabelingRequestProfile } from '../../../../../src/providers/chapter-labeling-request-profile';
import { compactSpeakerAttributionRequestProfile } from '../../../../../src/providers/speaker-attribution/request-profile';
import { resolveChapterLabelRepairRequestProfile } from '../../../../../src/providers/chapter-label-repair-request-profile';
import type { ChapterLabelingValidationIssue } from '../../../../../src/providers/chapter-labeling-validator';
import { normalizeCharacterGraphSnapshot } from '../../../../../src/providers/character-graph-snapshot';
import {
  assertLabelingContextPacketAdmitted,
  buildLabelingContextPacket,
} from '../../../../../src/providers/labeling-context-packet';
import type { ProviderJobRow } from '../provider-jobs/contracts.js';
import { loadChapter, loadParagraphContextHalo, loadParagraphs } from '../provider-jobs/job-data-loader.js';
import {
  pinChapterLabelingInput,
  pinSpeakerAttributionInput,
  pinChapterLabelRepairInput,
  pinCharacterBundleAnalysisInput,
  pinCharacterGraphMergeInput,
} from './analysis-input-builder.js';
import { loadAnalysisInputRevisionForJob } from './analysis-input-repository.js';
import { assertPinnedRepairRequestProfile, verifyAnalysisInputBeforeExecution } from './analysis-input-verification.js';
import { insertProviderJob, linkWorkflowJob, maybeEnqueueProviderJob } from './child-job-repository.js';
import { loadPreviousWorkflowEpisodeContext } from './episode-context-repository.js';
import { loadPinnedCorrections, lockBookRevisionState, pinParagraphText } from './revision-snapshot-repository.js';
import { loadAnalysisArtifact, loadPromotedAnalysisArtifactForJob } from './staging-artifact-repository.js';
import { withBookAITransaction } from './transaction.js';
import type { BookAIWorkflowRow, ProviderJobStatus, WorkflowProviderJobLinkRow } from './workflow-contracts.js';
import { updateWorkflowProgress } from './workflow-repository.js';
import { providerOptionsFromProgress, recordValue, stringArrayValue } from './workflow-state.js';
import { loadCharacterGraphKnowledgeV2 } from '../character-graph-v2-service.js';
import { materializeHostedSpeakerAttributionInput } from './speaker-attribution-input-materializer.js';

function providerJob(
  workflow: BookAIWorkflowRow,
  input: {
    readonly id: string;
    readonly chapterId?: string;
    readonly jobType: string;
    readonly inputHash: string;
    readonly status: ProviderJobStatus;
    readonly progress: Readonly<Record<string, unknown>>;
  },
): ProviderJobRow {
  return {
    id: input.id,
    user_id: workflow.user_id,
    book_id: workflow.book_id,
    chapter_id: input.chapterId ?? null,
    job_type: input.jobType,
    provider_id: workflow.provider_id,
    model_id: workflow.model_id,
    input_hash: input.inputHash,
    status: input.status,
    progress: input.progress,
  };
}

function contextHaloRadius(providerOptions: Readonly<Record<string, unknown>>): number {
  const value = providerOptions.contextHaloParagraphs;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 2;
  return Number.isFinite(parsed) ? Math.min(8, Math.max(0, Math.floor(parsed))) : 2;
}

function bundleArtifactPayload(value: unknown, bookId: string): CharacterBundleAnalysisResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Character bundle artifact is invalid');
  const body = value as Record<string, unknown>;
  const sourceChapterIds = Array.isArray(body.sourceChapterIds)
    ? body.sourceChapterIds.filter((item): item is string => typeof item === 'string')
    : [];
  if (typeof body.bundleId !== 'string') throw new Error('Character bundle artifact has no bundle id');
  return {
    novelId: bookId,
    bundleId: body.bundleId,
    sourceChapterIds,
    discoveredGraph: normalizeCharacterGraphSnapshot(body.discoveredGraph, bookId),
    bundleSummaryForNext: typeof body.bundleSummaryForNext === 'string' ? body.bundleSummaryForNext : undefined,
  };
}

function mergeBundleArtifacts(bookId: string, artifacts: readonly CharacterBundleAnalysisResult[]): CharacterGraph {
  const characters = new Map<string, CharacterGraph['characters'][number]>();
  const relations = new Map<string, CharacterGraph['relations'][number]>();
  for (const artifact of artifacts) {
    for (const character of artifact.discoveredGraph.characters) characters.set(character.id, character);
    for (const relation of artifact.discoveredGraph.relations) relations.set(relation.id, relation);
  }
  return { novelId: bookId, characters: [...characters.values()], relations: [...relations.values()] };
}

function repairIssuesFromArtifact(value: unknown): ChapterLabelingValidationIssue[] {
  if (!Array.isArray(value)) throw new Error('Repair candidate artifact has no issue list');
  return value.map((item) => {
    const issue = recordValue(item);
    if (!issue || (issue.severity !== 'error' && issue.severity !== 'warning')) {
      throw new Error('Repair candidate artifact issue is invalid');
    }
    if (typeof issue.code !== 'string' || !issue.code.trim() || typeof issue.message !== 'string') {
      throw new Error('Repair candidate artifact issue is incomplete');
    }
    return {
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      segmentId: typeof issue.segmentId === 'string' ? issue.segmentId : undefined,
      paragraphId: typeof issue.paragraphId === 'string' ? issue.paragraphId : undefined,
    };
  });
}

async function providerOptionsForPreviousJob(
  pool: pg.Pool,
  workflow: BookAIWorkflowRow,
  previousLink?: WorkflowProviderJobLinkRow,
): Promise<Record<string, unknown>> {
  if (!previousLink?.analysis_input_revision_id) return providerOptionsFromProgress(workflow.progress);
  const revision = await loadAnalysisInputRevisionForJob(pool, previousLink.provider_job_id);
  return revision ? { ...revision.providerOptions } : providerOptionsFromProgress(workflow.progress);
}

function legacyBundleResult(link: WorkflowProviderJobLinkRow, bookId: string): CharacterBundleAnalysisResult {
  const progress = recordValue(link.progress) ?? {};
  const sourceContext = recordValue(progress.sourceContext);
  return {
    novelId: bookId,
    bundleId: typeof progress.bundleId === 'string' ? progress.bundleId : link.plan_item_id,
    sourceChapterIds: stringArrayValue(progress.sourceChapterIds ?? sourceContext?.chapterIds),
    discoveredGraph: normalizeCharacterGraphSnapshot(progress.discoveredGraph, bookId),
    bundleSummaryForNext: typeof progress.bundleSummaryForNext === 'string' ? progress.bundleSummaryForNext : undefined,
  };
}

async function loadBundleResult(
  pool: pg.Pool,
  link: WorkflowProviderJobLinkRow,
  bookId: string,
): Promise<CharacterBundleAnalysisResult> {
  if (!link.analysis_input_revision_id) return legacyBundleResult(link, bookId);
  const artifact = await loadPromotedAnalysisArtifactForJob(pool, link.provider_job_id, 'character_bundle');
  if (!artifact) throw new Error(`Promoted bundle artifact not found: ${link.provider_job_id}`);
  return bundleArtifactPayload(artifact.payload, bookId);
}

export async function enqueueGraphBootstrapJob(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  workflow: BookAIWorkflowRow,
  window: BookAIWorkflowBundleWindow,
  previousLink: WorkflowProviderJobLinkRow | undefined,
): Promise<boolean> {
  const providerOptions = await providerOptionsForPreviousJob(pool, workflow, previousLink);
  const requestProfile = resolveCharacterBundleAnalysisRequestProfile(providerOptions);
  const previousResult = previousLink ? await loadBundleResult(pool, previousLink, workflow.book_id) : undefined;

  const created = await withBookAITransaction(pool, async (client) => {
    const state = await lockBookRevisionState(client, workflow.user_id, workflow.book_id);
    if (!state) throw new Error(`Book not found for workflow: ${workflow.book_id}`);
    if (
      state.contentRevisionId !== workflow.content_revision_id ||
      state.revisionFence !== Number(workflow.revision_fence)
    ) {
      throw new Error(`Workflow revision fence is stale: ${workflow.id}`);
    }
    const corrections = await loadPinnedCorrections(client, state);
    const chapterSeeds = await client.query<{
      id: string;
      text_hash: string;
      updated_at: Date | string;
      paragraph_count: number | string;
      character_count: number | string;
    }>(
      `
        select id, text_hash, updated_at, paragraph_count, character_count
        from chapters
        where book_id = $1 and id = any($2::text[])
        order by chapter_index
      `,
      [workflow.book_id, window.chapterIds],
    );
    if (chapterSeeds.rows.length !== window.chapterIds.length) {
      throw new Error(`Bundle chapters not found for workflow window: ${window.id}`);
    }
    const sourceContext = {
      workflowId: workflow.id,
      workflowStage: 'character_graph_bootstrap',
      bundleId: window.bundleId,
      planWindowId: window.id,
      sequence: window.sequence,
      chapterIds: chapterSeeds.rows.map((item) => item.id),
      previousBundleId: window.previousBundleId,
      previousBundleJobId: previousLink?.provider_job_id,
      ...(previousResult?.bundleSummaryForNext ? { summary: previousResult.bundleSummaryForNext } : {}),
    };
    const inputHash = providerRequestIntegrityHash({
      bookId: workflow.book_id,
      jobType: 'character_bundle_analysis',
      providerId: workflow.provider_id,
      modelId: workflow.model_id,
      requestProfileId: requestProfile.id,
      promptVersion: requestProfile.promptVersion,
      schemaVersion: requestProfile.schemaVersion,
      planHash: workflow.plan_hash,
      contentRevisionId: state.contentRevisionId,
      revisionFence: state.revisionFence,
      characterGraphRevisionId: state.graphRevisionId,
      characterGraphFingerprint: state.graphFingerprint,
      correctionFingerprint: corrections.fingerprint,
      bundleChapters: chapterSeeds.rows.map((item) => ({
        chapterId: item.id,
        textHash: item.text_hash,
        paragraphCount: Number(item.paragraph_count),
        characterCount: Number(item.character_count),
      })),
      normalizedTextHash: state.normalizedTextHash,
      sourceContextHash: providerSourceContextIntegrityHash(sourceContext),
      providerOptionsFingerprint: providerOptionsIntegrityHash(providerOptions),
    });
    const progress = {
      providerOptions,
      sourceContext,
      budgetEstimate: {
        providerId: workflow.provider_id,
        modelId: workflow.model_id ?? undefined,
        inputCharacters: window.characterCount,
        cacheHit: false,
        requestProfileId: requestProfile.id,
        workflowId: workflow.id,
        planWindowId: window.id,
      },
    };
    const row = await insertProviderJob(client, {
      userId: workflow.user_id,
      bookId: workflow.book_id,
      jobType: 'character_bundle_analysis',
      providerId: workflow.provider_id,
      modelId: workflow.model_id,
      inputHash,
      progress,
    });
    const pinnedJob = providerJob(workflow, {
      id: row.id,
      jobType: 'character_bundle_analysis',
      inputHash,
      status: row.status,
      progress,
    });
    await pinCharacterBundleAnalysisInput(client, {
      workflow,
      job: pinnedJob,
      window,
      providerOptions,
      requestProfile,
      previousBundleSummary: previousResult?.bundleSummaryForNext,
    });
    await linkWorkflowJob(client, {
      workflowId: workflow.id,
      providerJobId: row.id,
      stage: 'character_graph_bootstrap',
      planItemId: window.id,
      sequence: window.sequence,
    });
    await updateWorkflowProgress(client, workflow, {
      stage: 'building_graph',
      progress: {
        totalBundleWindows: (workflow.plan as BookAIWorkflowPlan).bundleWindows.length,
        queuedGraphBootstrapJobs: row.status === 'queued' ? 1 : 0,
        nextGraphBootstrapJob: {
          providerJobId: row.id,
          planItemId: window.id,
          sequence: window.sequence,
          status: row.status,
          previousBundleJobId: previousLink?.provider_job_id,
          hasPreviousBundleSummary: Boolean(previousResult?.bundleSummaryForNext),
        },
      },
    });
    return row;
  });
  return maybeEnqueueProviderJob(pool, config, queue, created);
}

export async function enqueueGraphMergeJob(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  workflow: BookAIWorkflowRow,
  bootstrapLinks: readonly WorkflowProviderJobLinkRow[],
): Promise<boolean> {
  const artifacts = await Promise.all(bootstrapLinks.map((link) => loadBundleResult(pool, link, workflow.book_id)));
  const providerOptions = await providerOptionsForPreviousJob(pool, workflow, bootstrapLinks[0]);
  const requestProfile = resolveCharacterGraphMergeRequestProfile(providerOptions);
  const discoveredGraph = mergeBundleArtifacts(workflow.book_id, artifacts);
  const sourceChapterIds = [...new Set(artifacts.flatMap((artifact) => artifact.sourceChapterIds))];
  const sourceContext = {
    bundleId: workflowCharacterBundleId(workflow.book_id, workflow.id),
    chapterIds: sourceChapterIds,
    summary: artifacts
      .map((artifact) => artifact.bundleSummaryForNext ?? '')
      .filter(Boolean)
      .join('\n'),
  };

  const created = await withBookAITransaction(pool, async (client) => {
    const state = await lockBookRevisionState(client, workflow.user_id, workflow.book_id);
    if (!state) throw new Error(`Book not found for workflow: ${workflow.book_id}`);
    const corrections = await loadPinnedCorrections(client, state);
    const inputHash = providerRequestIntegrityHash({
      bookId: workflow.book_id,
      jobType: 'character_graph_merge',
      providerId: workflow.provider_id,
      modelId: workflow.model_id,
      requestProfileId: requestProfile.id,
      promptVersion: requestProfile.promptVersion,
      schemaVersion: requestProfile.schemaVersion,
      planHash: workflow.plan_hash,
      contentRevisionId: state.contentRevisionId,
      revisionFence: state.revisionFence,
      characterGraphRevisionId: state.graphRevisionId,
      characterGraphFingerprint: state.graphFingerprint,
      correctionFingerprint: corrections.fingerprint,
      discoveredGraphHash: characterGraphIntegrityHash(discoveredGraph),
      sourceContextHash: providerSourceContextIntegrityHash(sourceContext),
      providerOptionsFingerprint: providerOptionsIntegrityHash(providerOptions),
    });
    const progress = {
      providerOptions,
      sourceContext: {
        ...sourceContext,
        workflowId: workflow.id,
        workflowStage: 'character_graph_merge',
        sourceBundleJobIds: bootstrapLinks.map((link) => link.provider_job_id),
      },
      budgetEstimate: {
        providerId: workflow.provider_id,
        modelId: workflow.model_id ?? undefined,
        cacheHit: false,
        requestProfileId: requestProfile.id,
        workflowId: workflow.id,
        discoveredCharacterCount: discoveredGraph.characters.length,
        discoveredRelationCount: discoveredGraph.relations.length,
      },
    };
    const row = await insertProviderJob(client, {
      userId: workflow.user_id,
      bookId: workflow.book_id,
      jobType: 'character_graph_merge',
      providerId: workflow.provider_id,
      modelId: workflow.model_id,
      inputHash,
      progress,
    });
    const pinnedJob = providerJob(workflow, {
      id: row.id,
      jobType: 'character_graph_merge',
      inputHash,
      status: row.status,
      progress,
    });
    await pinCharacterGraphMergeInput(client, {
      workflow,
      job: pinnedJob,
      providerOptions,
      requestProfile,
      discoveredGraph,
      sourceContext,
      sourceChapterIds,
    });
    await linkWorkflowJob(client, {
      workflowId: workflow.id,
      providerJobId: row.id,
      stage: 'character_graph_merge',
      planItemId: 'character_graph_merge',
      sequence: 0,
    });
    await updateWorkflowProgress(client, workflow, {
      stage: 'merging_graph',
      progress: {
        graphMergeJobId: row.id,
        graphMergeStatus: row.status,
        discoveredCharacterCount: discoveredGraph.characters.length,
        discoveredRelationCount: discoveredGraph.relations.length,
      },
    });
    return row;
  });
  return maybeEnqueueProviderJob(pool, config, queue, created);
}

export async function enqueueChapterLabelingJobs(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  workflow: BookAIWorkflowRow,
  plan: BookAIWorkflowPlan,
  mergeLink: WorkflowProviderJobLinkRow,
  targetWindows: readonly BookAIWorkflowPlan['labelingWindows'][number][] = plan.labelingWindows,
): Promise<boolean> {
  const providerOptions = await providerOptionsForPreviousJob(pool, workflow, mergeLink);
  const compactSpeakerAttribution =
    providerOptions.compactSpeakerAttributionV3 === true ||
    providerOptions.requestProfileId === compactSpeakerAttributionRequestProfile.id;
  const queuedJobs = await withBookAITransaction(pool, async (client) => {
    const jobs: Array<{
      providerJobId: string;
      chapterId: string;
      labelingWindowId: string;
      paragraphCount: number;
      status: ProviderJobStatus;
      sequence: number;
    }> = [];
    for (const window of targetWindows) {
      const state = await lockBookRevisionState(client, workflow.user_id, workflow.book_id);
      if (!state) throw new Error(`Book not found for workflow: ${workflow.book_id}`);
      const seedJob = providerJob(workflow, {
        id: `label_seed:${window.id}`,
        chapterId: window.chapterId,
        jobType: 'chapter_segment_labeling',
        inputHash: window.textHashFingerprint,
        status: 'queued',
        progress: {},
      });
      const chapter = await loadChapter(client, seedJob);
      const paragraphs = (await loadParagraphs(client, chapter.id, window.paragraphIds)).map(pinParagraphText);
      const corrections = await loadPinnedCorrections(client, state, chapter.id);
      const previousContext = await loadPreviousWorkflowEpisodeContext(client, {
        workflowId: workflow.id,
        bookId: workflow.book_id,
        chapterId: chapter.id,
        chapterIndex: chapter.index,
        windowSequence: window.sequence,
      });
      const chapterPlan = plan.labelingChapters.find((item) => item.chapterId === window.chapterId);
      const coversFullChapter = (chapterPlan?.windows.length ?? 1) === 1;
      if (compactSpeakerAttribution) {
        const allChapterParagraphs = (await loadParagraphs(client, chapter.id, [])).map(pinParagraphText);
        const graphKnowledge = await loadCharacterGraphKnowledgeV2(client, workflow.book_id, state.graphSnapshot);
        const sourceSnapshot = await materializeHostedSpeakerAttributionInput(client, {
          userId: workflow.user_id,
          bookId: workflow.book_id,
          contentRevisionId: state.contentRevisionId,
          normalizedTextHash: state.normalizedTextHash,
          graphRevision: state.graphRevisionId ?? state.graphFingerprint,
          correctionCursor: corrections.fingerprint,
          chapter,
          paragraphs,
          allChapterParagraphs,
          graph: state.graphSnapshot,
          graphKnowledge,
          previousEpisodeContext: previousContext,
          userCorrections: corrections.corrections,
          window,
          providerId: workflow.provider_id,
          modelId: workflow.model_id ?? 'mock-speaker-v1',
          providerOptions,
          coversFullChapter,
          finalWindowForChapter: chapterPlan?.windows.at(-1)?.id === window.id,
        });
        const inputHash = providerRequestIntegrityHash({
          bookId: workflow.book_id,
          chapterId: window.chapterId,
          jobType: 'speaker_attribution_v3',
          providerId: workflow.provider_id,
          modelId: workflow.model_id,
          requestProfileId: compactSpeakerAttributionRequestProfile.id,
          promptVersion: compactSpeakerAttributionRequestProfile.promptVersion,
          schemaVersion: compactSpeakerAttributionRequestProfile.schemaVersion,
          planHash: workflow.plan_hash,
          contentRevisionId: state.contentRevisionId,
          revisionFence: state.revisionFence,
          characterGraphRevisionId: state.graphRevisionId,
          characterGraphFingerprint: state.graphFingerprint,
          correctionFingerprint: corrections.fingerprint,
          labelingWindowId: window.id,
          paragraphIds: window.paragraphIds,
          paragraphTextHashes: paragraphs.map((paragraph) => paragraph.textHash),
          sourceManifestFingerprint: sourceSnapshot.sourceManifestFingerprint,
          spanInventoryHash: sourceSnapshot.spanInventoryHash,
          mentionInventoryHash: sourceSnapshot.mentionInventoryHash,
          candidateMemoryHash: sourceSnapshot.candidateMemoryHash,
          temporalSnapshotHash: sourceSnapshot.temporalSnapshotHash,
          packetFingerprints: sourceSnapshot.units.map((unit) => unit.packet.fingerprint),
          previousEpisodeContextHash: previousContext ? providerSourceContextIntegrityHash(previousContext) : undefined,
          providerOptionsFingerprint: providerOptionsIntegrityHash(providerOptions),
        });
        const progress = {
          providerOptions,
          sourceContext: {
            workflowId: workflow.id,
            workflowStage: 'chapter_labeling',
            graphMergeJobId: mergeLink.provider_job_id,
            chapterId: window.chapterId,
            planWindowId: window.id,
            labelingWindowId: window.id,
            paragraphIds: [...window.paragraphIds],
            coversFullChapter,
            finalWindowForChapter: sourceSnapshot.finalWindowForChapter,
            labelingContract: sourceSnapshot.contract,
          },
          budgetEstimate: {
            providerId: workflow.provider_id,
            modelId: workflow.model_id ?? undefined,
            inputCharacters: window.characterCount,
            outputTokens: sourceSnapshot.units.reduce((total, unit) => total + unit.outputBudget.requestedOutputCap, 0),
            cacheHit: false,
            requestProfileId: compactSpeakerAttributionRequestProfile.id,
            workflowId: workflow.id,
            planItemId: window.id,
            paragraphCount: window.paragraphIds.length || Number(chapter.paragraphCount),
            sceneRequestCount: sourceSnapshot.units.length,
            targetSpanCount: sourceSnapshot.units.reduce((total, unit) => total + unit.packet.targets.length, 0),
          },
        };
        const row = await insertProviderJob(client, {
          userId: workflow.user_id,
          bookId: workflow.book_id,
          chapterId: window.chapterId,
          jobType: 'speaker_attribution_v3',
          providerId: workflow.provider_id,
          modelId: workflow.model_id,
          inputHash,
          progress,
        });
        const pinnedJob = providerJob(workflow, {
          id: row.id,
          chapterId: window.chapterId,
          jobType: 'speaker_attribution_v3',
          inputHash,
          status: row.status,
          progress,
        });
        await pinSpeakerAttributionInput(client, {
          workflow,
          job: pinnedJob,
          window,
          providerOptions,
          requestProfile: compactSpeakerAttributionRequestProfile,
          sourceSnapshot,
          previousEpisodeContext: previousContext,
        });
        await linkWorkflowJob(client, {
          workflowId: workflow.id,
          providerJobId: row.id,
          stage: 'chapter_labeling',
          planItemId: window.id,
          sequence: window.sequence,
        });
        jobs.push({
          providerJobId: row.id,
          chapterId: window.chapterId,
          labelingWindowId: window.id,
          paragraphCount: window.paragraphIds.length || Number(chapter.paragraphCount),
          status: row.status,
          sequence: window.sequence,
        });
        continue;
      }
      const requestProfile = resolveChapterLabelingRequestProfile(providerOptions);
      const haloParagraphs = (
        await loadParagraphContextHalo(
          client,
          chapter.id,
          window.startParagraphIndex,
          window.endParagraphIndex,
          contextHaloRadius(providerOptions),
        )
      ).map(pinParagraphText);
      const contextPacket = buildLabelingContextPacket({
        novelId: workflow.book_id,
        chapterId: chapter.id,
        targetParagraphs: paragraphs,
        haloParagraphs,
        characterGraph: state.graphSnapshot,
        characterGraphKnowledge: await loadCharacterGraphKnowledgeV2(client, workflow.book_id, state.graphSnapshot),
        chapterIndex: chapter.index,
        previousEpisodeContext: previousContext,
        corrections: corrections.corrections,
        providerId: workflow.provider_id,
        modelId: workflow.model_id ?? undefined,
        providerOptions,
        schemaCharacters: JSON.stringify(requestProfile.responseSchema).length,
      });
      assertLabelingContextPacketAdmitted(contextPacket);
      const contextPacketHash = providerSourceContextIntegrityHash(contextPacket);
      const inputHash = providerRequestIntegrityHash({
        bookId: workflow.book_id,
        chapterId: window.chapterId,
        jobType: 'chapter_segment_labeling',
        providerId: workflow.provider_id,
        modelId: workflow.model_id,
        requestProfileId: requestProfile.id,
        promptVersion: requestProfile.promptVersion,
        schemaVersion: requestProfile.schemaVersion,
        planHash: workflow.plan_hash,
        contentRevisionId: state.contentRevisionId,
        revisionFence: state.revisionFence,
        characterGraphRevisionId: state.graphRevisionId,
        characterGraphFingerprint: state.graphFingerprint,
        correctionFingerprint: corrections.fingerprint,
        labelingWindowId: window.id,
        paragraphIds: window.paragraphIds,
        paragraphTextHashes: paragraphs.map((paragraph) => paragraph.textHash),
        windowTextHashFingerprint: window.textHashFingerprint,
        chapterTextHash: chapter.textHash,
        graphMergeJobId: mergeLink.provider_job_id,
        graphMergeInputHash: mergeLink.input_hash,
        previousEpisodeContextHash: previousContext ? providerSourceContextIntegrityHash(previousContext) : undefined,
        labelingContextPacketHash: contextPacketHash,
        providerOptionsFingerprint: providerOptionsIntegrityHash(providerOptions),
      });
      const progress = {
        providerOptions,
        sourceContext: {
          workflowId: workflow.id,
          workflowStage: 'chapter_labeling',
          graphMergeJobId: mergeLink.provider_job_id,
          chapterId: window.chapterId,
          planWindowId: window.id,
          labelingWindowId: window.id,
          paragraphIds: [...window.paragraphIds],
          startParagraphIndex: window.startParagraphIndex,
          endParagraphIndex: window.endParagraphIndex,
          coversFullChapter,
          finalWindowForChapter: chapterPlan?.windows.at(-1)?.id === window.id,
        },
        budgetEstimate: {
          providerId: workflow.provider_id,
          modelId: workflow.model_id ?? undefined,
          inputCharacters: window.characterCount,
          cacheHit: false,
          requestProfileId: requestProfile.id,
          workflowId: workflow.id,
          graphMergeJobId: mergeLink.provider_job_id,
          planItemId: window.id,
          labelingWindowId: window.id,
          paragraphCount: window.paragraphIds.length || Number(chapter.paragraphCount),
          contextWindowTokens: contextPacket.capability.contextWindowTokens,
          availableInputTokens: contextPacket.capability.availableInputTokens,
          estimatedInputTokens: contextPacket.budget.estimatedInputTokens,
          reservedOutputTokens: contextPacket.budget.reservedOutputTokens,
          tokenCountMode: contextPacket.capability.tokenCountMode,
          contextPacketHash,
        },
      };
      const row = await insertProviderJob(client, {
        userId: workflow.user_id,
        bookId: workflow.book_id,
        chapterId: window.chapterId,
        jobType: 'chapter_segment_labeling',
        providerId: workflow.provider_id,
        modelId: workflow.model_id,
        inputHash,
        progress,
      });
      const pinnedJob = providerJob(workflow, {
        id: row.id,
        chapterId: window.chapterId,
        jobType: 'chapter_segment_labeling',
        inputHash,
        status: row.status,
        progress,
      });
      await pinChapterLabelingInput(client, {
        workflow,
        job: pinnedJob,
        plan,
        window,
        providerOptions,
        requestProfile,
        contextPacket,
      });
      await linkWorkflowJob(client, {
        workflowId: workflow.id,
        providerJobId: row.id,
        stage: 'chapter_labeling',
        planItemId: window.id,
        sequence: window.sequence,
      });
      jobs.push({
        providerJobId: row.id,
        chapterId: window.chapterId,
        labelingWindowId: window.id,
        paragraphCount: window.paragraphIds.length || Number(chapter.paragraphCount),
        status: row.status,
        sequence: window.sequence,
      });
    }
    await updateWorkflowProgress(client, workflow, {
      stage: 'labeling_chapters',
      progress: {
        totalLabelingChapters: plan.labelingChapters.length,
        totalLabelingWindows: plan.labelingWindows.length,
        queuedLabelingJobs: jobs.filter((job) => job.status === 'queued').length,
        queuedLabelingWindowIds: jobs.map((job) => job.labelingWindowId),
        labelingJobs: jobs,
      },
    });
    return jobs;
  });
  for (const job of queuedJobs) {
    if (!(await maybeEnqueueProviderJob(pool, config, queue, { id: job.providerJobId, status: job.status }))) {
      return false;
    }
  }
  return true;
}

export async function enqueueChapterLabelRepairJob(
  pool: pg.Pool,
  config: ServerConfig,
  queue: Queue | undefined,
  workflow: BookAIWorkflowRow,
  parentLink: WorkflowProviderJobLinkRow,
): Promise<boolean> {
  const created = await withBookAITransaction(pool, async (client) => {
    const parentRevision = await loadAnalysisInputRevisionForJob(client, parentLink.provider_job_id);
    if (!parentRevision || parentRevision.sourceSnapshot.kind !== 'chapter_labeling') {
      throw new Error(`Repair parent revision is missing: ${parentLink.provider_job_id}`);
    }
    const parentJob = providerJob(workflow, {
      id: parentLink.provider_job_id,
      chapterId: parentRevision.chapterId,
      jobType: parentLink.job_type,
      inputHash: parentLink.input_hash,
      status: parentLink.status,
      progress: recordValue(parentLink.progress) ?? {},
    });
    await verifyAnalysisInputBeforeExecution(client, parentJob, parentRevision, { lock: true });
    const parentProgress = recordValue(parentLink.progress);
    const autoRepair = recordValue(parentProgress?.autoRepair);
    const candidateArtifactId =
      typeof autoRepair?.candidateArtifactId === 'string' ? autoRepair.candidateArtifactId : undefined;
    const repairInputFingerprint =
      typeof autoRepair?.repairInputFingerprint === 'string' ? autoRepair.repairInputFingerprint : undefined;
    if (autoRepair?.enabled !== true || !candidateArtifactId || !repairInputFingerprint) {
      throw new Error(`Provider job has no repairable candidate: ${parentLink.provider_job_id}`);
    }
    const candidateArtifact = await loadAnalysisArtifact(client, candidateArtifactId, true);
    if (
      !candidateArtifact ||
      candidateArtifact.status !== 'staged' ||
      candidateArtifact.inputRevisionId !== parentRevision.id ||
      candidateArtifact.providerJobId !== parentLink.provider_job_id ||
      candidateArtifact.artifactType !== 'chapter_labels'
    ) {
      throw new Error(`Repair candidate artifact is stale: ${candidateArtifactId}`);
    }
    const repairIssues = repairIssuesFromArtifact(candidateArtifact.metadata.repairIssues);
    const requestProfile = resolveChapterLabelRepairRequestProfile({
      ...parentRevision.providerOptions,
      repairRequestProfileId: parentRevision.sourceSnapshot.repairRequestProfile?.id,
    });
    assertPinnedRepairRequestProfile(parentRevision, requestProfile);
    const labelingWindowId = parentRevision.windowSpec.windowId;
    const inputHash = providerRequestIntegrityHash({
      bookId: workflow.book_id,
      chapterId: parentRevision.chapterId,
      jobType: 'chapter_label_repair',
      providerId: parentRevision.providerId,
      modelId: parentRevision.modelId,
      parentProviderJobId: parentLink.provider_job_id,
      parentInputRevisionId: parentRevision.id,
      candidateArtifactId: candidateArtifact.id,
      candidateOutputHash: candidateArtifact.outputHash,
      repairInputFingerprint,
      repairIssues,
      requestProfile,
      contentRevisionId: parentRevision.contentRevisionId,
      revisionFence: parentRevision.revisionFence,
      characterGraphRevisionId: parentRevision.characterGraphRevisionId,
      characterGraphFingerprint: parentRevision.characterGraphFingerprint,
      correctionFingerprint: parentRevision.correctionFingerprint,
      providerOptionsFingerprint: parentRevision.providerOptionsFingerprint,
      windowSpec: parentRevision.windowSpec,
    });
    const progress = {
      providerOptions: parentRevision.providerOptions,
      sourceContext: {
        workflowId: workflow.id,
        workflowStage: 'chapter_label_repair',
        labelingWindowId,
        chapterId: parentRevision.chapterId,
        paragraphIds: parentRevision.windowSpec.paragraphAnchors.map((anchor) => anchor.paragraphId),
        parentProviderJobId: parentLink.provider_job_id,
        parentInputRevisionId: parentRevision.id,
        candidateArtifactId: candidateArtifact.id,
      },
      repairInputFingerprint,
      candidateOutputHash: candidateArtifact.outputHash,
      requestProfileId: requestProfile.id,
    };
    const row = await insertProviderJob(client, {
      userId: workflow.user_id,
      bookId: workflow.book_id,
      chapterId: parentRevision.chapterId,
      jobType: 'chapter_label_repair',
      providerId: workflow.provider_id,
      modelId: workflow.model_id,
      inputHash,
      progress,
    });
    const childJob = providerJob(workflow, {
      id: row.id,
      chapterId: parentRevision.chapterId,
      jobType: 'chapter_label_repair',
      inputHash,
      status: row.status,
      progress,
    });
    const childRevision = await pinChapterLabelRepairInput(client, {
      parentRevision,
      job: childJob,
      candidateArtifact,
      repairInputFingerprint,
      repairIssues,
      requestProfile,
    });
    await linkWorkflowJob(client, {
      workflowId: workflow.id,
      providerJobId: row.id,
      stage: 'chapter_label_repair',
      planItemId: `repair:${labelingWindowId}:${candidateArtifact.id}`,
      sequence: parentLink.sequence,
    });
    await updateWorkflowProgress(client, workflow, {
      stage: 'labeling_chapters',
      progress: {
        repairChildJobId: row.id,
        repairInputRevisionId: childRevision.id,
        repairParentJobId: parentLink.provider_job_id,
        repairCandidateArtifactId: candidateArtifact.id,
        repairLabelingWindowId: labelingWindowId,
      },
    });
    return row;
  });
  return maybeEnqueueProviderJob(pool, config, queue, created);
}
