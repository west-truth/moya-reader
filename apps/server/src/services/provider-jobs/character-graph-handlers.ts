import pg from 'pg';
import { providerJobCharacterBundleId } from '@noveldesk/text-core/identity/ai';
import type { ServerConfig } from '../../config.js';
import { createServerAIProvider } from '../../providers/server-ai-provider-factory.js';
import { resolveProviderSecrets } from '../../providers/server-provider-secrets.js';
import { resolveCharacterBundleAnalysisRequestProfile } from '../../../../../src/providers/character-bundle-request-profile';
import { resolveCharacterGraphMergeRequestProfile } from '../../../../../src/providers/character-graph-request-profile';
import { normalizeCharacterGraphSnapshot } from '../../../../../src/providers/character-graph-snapshot';
import type {
  AnalyzeCharacterBundleInput,
  CharacterGraph,
  MergeCharacterGraphInput,
} from '../../../../../src/providers/ai';
import type { ProviderJobRow, ProviderJobServiceDeps } from './contracts.js';
import { AnalysisInputStaleError, type AnalysisInputRevision } from '../book-ai-workflow/analysis-input-contracts.js';
import {
  assertPinnedRequestProfile,
  verifyAnalysisInputBeforeExecution,
} from '../book-ai-workflow/analysis-input-verification.js';
import { loadBundleChapters, loadCharacterGraph, loadRecentCorrections } from './job-data-loader.js';
import { assertProviderJobNotCancelled, updateProviderJobProgress } from './job-lifecycle.js';
import { providerOptionsFromJobProgress, recordValue, stringArrayValue } from './job-progress.js';
import { persistCharacterBundleAnalysisResult, persistCharacterGraphMergeResult } from './result-persistence.js';
import { takeProviderExecutionMetadata } from '../../../../../src/providers/provider-execution';

function discoveredGraphFromJobProgress(progress: unknown, bookId: string): CharacterGraph {
  return normalizeCharacterGraphSnapshot(recordValue(progress)?.discoveredGraph, bookId);
}

function sourceContextFromJobProgress(progress: unknown): MergeCharacterGraphInput['sourceContext'] | undefined {
  const source = recordValue(recordValue(progress)?.sourceContext);
  if (!source) return undefined;
  const context: MergeCharacterGraphInput['sourceContext'] = {};
  if (typeof source.bundleId === 'string' && source.bundleId.trim()) context.bundleId = source.bundleId.trim();
  const chapterIds = stringArrayValue(source.chapterIds);
  if (chapterIds.length) context.chapterIds = chapterIds;
  if (typeof source.summary === 'string' && source.summary.trim()) context.summary = source.summary.trim();
  return Object.keys(context).length ? context : undefined;
}

function bundleSourceContextFromJobProgress(
  progress: unknown,
): AnalyzeCharacterBundleInput['previousBundleSummary'] | undefined {
  const source = recordValue(recordValue(progress)?.sourceContext);
  const summary = source?.summary;
  return typeof summary === 'string' && summary.trim() ? summary.trim() : undefined;
}

function bundleIdFromJobProgress(progress: unknown, bookId: string, jobId: string): string {
  const source = recordValue(recordValue(progress)?.sourceContext);
  const bundleId = source?.bundleId;
  return typeof bundleId === 'string' && bundleId.trim()
    ? bundleId.trim()
    : providerJobCharacterBundleId(bookId, jobId);
}

function bundleChapterIdsFromJobProgress(progress: unknown): string[] {
  const source = recordValue(recordValue(progress)?.sourceContext);
  return stringArrayValue(source?.chapterIds);
}

function preserveConfirmedCharacterMetadata(graph: CharacterGraph, existingGraph: CharacterGraph): CharacterGraph {
  const confirmedById = new Map(
    existingGraph.characters
      .filter((character) => character.isUserConfirmed)
      .map((character) => [character.id, character]),
  );
  return {
    ...graph,
    characters: graph.characters.map((character) => {
      const confirmed = confirmedById.get(character.id);
      if (!confirmed) return { ...character, isUserConfirmed: false };
      return {
        ...confirmed,
        confidence: Math.max(confirmed.confidence, character.confidence),
        isUserConfirmed: true,
      };
    }),
  };
}

export async function processCharacterBundleAnalysisJob(
  pool: pg.Pool,
  config: ServerConfig,
  job: ProviderJobRow,
  deps: ProviderJobServiceDeps,
  signal?: AbortSignal,
  inputRevision?: AnalysisInputRevision,
): Promise<void> {
  const jobProviderOptions = inputRevision
    ? { ...inputRevision.providerOptions }
    : providerOptionsFromJobProgress(job.progress);
  const requestProfile = resolveCharacterBundleAnalysisRequestProfile(jobProviderOptions);
  if (inputRevision) assertPinnedRequestProfile(inputRevision, requestProfile);
  const pinnedSource =
    inputRevision?.sourceSnapshot.kind === 'character_bundle' ? inputRevision.sourceSnapshot : undefined;
  if (inputRevision && !pinnedSource) {
    throw new AnalysisInputStaleError('analysis_source_stale', `Pinned character bundle source is invalid: ${job.id}`);
  }
  const bundleId = pinnedSource?.bundleId ?? bundleIdFromJobProgress(job.progress, job.book_id, job.id);
  const sourceChapterIds =
    pinnedSource?.chapters.map((item) => item.chapter.id) ?? bundleChapterIdsFromJobProgress(job.progress);
  const previousBundleSummary = pinnedSource?.previousBundleSummary ?? bundleSourceContextFromJobProgress(job.progress);
  const [bundleChapters, existingGraph, userCorrections] =
    inputRevision && pinnedSource
      ? [
          pinnedSource.chapters.map((item) => ({
            chapter: { ...item.chapter },
            paragraphs: item.paragraphs.map((paragraph) => ({ ...paragraph })),
          })),
          inputRevision.graphSnapshot,
          [...inputRevision.correctionsSnapshot],
        ]
      : await Promise.all([
          loadBundleChapters(pool, job, sourceChapterIds),
          loadCharacterGraph(pool, job),
          loadRecentCorrections(pool, job),
        ]);
  const inputCharacters = bundleChapters.reduce(
    (sum, chapter) => sum + chapter.paragraphs.reduce((chapterSum, paragraph) => chapterSum + paragraph.text.length, 0),
    0,
  );
  await updateProviderJobProgress(pool, job, {
    stage: 'analyzing_bundle',
    progress: {
      ...recordValue(job.progress),
      bundleId,
      sourceChapterIds,
      chapterCount: bundleChapters.length,
      paragraphCount: bundleChapters.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0),
      inputCharacters,
      existingCharacterCount: existingGraph.characters.length,
      existingRelationCount: existingGraph.relations.length,
      correctionCount: userCorrections.length,
      requestProfileId: requestProfile.id,
    },
  });
  await assertProviderJobNotCancelled(pool, job);
  const provider =
    deps.createAIProvider?.({
      providerId: job.provider_id,
      modelId: job.model_id,
      providerOptions: jobProviderOptions,
    }) ??
    createServerAIProvider({
      providerId: job.provider_id,
      modelId: job.model_id,
      providerOptions: jobProviderOptions,
      secrets: await resolveProviderSecrets(pool, config, 'llm_labeling', job.provider_id),
    });
  if (!provider.analyzeCharacterBundle) {
    throw new Error(`Provider does not support character bundle analysis: ${job.provider_id}`);
  }
  if (inputRevision) {
    assertPinnedRequestProfile(inputRevision, requestProfile);
    await verifyAnalysisInputBeforeExecution(pool, job, inputRevision);
  }
  await deps.beforeProviderDispatch?.();
  const result = await provider.analyzeCharacterBundle({
    novelId: job.book_id,
    bundleId,
    chapters: bundleChapters,
    existingGraph,
    previousBundleSummary,
    userCorrections,
    signal,
  });
  const providerExecution = takeProviderExecutionMetadata(provider);
  await assertProviderJobNotCancelled(pool, job);
  const discoveredGraph = normalizeCharacterGraphSnapshot(result.discoveredGraph, job.book_id);
  await updateProviderJobProgress(pool, job, {
    stage: 'writing_results',
    progress: {
      ...recordValue(job.progress),
      bundleId: result.bundleId,
      sourceChapterIds: result.sourceChapterIds,
      chapterCount: bundleChapters.length,
      paragraphCount: bundleChapters.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0),
      inputCharacters,
      discoveredCharacterCount: discoveredGraph.characters.length,
      discoveredRelationCount: discoveredGraph.relations.length,
      bundleSummaryForNext: result.bundleSummaryForNext,
      requestProfileId: requestProfile.id,
      providerExecution,
    },
  });
  await assertProviderJobNotCancelled(pool, job);
  await persistCharacterBundleAnalysisResult(
    pool,
    job,
    { ...result, discoveredGraph },
    requestProfile,
    {
      chapterCount: bundleChapters.length,
      paragraphCount: bundleChapters.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0),
      inputCharacters,
      existingCharacterCount: existingGraph.characters.length,
      existingRelationCount: existingGraph.relations.length,
      correctionCount: userCorrections.length,
      providerExecution,
    },
    inputRevision,
  );
}

export async function processCharacterGraphMergeJob(
  pool: pg.Pool,
  config: ServerConfig,
  job: ProviderJobRow,
  deps: ProviderJobServiceDeps,
  signal?: AbortSignal,
  inputRevision?: AnalysisInputRevision,
): Promise<void> {
  const jobProviderOptions = inputRevision
    ? { ...inputRevision.providerOptions }
    : providerOptionsFromJobProgress(job.progress);
  const requestProfile = resolveCharacterGraphMergeRequestProfile(jobProviderOptions);
  if (inputRevision) assertPinnedRequestProfile(inputRevision, requestProfile);
  const pinnedSource =
    inputRevision?.sourceSnapshot.kind === 'character_graph_merge' ? inputRevision.sourceSnapshot : undefined;
  if (inputRevision && !pinnedSource) {
    throw new AnalysisInputStaleError('analysis_source_stale', `Pinned graph merge source is invalid: ${job.id}`);
  }
  const discoveredGraph = pinnedSource?.discoveredGraph ?? discoveredGraphFromJobProgress(job.progress, job.book_id);
  const sourceContext = pinnedSource?.sourceContext ?? sourceContextFromJobProgress(job.progress);
  const [existingGraph, userCorrections] = inputRevision
    ? [inputRevision.graphSnapshot, [...inputRevision.correctionsSnapshot]]
    : await Promise.all([loadCharacterGraph(pool, job), loadRecentCorrections(pool, job)]);
  await updateProviderJobProgress(pool, job, {
    stage: 'merging_graph',
    progress: {
      ...recordValue(job.progress),
      existingCharacterCount: existingGraph.characters.length,
      existingRelationCount: existingGraph.relations.length,
      discoveredCharacterCount: discoveredGraph.characters.length,
      discoveredRelationCount: discoveredGraph.relations.length,
      correctionCount: userCorrections.length,
      requestProfileId: requestProfile.id,
    },
  });
  await assertProviderJobNotCancelled(pool, job);
  const provider =
    deps.createAIProvider?.({
      providerId: job.provider_id,
      modelId: job.model_id,
      providerOptions: jobProviderOptions,
    }) ??
    createServerAIProvider({
      providerId: job.provider_id,
      modelId: job.model_id,
      providerOptions: jobProviderOptions,
      secrets: await resolveProviderSecrets(pool, config, 'llm_labeling', job.provider_id),
    });
  if (!provider.mergeCharacterGraph) {
    throw new Error(`Provider does not support character graph merge: ${job.provider_id}`);
  }
  if (inputRevision) {
    assertPinnedRequestProfile(inputRevision, requestProfile);
    await verifyAnalysisInputBeforeExecution(pool, job, inputRevision);
  }
  await deps.beforeProviderDispatch?.();
  const merged = await provider.mergeCharacterGraph({
    novelId: job.book_id,
    existingGraph,
    discoveredGraph,
    sourceContext,
    userCorrections,
    signal,
  });
  const providerExecution = takeProviderExecutionMetadata(provider);
  await assertProviderJobNotCancelled(pool, job);
  const result = preserveConfirmedCharacterMetadata(
    normalizeCharacterGraphSnapshot(merged, job.book_id),
    existingGraph,
  );
  await updateProviderJobProgress(pool, job, {
    stage: 'writing_results',
    progress: {
      ...recordValue(job.progress),
      existingCharacterCount: existingGraph.characters.length,
      existingRelationCount: existingGraph.relations.length,
      discoveredCharacterCount: discoveredGraph.characters.length,
      discoveredRelationCount: discoveredGraph.relations.length,
      characterCount: result.characters.length,
      relationCount: result.relations.length,
      correctionCount: userCorrections.length,
      requestProfileId: requestProfile.id,
      providerExecution,
    },
  });
  await assertProviderJobNotCancelled(pool, job);
  await persistCharacterGraphMergeResult(
    pool,
    job,
    result,
    requestProfile,
    {
      existingCharacterCount: existingGraph.characters.length,
      existingRelationCount: existingGraph.relations.length,
      discoveredCharacterCount: discoveredGraph.characters.length,
      discoveredRelationCount: discoveredGraph.relations.length,
      correctionCount: userCorrections.length,
      providerExecution,
    },
    inputRevision,
  );
}
