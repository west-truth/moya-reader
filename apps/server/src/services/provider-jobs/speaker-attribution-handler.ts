import { persistentId128, structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { analysisOutputIntegrityHash } from '@noveldesk/text-core/identity/ai';
import type pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { createServerAIProvider } from '../../providers/server-ai-provider-factory.js';
import { resolveProviderSecrets } from '../../providers/server-provider-secrets.js';
import { validateChapterLabelingQuality } from '../../../../../src/providers/chapter-labeling-quality';
import { validateChapterLabelingResult } from '../../../../../src/providers/chapter-labeling-validator';
import type { AIProvider } from '../../../../../src/providers/ai';
import {
  expandSpeakerAttributionBatchToCanonicalLabels,
  type CanonicalSpeakerAttributionUnitV3,
} from '../../../../../src/providers/speaker-attribution/canonical-batch-expander';
import { decodeDialogueSequences } from '../../../../../src/providers/speaker-attribution/sequence-decoder';
import {
  compareIndependentSpeakerEscalation,
  routeSpeakerRisks,
  selectIndependentEscalationTargets,
  type SpeakerEscalationComparisonV1,
} from '../../../../../src/providers/speaker-attribution/routing';
import { createSpeakerArtifactDependency } from '../../../../../src/providers/speaker-attribution/artifact-dependency';
import { createSpeakerSequenceDecisionRecord } from '../../../../../src/providers/speaker-attribution/workflow-state';
import {
  buildCompactSpeakerAttributionRequest,
  compactSpeakerAttributionRequestProfile,
} from '../../../../../src/providers/speaker-attribution/request-profile';
import { sliceSceneSpeakerPacketTargets } from '../../../../../src/providers/speaker-attribution/scene-packet';
import { assertSpeakerAttributionPinnedPayload } from '../../../../../src/providers/speaker-attribution/workflow-contract';
import {
  projectSpeakerSegmentProvenanceDrafts,
  speakerSegmentProvenanceDraftsFingerprint,
} from '../../../../../src/providers/speaker-attribution/speaker-provenance-projection';
import {
  takeProviderExecutionMetadata,
  type ProviderExecutionMetadata,
} from '../../../../../src/providers/provider-execution';
import { AnalysisInputStaleError, type AnalysisInputRevision } from '../book-ai-workflow/analysis-input-contracts.js';
import {
  assertPinnedRequestProfile,
  verifyAnalysisInputBeforeExecution,
} from '../book-ai-workflow/analysis-input-verification.js';
import { analysisReviewRequestProfile } from '../book-ai-workflow/analysis-review-source.js';
import { ensureChapterLabelAnalysisReview } from '../book-ai-workflow/analysis-review-repository.js';
import { stageAnalysisArtifact } from '../book-ai-workflow/staging-artifact-repository.js';
import { withBookAITransaction } from '../book-ai-workflow/transaction.js';
import {
  assertProviderJobNotCancelled,
  lockProviderJobForPersistence,
  updateProviderJobProgress,
} from './job-lifecycle.js';
import { recordValue } from './job-progress.js';
import { persistChapterLabelingResult } from './result-persistence.js';
import { ProviderJobCancelledError, type ProviderJobRow, type ProviderJobServiceDeps } from './contracts.js';
import {
  putHostedSpeakerArtifactDependencies,
  replaceHostedSpeakerSequenceDecisions,
} from '../speaker-workflow-state-service.js';

function stringOption(options: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = options[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

async function createSpeakerProvider(input: {
  readonly pool: pg.Pool;
  readonly config: ServerConfig;
  readonly deps: ProviderJobServiceDeps;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerOptions: Readonly<Record<string, unknown>>;
}): Promise<AIProvider> {
  return (
    input.deps.createAIProvider?.({
      providerId: input.providerId,
      modelId: input.modelId,
      providerOptions: { ...input.providerOptions },
    }) ??
    createServerAIProvider({
      providerId: input.providerId,
      modelId: input.modelId,
      providerOptions: { ...input.providerOptions },
      secrets: await resolveProviderSecrets(input.pool, input.config, 'llm_labeling', input.providerId),
    })
  );
}

export async function processSpeakerAttributionJob(
  pool: pg.Pool,
  config: ServerConfig,
  job: ProviderJobRow,
  deps: ProviderJobServiceDeps,
  signal: AbortSignal | undefined,
  inputRevision: AnalysisInputRevision | undefined,
): Promise<void> {
  const source = inputRevision?.sourceSnapshot;
  if (!inputRevision || source?.kind !== 'speaker_attribution_v3') {
    throw new AnalysisInputStaleError('analysis_source_stale', `Compact speaker input is missing: ${job.id}`);
  }
  assertSpeakerAttributionPinnedPayload(source);
  assertPinnedRequestProfile(inputRevision, compactSpeakerAttributionRequestProfile);
  await verifyAnalysisInputBeforeExecution(pool, job, inputRevision);
  await updateProviderJobProgress(pool, job, {
    stage: 'loading_speaker_snapshot',
    progress: {
      ...recordValue(job.progress),
      sceneRequestCount: source.units.length,
      targetSpanCount: source.units.reduce((total, unit) => total + unit.packet.targets.length, 0),
      spanCount: source.canonicalSource.spanInventory.spans.length,
    },
  });

  const attributedUnits: CanonicalSpeakerAttributionUnitV3[] = [];
  const providerExecutions: ProviderExecutionMetadata[] = [];
  if (source.units.length > 0) {
    const provider = await createSpeakerProvider({
      pool,
      config,
      deps,
      providerId: job.provider_id,
      modelId: job.model_id ?? 'mock-speaker-v1',
      providerOptions: inputRevision.providerOptions,
    });
    if (!provider.attributeSpeakers) {
      throw new Error(`Provider does not support compact speaker attribution: ${job.provider_id}`);
    }
    await updateProviderJobProgress(pool, job, { stage: 'attributing_speakers' });
    await deps.beforeProviderDispatch?.();
    for (const unit of source.units) {
      await assertProviderJobNotCancelled(pool, job);
      const result = await provider.attributeSpeakers({
        packet: unit.packet,
        generationPolicy: unit.generationPolicy,
        outputBudget: unit.outputBudget,
        signal,
      });
      if (result.packetFingerprint !== unit.packet.fingerprint) {
        throw new Error(`Compact speaker provider returned a stale packet result: ${unit.sceneId}`);
      }
      attributedUnits.push({
        packet: unit.packet,
        validatedWire: result.validatedWire,
        sequenceDecisions: decodeDialogueSequences(unit.packet, result.validatedWire),
      });
      const execution = takeProviderExecutionMetadata(provider);
      if (execution) providerExecutions.push(execution);
    }
  }
  await verifyAnalysisInputBeforeExecution(pool, job, inputRevision);
  await updateProviderJobProgress(pool, job, { stage: 'decoding_speaker_sequence' });

  const targetParagraphIds = new Set(source.canonicalSource.paragraphs.map((paragraph) => paragraph.id));
  const targetSpanIndexes = source.canonicalSource.spanInventory.spans
    .filter((span) => targetParagraphIds.has(span.paragraphId))
    .map((span) => span.spanIndex);
  const sequenceDecisions = attributedUnits.flatMap((unit) => unit.sequenceDecisions);
  const initialRiskRoutes = routeSpeakerRisks({
    sieve: source.canonicalSource.sieve,
    attributedUnits,
    sequenceDecisions,
    targetSpanIndexes,
  });
  const semanticEscalationRequests = initialRiskRoutes
    .filter((route) => route.riskClass === 'semantic' && route.escalationAllowed)
    .flatMap((route) => route.targetSpanIndexes);
  const escalationComparisons: SpeakerEscalationComparisonV1[] = [];
  const escalationProviderExecutions: ProviderExecutionMetadata[] = [];
  const resolvedEscalationSpanIndexes = new Set<number>();
  const escalationDisagreementSpanIndexes = new Set<number>();
  const escalationUncalibratedSpanIndexes = new Set<number>();
  let escalationFailureCode: string | undefined;
  let selectedEscalationSpanIndexes: readonly number[] = [];
  if (inputRevision.providerOptions.speakerEscalationEnabled === true && semanticEscalationRequests.length > 0) {
    const maximumRatio = numberOption(inputRevision.providerOptions, 'speakerEscalationMaximumRatio', 0.15, 0, 0.15);
    const maximumTargets = Math.floor(
      numberOption(inputRevision.providerOptions, 'speakerEscalationMaximumTargets', 40, 0, 40),
    );
    selectedEscalationSpanIndexes = selectIndependentEscalationTargets(
      semanticEscalationRequests,
      source.units.reduce((total, unit) => total + unit.packet.targets.length, 0),
      maximumRatio,
    ).slice(0, maximumTargets);
  }
  if (selectedEscalationSpanIndexes.length > 0) {
    await updateProviderJobProgress(pool, job, { stage: 'escalating_speakers' });
    const escalationProviderId =
      stringOption(inputRevision.providerOptions, 'speakerEscalationProviderId') ?? job.provider_id;
    const escalationModelId =
      stringOption(inputRevision.providerOptions, 'speakerEscalationModelId') ??
      job.model_id ??
      'mock-speaker-escalation-v1';
    const maximumRequests = Math.floor(
      numberOption(inputRevision.providerOptions, 'speakerEscalationMaximumRequests', 4, 1, 16),
    );
    const minimumConfidence = Math.floor(
      numberOption(inputRevision.providerOptions, 'speakerEscalationMinimumConfidence', 850, 650, 1_000),
    );
    let escalationProvider: AIProvider | undefined;
    try {
      escalationProvider = await createSpeakerProvider({
        pool,
        config,
        deps,
        providerId: escalationProviderId,
        modelId: escalationModelId,
        providerOptions: inputRevision.providerOptions,
      });
      if (!escalationProvider.attributeSpeakers) {
        throw new Error(`Provider does not support compact speaker escalation: ${escalationProviderId}`);
      }
      let requestCount = 0;
      for (const unit of attributedUnits) {
        const selectedForUnit = unit.packet.targets
          .map((target) => target[0])
          .filter((spanIndex) => selectedEscalationSpanIndexes.includes(spanIndex));
        if (selectedForUnit.length === 0) continue;
        if (requestCount >= maximumRequests) {
          selectedForUnit.forEach((spanIndex) => escalationUncalibratedSpanIndexes.add(spanIndex));
          continue;
        }
        await assertProviderJobNotCancelled(pool, job);
        const packet = sliceSceneSpeakerPacketTargets(unit.packet, selectedForUnit);
        const request = buildCompactSpeakerAttributionRequest({
          packet,
          providerId: escalationProviderId,
          modelId: escalationModelId,
          providerOptions: inputRevision.providerOptions,
          taskKind: 'speaker_escalation',
        });
        const result = await escalationProvider.attributeSpeakers({
          packet,
          generationPolicy: request.generationPolicy,
          outputBudget: request.outputBudget,
          mode: 'independent_escalation',
          signal,
        });
        requestCount += 1;
        if (result.packetFingerprint !== packet.fingerprint) {
          throw new Error(`Compact speaker escalator returned a stale packet result: ${unit.packet.sceneId}`);
        }
        const comparison = compareIndependentSpeakerEscalation({
          primaryPacket: unit.packet,
          primary: unit.validatedWire,
          escalationPacket: packet,
          escalation: result.validatedWire,
          minimumConfidence,
        });
        escalationComparisons.push(comparison);
        comparison.resolvedSpanIndexes.forEach((spanIndex) => resolvedEscalationSpanIndexes.add(spanIndex));
        comparison.disagreementSpanIndexes.forEach((spanIndex) => escalationDisagreementSpanIndexes.add(spanIndex));
        comparison.uncalibratedSpanIndexes.forEach((spanIndex) => escalationUncalibratedSpanIndexes.add(spanIndex));
        const execution = takeProviderExecutionMetadata(escalationProvider);
        if (execution) escalationProviderExecutions.push(execution);
      }
    } catch {
      escalationFailureCode = 'speaker_escalation_failed';
      const execution = escalationProvider ? takeProviderExecutionMetadata(escalationProvider) : undefined;
      if (execution) escalationProviderExecutions.push(execution);
    }
  }

  const expanded = expandSpeakerAttributionBatchToCanonicalLabels({
    bookId: inputRevision.bookId,
    chapterId: source.canonicalSource.chapter.id,
    characters: source.canonicalSource.characters,
    spanInventory: source.canonicalSource.spanInventory,
    paragraphs: source.canonicalSource.sourceParagraphs,
    sieve: source.canonicalSource.sieve,
    speakerIdByEntityId: source.canonicalSource.speakerIdByEntityId,
    targetSpanIndexes,
    units: attributedUnits,
  });
  const resolvedSpanIds = new Set(
    source.canonicalSource.spanInventory.spans
      .filter((span) => resolvedEscalationSpanIndexes.has(span.spanIndex))
      .map((span) => span.id),
  );
  const resolvedSpanRangeKeys = new Set(
    source.canonicalSource.spanInventory.spans
      .filter((span) => resolvedSpanIds.has(span.id))
      .map((span) => `${span.paragraphId}:${span.startOffset}:${span.endOffset}`),
  );
  const targetSegments = expanded.result.segments.filter((segment) => targetParagraphIds.has(segment.paragraphId));
  const targetSegmentIds = new Set(targetSegments.map((segment) => segment.id));
  const expansion = {
    ...expanded,
    result: {
      ...expanded.result,
      segments: targetSegments,
      uncertainties: expanded.result.uncertainties?.filter(
        (item) =>
          targetParagraphIds.has(item.paragraphId) &&
          !(
            item.reasonCode === 'speaker_review_required' &&
            resolvedSpanRangeKeys.has(`${item.paragraphId}:${item.startOffset}:${item.endOffset}`)
          ),
      ),
      segmentAnnotations: Object.fromEntries(
        Object.entries(expanded.result.segmentAnnotations ?? {}).filter(([segmentId]) =>
          targetSegmentIds.has(segmentId),
        ),
      ),
    },
    routedSpanIds: expanded.routedSpanIds.filter((spanId) => {
      const span = source.canonicalSource.spanInventory.spans.find((candidate) => candidate.id === spanId);
      return Boolean(span && targetParagraphIds.has(span.paragraphId) && !resolvedSpanIds.has(spanId));
    }),
  };
  const sequenceRecords = attributedUnits.flatMap((unit) =>
    unit.sequenceDecisions.map((decision) =>
      createSpeakerSequenceDecisionRecord({
        bookId: inputRevision.bookId,
        contentRevisionId: inputRevision.contentRevisionId,
        chapterId: source.canonicalSource.chapter.id,
        sceneId: unit.packet.sceneId,
        packetFingerprint: unit.packet.fingerprint,
        decision,
      }),
    ),
  );
  const speakerProvenanceDrafts = projectSpeakerSegmentProvenanceDrafts({
    bookId: inputRevision.bookId,
    contentRevisionId: inputRevision.contentRevisionId,
    chapterId: source.canonicalSource.chapter.id,
    chapterIndex: source.canonicalSource.chapter.index,
    sourceManifestFingerprint: source.sourceManifestFingerprint,
    spanInventory: source.canonicalSource.spanInventory,
    dialogueBurstInventory: source.canonicalSource.dialogueBurstInventory,
    sieve: source.canonicalSource.sieve,
    result: expansion.result,
    units: attributedUnits,
  });
  const speakerProvenanceFingerprint = speakerSegmentProvenanceDraftsFingerprint(speakerProvenanceDrafts);
  const riskRoutes = routeSpeakerRisks({
    sieve: source.canonicalSource.sieve,
    attributedUnits,
    sequenceDecisions,
    targetSpanIndexes,
    resolvedEscalationSpanIndexes: [...resolvedEscalationSpanIndexes],
    escalationDisagreementSpanIndexes: [...escalationDisagreementSpanIndexes],
    escalationUncalibratedSpanIndexes: [...escalationUncalibratedSpanIndexes],
  });
  const reviewProfile = analysisReviewRequestProfile(inputRevision);
  const validation = validateChapterLabelingResult({
    novelId: inputRevision.bookId,
    chapter: source.canonicalSource.chapter,
    paragraphs: [...source.canonicalSource.paragraphs],
    knownCharacters: inputRevision.graphSnapshot.characters,
    characterGraph: inputRevision.graphSnapshot,
    previousEpisodeContext: inputRevision.episodeContextSnapshot,
    userCorrections: [...inputRevision.correctionsSnapshot],
    validationPolicy: job.provider_id === 'mock' ? 'legacy' : reviewProfile.validationPolicy,
    result: expansion.result,
  });
  const quality = validateChapterLabelingQuality({
    chapter: source.canonicalSource.chapter,
    paragraphs: [...source.canonicalSource.paragraphs],
    result: expansion.result,
  });
  const needsReview = expansion.routedSpanIds.length > 0 || riskRoutes.length > 0 || !validation.ok || !quality.ok;
  const metadata = {
    labelingContract: source.contract,
    packetFingerprints: source.units.map((unit) => unit.packet.fingerprint),
    sequenceDecisionIds: sequenceDecisions.map((decision) => decision.id),
    riskRoutes,
    routedSpanCount: expansion.routedSpanIds.length,
    pendingSpeakerEntityCount: expansion.pendingSpeakerEntities.length,
    speakerProvenanceCount: speakerProvenanceDrafts.length,
    speakerProvenanceFingerprint,
    providerExecutions,
    speakerEscalation: {
      enabled: inputRevision.providerOptions.speakerEscalationEnabled === true,
      requestedSpanCount: semanticEscalationRequests.length,
      selectedSpanCount: selectedEscalationSpanIndexes.length,
      resolvedSpanCount: resolvedEscalationSpanIndexes.size,
      disagreementSpanCount: escalationDisagreementSpanIndexes.size,
      uncalibratedSpanCount: escalationUncalibratedSpanIndexes.size,
      comparisonFingerprints: escalationComparisons.map((comparison) => comparison.fingerprint),
      providerExecutions: escalationProviderExecutions,
      failureCode: escalationFailureCode,
    },
    validation: validation.summary,
    quality: quality.summary,
  };

  if (needsReview) {
    await updateProviderJobProgress(pool, job, { stage: 'routing_speaker_review' });
    await assertProviderJobNotCancelled(pool, job);
    await withBookAITransaction(pool, async (client) => {
      await lockProviderJobForPersistence(client, job);
      await verifyAnalysisInputBeforeExecution(client, job, inputRevision, { lock: true });
      const outputHash = structuredIntegrityHash({
        result: expansion.result,
        speakerProvenanceFingerprint,
      });
      const artifact = await stageAnalysisArtifact(
        client,
        inputRevision,
        'chapter_labels',
        outputHash,
        expansion.result,
        { ...metadata, speakerProvenanceDrafts },
      );
      const reviewArtifact = await ensureChapterLabelAnalysisReview(client, {
        revision: inputRevision,
        artifact,
        candidate: expansion.result,
        validation,
        quality,
        attemptId: job.execution?.attemptId,
        providerExecution: providerExecutions.at(-1),
      });
      await replaceHostedSpeakerSequenceDecisions(client, inputRevision.userId, {
        bookId: inputRevision.bookId,
        contentRevisionId: inputRevision.contentRevisionId,
        chapterId: source.canonicalSource.chapter.id,
        records: sequenceRecords,
      });
      await putHostedSpeakerArtifactDependencies(client, inputRevision.userId, [
        createSpeakerArtifactDependency({
          bookId: inputRevision.bookId,
          contentRevisionId: inputRevision.contentRevisionId,
          chapterId: source.canonicalSource.chapter.id,
          artifactId: artifact.id,
          artifactKind: 'chapter_labels',
          level: 'L3_speaker',
          dependencyIds: [
            source.sourceManifestFingerprint,
            source.spanInventoryHash,
            source.mentionInventoryHash,
            source.candidateMemoryHash,
            source.temporalSnapshotHash,
            inputRevision.correctionFingerprint,
            ...source.units.map((unit) => unit.packet.fingerprint),
            ...sequenceDecisions.map((decision) => decision.id),
          ],
        }),
      ]);
      const workflowUpdate = await client.query(
        `
          update book_ai_workflows
          set status = 'needs_review', stage = 'needs_review',
              error_code = 'speaker_review_required',
              error_message = 'Compact speaker attribution requires review.',
              updated_at = now()
          where id = $1 and user_id = $2 and status = 'running'
        `,
        [inputRevision.workflowId, inputRevision.userId],
      );
      if (workflowUpdate.rowCount !== undefined && workflowUpdate.rowCount !== 1) {
        throw new ProviderJobCancelledError(job.id);
      }
      await client.query(
        'update library_books set analysis_status = $1, updated_at = now() where id = $2 and user_id = $3',
        ['needs_review', inputRevision.bookId, inputRevision.userId],
      );
      const completionApplied = await updateProviderJobProgress(client, job, {
        status: 'succeeded',
        stage: 'ready',
        mergeProgress: {
          ...metadata,
          manualReview: {
            status: 'open',
            reviewArtifactId: reviewArtifact.id,
            stagingArtifactId: artifact.id,
          },
        },
        finishedAt: true,
      });
      if (!completionApplied) throw new ProviderJobCancelledError(job.id);
    });
    return;
  }

  await assertProviderJobNotCancelled(pool, job);
  await persistChapterLabelingResult(
    pool,
    job,
    source.canonicalSource.chapter,
    expansion.result,
    validation,
    compactSpeakerAttributionRequestProfile,
    {
      ...metadata,
      paragraphIds: inputRevision.windowSpec.paragraphAnchors.map((anchor) => anchor.paragraphId),
      coversFullChapter: source.coversFullChapter,
    },
    inputRevision,
    speakerProvenanceDrafts,
  );
  const promotedOutputHash = analysisOutputIntegrityHash({
    characterIds: expansion.result.characters.map((character) => character.id),
    segmentIds: expansion.result.segments.map((segment) => segment.id),
    episodeContext: expansion.result.episodeContextSummary,
    uncertainties: expansion.result.uncertainties,
    segmentAnnotations: expansion.result.segmentAnnotations,
    speakerProvenanceFingerprint,
  });
  const promotedArtifactId = persistentId128('analysis_staging_artifact', [
    inputRevision.id,
    'chapter_labels',
    promotedOutputHash,
  ]);
  await withBookAITransaction(pool, async (client) => {
    await replaceHostedSpeakerSequenceDecisions(client, inputRevision.userId, {
      bookId: inputRevision.bookId,
      contentRevisionId: inputRevision.contentRevisionId,
      chapterId: source.canonicalSource.chapter.id,
      records: sequenceRecords,
    });
    await putHostedSpeakerArtifactDependencies(client, inputRevision.userId, [
      createSpeakerArtifactDependency({
        bookId: inputRevision.bookId,
        contentRevisionId: inputRevision.contentRevisionId,
        chapterId: source.canonicalSource.chapter.id,
        artifactId: promotedArtifactId,
        artifactKind: 'chapter_labels',
        level: 'L3_speaker',
        dependencyIds: [
          source.sourceManifestFingerprint,
          source.spanInventoryHash,
          source.mentionInventoryHash,
          source.candidateMemoryHash,
          source.temporalSnapshotHash,
          inputRevision.correctionFingerprint,
          ...source.units.map((unit) => unit.packet.fingerprint),
          ...sequenceDecisions.map((decision) => decision.id),
        ],
      }),
    ]);
  });
}
