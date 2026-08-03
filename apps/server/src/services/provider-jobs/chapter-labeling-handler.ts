import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { createServerAIProvider } from '../../providers/server-ai-provider-factory.js';
import { resolveProviderSecrets } from '../../providers/server-provider-secrets.js';
import { resolveChapterLabelRepairRequestProfile } from '../../../../../src/providers/chapter-label-repair-request-profile';
import { resolveChapterLabelingRequestProfile } from '../../../../../src/providers/chapter-labeling-request-profile';
import type { Chapter, Paragraph, UserCorrection } from '@noveldesk/contracts';
import type {
  CharacterGraph,
  ChapterLabelingPreviousContext,
  ChapterLabelingResult,
} from '../../../../../src/providers/ai';
import {
  assertLabelingContextPacketAdmitted,
  buildLabelingContextPacket,
  type LabelingContextPacketV2,
} from '../../../../../src/providers/labeling-context-packet';
import {
  chapterLabelingValidationErrorMessage,
  type ChapterLabelingValidationIssue,
  type ChapterLabelingValidationReport,
  validateChapterLabelingResult,
} from '../../../../../src/providers/chapter-labeling-validator';
import {
  chapterLabelingQualityErrorMessage,
  type ChapterLabelingQualityIssue,
  type ChapterLabelingQualityReport,
  validateChapterLabelingQuality,
} from '../../../../../src/providers/chapter-labeling-quality';
import { ChapterLabelingValidationError, type ProviderJobRow, type ProviderJobServiceDeps } from './contracts.js';
import { AnalysisInputStaleError, type AnalysisInputRevision } from '../book-ai-workflow/analysis-input-contracts.js';
import {
  assertPinnedRepairRequestProfile,
  assertPinnedRequestProfile,
  verifyAnalysisInputBeforeExecution,
} from '../book-ai-workflow/analysis-input-verification.js';
import {
  labelingWindowCoversFullChapter,
  labelingWindowParagraphIdsFromJob,
  loadChapter,
  loadCharacterGraph,
  loadParagraphContextHalo,
  loadParagraphs,
  loadPreviousEpisodeContext,
  loadRecentCorrections,
  loadStoredSegments,
} from './job-data-loader.js';
import { assertProviderJobNotCancelled, updateProviderJobProgress } from './job-lifecycle.js';
import { booleanProviderOption, providerOptionsFromJobProgress, recordValue } from './job-progress.js';
import { persistChapterLabelingResult } from './result-persistence.js';
import { takeProviderExecutionMetadata } from '../../../../../src/providers/provider-execution';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { chapterLabelRepairIssueId } from '../../../../../src/providers/chapter-label-repair-v2-contract';
import { loadAnalysisArtifact, stageAnalysisArtifact } from '../book-ai-workflow/staging-artifact-repository.js';
import { loadAnalysisInputRevisionForJob } from '../book-ai-workflow/analysis-input-repository.js';
import { withBookAITransaction } from '../book-ai-workflow/transaction.js';
import {
  analysisReviewStatusForStagingArtifact,
  ensureChapterLabelAnalysisReview,
} from '../book-ai-workflow/analysis-review-repository.js';
import { loadCharacterGraphKnowledgeV2 } from '../character-graph-v2-service.js';

function validationPolicyForJob(job: ProviderJobRow, policy: 'legacy' | 'strict_tts'): 'legacy' | 'strict_tts' {
  return job.provider_id === 'mock' ? 'legacy' : policy;
}

async function labelingContextPacketForJob(input: {
  readonly pool: pg.Pool;
  readonly job: ProviderJobRow;
  readonly chapter: Chapter;
  readonly paragraphs: readonly Paragraph[];
  readonly characterGraph: CharacterGraph;
  readonly previousEpisodeContext?: ChapterLabelingPreviousContext;
  readonly userCorrections: readonly UserCorrection[];
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly responseSchema?: unknown;
  readonly pinned?: LabelingContextPacketV2;
}): Promise<LabelingContextPacketV2> {
  if (input.pinned) return input.pinned;
  const firstIndex = input.paragraphs.at(0)?.index ?? 0;
  const lastIndex = input.paragraphs.at(-1)?.index ?? firstIndex;
  const radiusValue = input.providerOptions.contextHaloParagraphs;
  const parsedRadius =
    typeof radiusValue === 'number' ? radiusValue : typeof radiusValue === 'string' ? Number(radiusValue) : 2;
  const radius = Number.isFinite(parsedRadius) ? Math.min(8, Math.max(0, Math.floor(parsedRadius))) : 2;
  const haloParagraphs = await loadParagraphContextHalo(input.pool, input.chapter.id, firstIndex, lastIndex, radius);
  const characterGraphKnowledge = await loadCharacterGraphKnowledgeV2(
    input.pool,
    input.job.book_id,
    input.characterGraph,
  );
  const packet = buildLabelingContextPacket({
    novelId: input.job.book_id,
    chapterId: input.chapter.id,
    targetParagraphs: input.paragraphs,
    haloParagraphs,
    characterGraph: input.characterGraph,
    characterGraphKnowledge,
    chapterIndex: input.chapter.index,
    previousEpisodeContext: input.previousEpisodeContext,
    corrections: input.userCorrections,
    providerId: input.job.provider_id,
    modelId: input.job.model_id ?? undefined,
    providerOptions: input.providerOptions,
    schemaCharacters: input.responseSchema ? JSON.stringify(input.responseSchema).length : 0,
  });
  assertLabelingContextPacketAdmitted(packet);
  return packet;
}

function chapterLabelingFailureMessage(
  validation: ChapterLabelingValidationReport,
  quality: ChapterLabelingQualityReport,
): string {
  const messages: string[] = [];
  if (!validation.ok) messages.push(chapterLabelingValidationErrorMessage(validation));
  if (!quality.ok) messages.push(chapterLabelingQualityErrorMessage(quality));
  return messages.join(' ');
}

function qualityIssuesAsRepairIssues(issues: readonly ChapterLabelingQualityIssue[]): ChapterLabelingValidationIssue[] {
  return issues.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    paragraphId: issue.paragraphId,
  }));
}

async function processPinnedChapterLabelRepairJob(
  pool: pg.Pool,
  config: ServerConfig,
  job: ProviderJobRow,
  deps: ProviderJobServiceDeps,
  inputRevision: AnalysisInputRevision,
  signal?: AbortSignal,
): Promise<void> {
  const source = inputRevision.sourceSnapshot;
  if (job.job_type !== 'chapter_label_repair' || source.kind !== 'chapter_label_repair') {
    throw new AnalysisInputStaleError('analysis_source_stale', `Pinned repair source is invalid: ${job.id}`);
  }
  const parentRevision = await loadAnalysisInputRevisionForJob(pool, source.parentProviderJobId);
  if (!parentRevision || parentRevision.id !== source.parentInputRevisionId) {
    throw new AnalysisInputStaleError('analysis_source_stale', `Pinned repair parent is missing: ${job.id}`);
  }
  const candidateArtifact = await loadAnalysisArtifact(pool, source.candidateArtifactId);
  if (
    !candidateArtifact ||
    candidateArtifact.inputRevisionId !== source.parentInputRevisionId ||
    candidateArtifact.providerJobId !== source.parentProviderJobId ||
    candidateArtifact.outputHash !== source.candidateOutputHash ||
    candidateArtifact.artifactType !== 'chapter_labels' ||
    candidateArtifact.status !== 'staged' ||
    structuredIntegrityHash(candidateArtifact.payload) !== source.candidateOutputHash
  ) {
    throw new AnalysisInputStaleError('analysis_source_stale', `Pinned repair candidate is invalid: ${job.id}`);
  }

  const chapter = source.chapter;
  const paragraphs = [...source.paragraphs];
  const characterGraph = inputRevision.graphSnapshot;
  const knownCharacters = characterGraph.characters;
  const previousEpisodeContext = inputRevision.episodeContextSnapshot;
  const userCorrections = [...inputRevision.correctionsSnapshot];
  const existingResult = candidateArtifact.payload as ChapterLabelingResult;
  const reviewStatus = await analysisReviewStatusForStagingArtifact(pool, source.candidateArtifactId);
  if (reviewStatus && reviewStatus !== 'open') {
    throw new AnalysisInputStaleError(
      'analysis_review_changed',
      `Analysis review no longer allows automatic repair: ${reviewStatus}`,
    );
  }
  const providerOptions = { ...inputRevision.providerOptions };
  const requestProfile = resolveChapterLabelRepairRequestProfile({
    ...providerOptions,
    repairRequestProfileId: inputRevision.requestProfile.id,
  });
  assertPinnedRequestProfile(inputRevision, requestProfile);
  await verifyAnalysisInputBeforeExecution(pool, job, inputRevision);

  const inputValidation = validateChapterLabelingResult({
    novelId: job.book_id,
    chapter,
    paragraphs,
    knownCharacters,
    characterGraph,
    previousEpisodeContext,
    userCorrections,
    validationPolicy: validationPolicyForJob(job, requestProfile.validationPolicy),
    result: existingResult,
  });
  const inputQuality = validateChapterLabelingQuality({ chapter, paragraphs, result: existingResult });
  const runtimeProviderOptions = { ...providerOptions, repairRequestProfileId: requestProfile.id };
  const provider =
    deps.createAIProvider?.({
      providerId: job.provider_id,
      modelId: job.model_id,
      providerOptions: runtimeProviderOptions,
    }) ??
    createServerAIProvider({
      providerId: job.provider_id,
      modelId: job.model_id,
      providerOptions: runtimeProviderOptions,
      secrets: await resolveProviderSecrets(pool, config, 'llm_labeling', job.provider_id),
    });
  if (!provider.repairChapterLabels) {
    throw new Error(`Provider does not support chapter label repair: ${job.provider_id}`);
  }
  await updateProviderJobProgress(pool, job, {
    stage: 'repairing_labels',
    mergeProgress: {
      parentProviderJobId: source.parentProviderJobId,
      parentInputRevisionId: source.parentInputRevisionId,
      candidateArtifactId: source.candidateArtifactId,
      repairInputFingerprint: source.repairInputFingerprint,
      inputValidation: inputValidation.summary,
      inputQuality: inputQuality.summary,
    },
  });
  await assertProviderJobNotCancelled(pool, job);
  await deps.beforeProviderDispatch?.();
  const result = await provider.repairChapterLabels({
    novelId: job.book_id,
    chapter,
    paragraphs,
    windowId: inputRevision.windowSpec.windowId,
    inputRevisionId: inputRevision.id,
    knownCharacters,
    characterGraph,
    previousEpisodeContext,
    userCorrections,
    contextPacket: source.contextPacket,
    existingResult,
    validationIssues: [...source.repairIssues],
    baseArtifactId: source.candidateArtifactId,
    baseArtifactHash: source.candidateOutputHash,
    issueIds: source.repairIssues.map(chapterLabelRepairIssueId),
    signal,
  });
  const providerExecution = takeProviderExecutionMetadata(provider);
  await assertProviderJobNotCancelled(pool, job);
  await verifyAnalysisInputBeforeExecution(pool, job, inputRevision);
  const validation = validateChapterLabelingResult({
    novelId: job.book_id,
    chapter,
    paragraphs,
    knownCharacters,
    characterGraph,
    previousEpisodeContext,
    userCorrections,
    validationPolicy: validationPolicyForJob(job, requestProfile.validationPolicy),
    result,
  });
  const quality = validateChapterLabelingQuality({ chapter, paragraphs, result });
  await updateProviderJobProgress(pool, job, {
    stage: 'writing_results',
    mergeProgress: {
      validation: validation.summary,
      quality: quality.summary,
      providerExecution,
    },
  });
  if (!validation.ok || !quality.ok) {
    throw new ChapterLabelingValidationError(
      chapterLabelingFailureMessage(validation, quality),
      validation.summary,
      quality.summary,
    );
  }
  await persistChapterLabelingResult(
    pool,
    job,
    chapter,
    result,
    validation,
    requestProfile,
    {
      parentProviderJobId: source.parentProviderJobId,
      parentInputRevisionId: source.parentInputRevisionId,
      candidateArtifactId: source.candidateArtifactId,
      repairInputFingerprint: source.repairInputFingerprint,
      inputValidation: inputValidation.summary,
      inputQuality: inputQuality.summary,
      quality: quality.summary,
      paragraphIds: inputRevision.windowSpec.paragraphAnchors.map((anchor) => anchor.paragraphId),
      coversFullChapter: source.coversFullChapter,
      relationCount: characterGraph.relations.length,
      repaired: true,
      providerExecution,
    },
    inputRevision,
  );
}

export async function processChapterLabelingJob(
  pool: pg.Pool,
  config: ServerConfig,
  job: ProviderJobRow,
  deps: ProviderJobServiceDeps,
  signal?: AbortSignal,
  inputRevision?: AnalysisInputRevision,
): Promise<void> {
  if (inputRevision?.sourceSnapshot.kind === 'chapter_label_repair') {
    await processPinnedChapterLabelRepairJob(pool, config, job, deps, inputRevision, signal);
    return;
  }
  const pinnedSource =
    inputRevision?.sourceSnapshot.kind === 'chapter_labeling' ? inputRevision.sourceSnapshot : undefined;
  if (inputRevision && !pinnedSource) {
    throw new AnalysisInputStaleError('analysis_source_stale', `Pinned chapter source is invalid: ${job.id}`);
  }
  const chapter = pinnedSource?.chapter ?? (await loadChapter(pool, job));
  const labelingWindowParagraphIds = inputRevision
    ? inputRevision.windowSpec.paragraphAnchors.map((anchor) => anchor.paragraphId)
    : labelingWindowParagraphIdsFromJob(job);
  const labelingWindowCoversFullChapterValue = pinnedSource?.coversFullChapter ?? labelingWindowCoversFullChapter(job);
  const [paragraphs, characterGraph, previousEpisodeContext, userCorrections] =
    inputRevision && pinnedSource
      ? [
          [...pinnedSource.paragraphs],
          inputRevision.graphSnapshot,
          inputRevision.episodeContextSnapshot,
          [...inputRevision.correctionsSnapshot],
        ]
      : await Promise.all([
          loadParagraphs(pool, chapter.id, labelingWindowParagraphIds),
          loadCharacterGraph(pool, job),
          loadPreviousEpisodeContext(pool, job, chapter),
          loadRecentCorrections(pool, job),
        ]);
  const knownCharacters = characterGraph.characters;

  if (job.job_type === 'chapter_label_repair') {
    const jobProviderOptions = inputRevision
      ? { ...inputRevision.providerOptions }
      : providerOptionsFromJobProgress(job.progress);
    const requestProfile = resolveChapterLabelRepairRequestProfile({
      ...jobProviderOptions,
      ...(pinnedSource?.repairRequestProfile?.id
        ? { repairRequestProfileId: pinnedSource.repairRequestProfile.id }
        : {}),
    });
    const contextPacket = await labelingContextPacketForJob({
      pool,
      job,
      chapter,
      paragraphs,
      characterGraph,
      previousEpisodeContext,
      userCorrections,
      providerOptions: jobProviderOptions,
      responseSchema: requestProfile.responseSchema,
      pinned: pinnedSource?.contextPacket,
    });
    if (inputRevision) assertPinnedRequestProfile(inputRevision, requestProfile);
    const existingSegments = await loadStoredSegments(pool, job);
    if (existingSegments.length === 0) throw new Error('chapter_label_repair requires existing labeled segments');
    const existingResult: ChapterLabelingResult = {
      characters: knownCharacters,
      segments: existingSegments,
    };
    const inputValidation = validateChapterLabelingResult({
      novelId: job.book_id,
      chapter,
      paragraphs,
      knownCharacters,
      characterGraph,
      previousEpisodeContext,
      userCorrections,
      validationPolicy: validationPolicyForJob(job, requestProfile.validationPolicy),
      result: existingResult,
    });
    const inputQuality = validateChapterLabelingQuality({
      chapter,
      paragraphs,
      result: existingResult,
    });
    const existingNeedsRepair = !inputValidation.ok || !inputQuality.ok;
    await updateProviderJobProgress(pool, job, {
      stage: existingNeedsRepair ? 'repairing_labels' : 'writing_results',
      progress: {
        ...recordValue(job.progress),
        paragraphCount: paragraphs.length,
        labelingWindowParagraphIds,
        labelingWindowCoversFullChapter: labelingWindowCoversFullChapterValue,
        knownCharacterCount: knownCharacters.length,
        relationCount: characterGraph.relations.length,
        correctionCount: userCorrections.length,
        existingSegmentCount: existingSegments.length,
        hasPreviousEpisodeContext: Boolean(previousEpisodeContext),
        inputValidation: inputValidation.summary,
        inputQuality: inputQuality.summary,
      },
    });
    let result = existingResult;
    let repairProviderExecution: ReturnType<typeof takeProviderExecutionMetadata>;
    await assertProviderJobNotCancelled(pool, job);
    if (existingNeedsRepair) {
      const provider =
        deps.createAIProvider?.({
          providerId: job.provider_id,
          modelId: job.model_id,
          providerOptions: { ...jobProviderOptions, repairRequestProfileId: requestProfile.id },
        }) ??
        createServerAIProvider({
          providerId: job.provider_id,
          modelId: job.model_id,
          providerOptions: { ...jobProviderOptions, repairRequestProfileId: requestProfile.id },
          secrets: await resolveProviderSecrets(pool, config, 'llm_labeling', job.provider_id),
        });
      if (!provider.repairChapterLabels) {
        throw new Error(`Provider does not support chapter label repair: ${job.provider_id}`);
      }
      if (inputRevision) {
        assertPinnedRequestProfile(inputRevision, requestProfile);
        await verifyAnalysisInputBeforeExecution(pool, job, inputRevision);
      }
      await deps.beforeProviderDispatch?.();
      result = await provider.repairChapterLabels({
        novelId: job.book_id,
        chapter,
        paragraphs,
        windowId: inputRevision?.windowSpec.windowId,
        inputRevisionId: inputRevision?.id ?? job.id,
        knownCharacters,
        characterGraph,
        previousEpisodeContext,
        userCorrections,
        contextPacket,
        existingResult,
        validationIssues: [...inputValidation.issues, ...qualityIssuesAsRepairIssues(inputQuality.issues)],
        signal,
      });
      repairProviderExecution = takeProviderExecutionMetadata(provider);
      await assertProviderJobNotCancelled(pool, job);
    }
    const validation = validateChapterLabelingResult({
      novelId: job.book_id,
      chapter,
      paragraphs,
      knownCharacters,
      characterGraph,
      previousEpisodeContext,
      userCorrections,
      validationPolicy: validationPolicyForJob(job, requestProfile.validationPolicy),
      result,
    });
    const quality = validateChapterLabelingQuality({
      chapter,
      paragraphs,
      result,
    });
    await updateProviderJobProgress(pool, job, {
      stage: 'writing_results',
      progress: {
        ...recordValue(job.progress),
        characterCount: result.characters.length,
        segmentCount: result.segments.length,
        inputValidation: inputValidation.summary,
        inputQuality: inputQuality.summary,
        validation: validation.summary,
        quality: quality.summary,
        repaired: existingNeedsRepair,
        providerExecution: repairProviderExecution,
      },
    });
    if (!validation.ok || !quality.ok) {
      throw new ChapterLabelingValidationError(
        chapterLabelingFailureMessage(validation, quality),
        validation.summary,
        quality.summary,
      );
    }
    await assertProviderJobNotCancelled(pool, job);
    await persistChapterLabelingResult(
      pool,
      job,
      chapter,
      result,
      validation,
      requestProfile,
      {
        inputValidation: inputValidation.summary,
        inputQuality: inputQuality.summary,
        quality: quality.summary,
        paragraphIds: labelingWindowParagraphIds,
        coversFullChapter: labelingWindowCoversFullChapterValue,
        relationCount: characterGraph.relations.length,
        repaired: existingNeedsRepair,
        providerExecution: repairProviderExecution,
      },
      inputRevision,
    );
    return;
  }

  await updateProviderJobProgress(pool, job, {
    stage: 'labeling_segments',
    progress: {
      ...recordValue(job.progress),
      paragraphCount: paragraphs.length,
      labelingWindowParagraphIds,
      labelingWindowCoversFullChapter: labelingWindowCoversFullChapterValue,
      knownCharacterCount: knownCharacters.length,
      relationCount: characterGraph.relations.length,
      correctionCount: userCorrections.length,
      hasPreviousEpisodeContext: Boolean(previousEpisodeContext),
    },
  });
  await assertProviderJobNotCancelled(pool, job);

  const jobProviderOptions = inputRevision
    ? { ...inputRevision.providerOptions }
    : providerOptionsFromJobProgress(job.progress);
  const runtimeProviderOptions = inputRevision
    ? {
        ...jobProviderOptions,
        requestProfileId: inputRevision.requestProfile.id,
        ...(pinnedSource?.repairRequestProfile?.id
          ? { repairRequestProfileId: pinnedSource.repairRequestProfile.id }
          : {}),
      }
    : jobProviderOptions;
  const requestProfile = resolveChapterLabelingRequestProfile(runtimeProviderOptions);
  const contextPacket = await labelingContextPacketForJob({
    pool,
    job,
    chapter,
    paragraphs,
    characterGraph,
    previousEpisodeContext,
    userCorrections,
    providerOptions: jobProviderOptions,
    responseSchema: requestProfile.responseSchema,
    pinned: pinnedSource?.contextPacket,
  });
  if (inputRevision) assertPinnedRequestProfile(inputRevision, requestProfile);
  const provider =
    deps.createAIProvider?.({
      providerId: job.provider_id,
      modelId: job.model_id,
      providerOptions: runtimeProviderOptions,
    }) ??
    createServerAIProvider({
      providerId: job.provider_id,
      modelId: job.model_id,
      providerOptions: runtimeProviderOptions,
      secrets: await resolveProviderSecrets(pool, config, 'llm_labeling', job.provider_id),
    });
  if (inputRevision) {
    assertPinnedRequestProfile(inputRevision, requestProfile);
    await verifyAnalysisInputBeforeExecution(pool, job, inputRevision);
  }
  await deps.beforeProviderDispatch?.();
  let result = await provider.labelChapterSegments({
    novelId: job.book_id,
    chapter,
    paragraphs,
    windowId: inputRevision?.windowSpec.windowId,
    inputRevisionId: inputRevision?.id ?? job.id,
    knownCharacters,
    characterGraph,
    previousEpisodeContext,
    userCorrections,
    contextPacket,
    signal,
  });
  const labelingProviderExecution = takeProviderExecutionMetadata(provider);
  await assertProviderJobNotCancelled(pool, job);
  if (inputRevision) await verifyAnalysisInputBeforeExecution(pool, job, inputRevision);
  let validation = validateChapterLabelingResult({
    novelId: job.book_id,
    chapter,
    paragraphs,
    knownCharacters,
    characterGraph,
    previousEpisodeContext,
    userCorrections,
    validationPolicy: validationPolicyForJob(job, requestProfile.validationPolicy),
    result,
  });
  let quality = validateChapterLabelingQuality({
    chapter,
    paragraphs,
    result,
  });

  await updateProviderJobProgress(pool, job, {
    stage: 'writing_results',
    progress: {
      ...recordValue(job.progress),
      characterCount: result.characters.length,
      segmentCount: result.segments.length,
      validation: validation.summary,
      quality: quality.summary,
      providerExecution: labelingProviderExecution,
    },
  });
  if (!validation.ok || !quality.ok) {
    const autoRepairEnabled = booleanProviderOption(jobProviderOptions, 'autoRepairOnValidationFailure');
    const initialValidation = validation;
    const initialQuality = quality;
    const repairRequestProfile = resolveChapterLabelRepairRequestProfile(runtimeProviderOptions);
    if (inputRevision) assertPinnedRepairRequestProfile(inputRevision, repairRequestProfile);
    const repairIssues = [...initialValidation.issues, ...qualityIssuesAsRepairIssues(initialQuality.issues)];
    const repairInputFingerprint = structuredIntegrityHash({
      parentInputRevisionId: inputRevision?.id,
      labelingRequestProfileId: requestProfile.id,
      repairRequestProfileId: repairRequestProfile.id,
      segmentAnchors: result.segments.map((segment) => ({
        id: segment.id,
        paragraphId: segment.paragraphId,
        startOffset: segment.startOffset,
        endOffset: segment.endOffset,
        segmentTextHash: segment.segmentTextHash,
        speakerId: segment.speakerId,
        emotion: segment.emotion,
      })),
      validation: initialValidation.summary,
      quality: initialQuality.summary,
      repairIssues,
    });
    const repairCandidateArtifact = inputRevision
      ? await withBookAITransaction(pool, async (client) => {
          await verifyAnalysisInputBeforeExecution(client, job, inputRevision, { lock: true });
          const artifact = await stageAnalysisArtifact(
            client,
            inputRevision,
            'chapter_labels',
            structuredIntegrityHash(result),
            result,
            {
              candidateStatus: 'validation_failed',
              repairInputFingerprint,
              labelingRequestProfileId: requestProfile.id,
              repairRequestProfileId: repairRequestProfile.id,
              validation: initialValidation.summary,
              quality: initialQuality.summary,
              repairIssues,
            },
          );
          await ensureChapterLabelAnalysisReview(client, {
            revision: inputRevision,
            artifact,
            candidate: result,
            validation: initialValidation,
            quality: initialQuality,
            attemptId: job.execution?.attemptId,
            providerExecution: labelingProviderExecution,
          });
          return artifact;
        })
      : undefined;
    await updateProviderJobProgress(pool, job, {
      stage: inputRevision ? 'repair_candidate_ready' : 'repairing_labels',
      progress: {
        ...recordValue(job.progress),
        characterCount: result.characters.length,
        segmentCount: result.segments.length,
        validation: initialValidation.summary,
        quality: initialQuality.summary,
        autoRepair: {
          enabled: autoRepairEnabled,
          attempted: false,
          delegated: Boolean(inputRevision),
          requestProfileId: repairRequestProfile.id,
          parentInputRevisionId: inputRevision?.id,
          candidateArtifactId: repairCandidateArtifact?.id,
          repairInputFingerprint,
        },
      },
    });
    if (!autoRepairEnabled) {
      throw new ChapterLabelingValidationError(
        chapterLabelingFailureMessage(validation, quality),
        validation.summary,
        quality.summary,
      );
    }
    if (!provider.repairChapterLabels) {
      throw new ChapterLabelingValidationError(
        `Chapter labeling validation or quality check failed and provider does not support auto repair: ${job.provider_id}`,
        validation.summary,
        quality.summary,
      );
    }
    if (inputRevision) {
      throw new ChapterLabelingValidationError(
        chapterLabelingFailureMessage(validation, quality),
        validation.summary,
        quality.summary,
      );
    }
    await assertProviderJobNotCancelled(pool, job);
    await deps.beforeProviderDispatch?.();
    result = await provider.repairChapterLabels({
      novelId: job.book_id,
      chapter,
      paragraphs,
      knownCharacters,
      characterGraph,
      previousEpisodeContext,
      userCorrections,
      contextPacket,
      existingResult: result,
      validationIssues: repairIssues,
      signal,
    });
    const repairProviderExecution = takeProviderExecutionMetadata(provider);
    await assertProviderJobNotCancelled(pool, job);
    validation = validateChapterLabelingResult({
      novelId: job.book_id,
      chapter,
      paragraphs,
      knownCharacters,
      characterGraph,
      previousEpisodeContext,
      userCorrections,
      validationPolicy: validationPolicyForJob(job, requestProfile.validationPolicy),
      result,
    });
    quality = validateChapterLabelingQuality({
      chapter,
      paragraphs,
      result,
    });
    await updateProviderJobProgress(pool, job, {
      stage: 'writing_results',
      progress: {
        ...recordValue(job.progress),
        characterCount: result.characters.length,
        segmentCount: result.segments.length,
        initialValidation: initialValidation.summary,
        initialQuality: initialQuality.summary,
        validation: validation.summary,
        quality: quality.summary,
        autoRepair: {
          enabled: true,
          attempted: true,
          succeeded: validation.ok && quality.ok,
          requestProfileId: repairRequestProfile.id,
          repairInputFingerprint,
        },
        providerExecution: repairProviderExecution,
      },
    });
    if (!validation.ok || !quality.ok) {
      throw new ChapterLabelingValidationError(
        chapterLabelingFailureMessage(validation, quality),
        validation.summary,
        quality.summary,
      );
    }
    await assertProviderJobNotCancelled(pool, job);
    await persistChapterLabelingResult(
      pool,
      job,
      chapter,
      result,
      validation,
      repairRequestProfile,
      {
        labelingRequestProfileId: requestProfile.id,
        labelingPromptVersion: requestProfile.promptVersion,
        initialValidation: initialValidation.summary,
        initialQuality: initialQuality.summary,
        quality: quality.summary,
        paragraphIds: labelingWindowParagraphIds,
        coversFullChapter: labelingWindowCoversFullChapterValue,
        relationCount: characterGraph.relations.length,
        autoRepair: {
          enabled: true,
          attempted: true,
          succeeded: true,
          requestProfileId: repairRequestProfile.id,
          repairInputFingerprint,
        },
        initialProviderExecution: labelingProviderExecution,
        providerExecution: repairProviderExecution,
      },
      inputRevision,
    );
    return;
  }

  await assertProviderJobNotCancelled(pool, job);
  await persistChapterLabelingResult(
    pool,
    job,
    chapter,
    result,
    validation,
    requestProfile,
    {
      quality: quality.summary,
      paragraphIds: labelingWindowParagraphIds,
      coversFullChapter: labelingWindowCoversFullChapterValue,
      relationCount: characterGraph.relations.length,
      providerExecution: labelingProviderExecution,
    },
    inputRevision,
  );
}
