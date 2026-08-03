import type { BookAIWorkflowReviewItem } from '../../../providers/book-ai-workflow-review';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { validateChapterLabelingQuality } from '../../../providers/chapter-labeling-quality';
import { validateChapterLabelingResult } from '../../../providers/chapter-labeling-validator';
import { resolveChapterLabelingRequestProfile } from '../../../providers/chapter-labeling-request-profile';
import {
  nativeAnalysisOutputHash,
  type NativeAnalysisWorkflowDescriptor,
  type NativeAnalysisWorkflowFenceInput,
  type NativeAnalysisWorkflowJobPlan,
  type NativeSpeakerWorkflowArtifactPayloadV1,
} from '../../../storage/native-analysis-workflow';
import type { NativeBookWorkflowBridge, NativeBookWorkflowView, NativeWorkflowCheckpointResult } from './contracts';
import { NativeWorkflowDependencyFactory, type NativeWorkflowReaderRepository } from './native-workflow-dependencies';
import { rebuildNativeWorkflowJobRequest } from './orchestrator';

export class NativeCheckpointReviewError extends Error {
  constructor(
    message: string,
    readonly reviewItems: readonly BookAIWorkflowReviewItem[],
  ) {
    super(message);
    this.name = 'NativeCheckpointReviewError';
  }
}

function reviewItem(input: {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly errorCode: string;
  readonly paragraphIds?: readonly string[];
}): BookAIWorkflowReviewItem {
  return {
    id: input.id,
    kind: 'workflow_error',
    severity: 'error',
    title: input.title,
    detail: input.detail,
    recommendedAction: 'retry_workflow',
    actionLabel: '원인 확인 후 다시 분석',
    paragraphIds: input.paragraphIds?.slice(0, 100),
    errorCode: input.errorCode,
  };
}

export function nativeAnalysisJobPlan(descriptor: NativeAnalysisWorkflowDescriptor): NativeAnalysisWorkflowJobPlan[] {
  return [
    {
      jobId: 'character_graph_merge',
      artifactType: 'character_graph',
      plannedParagraphIds: [],
    },
    ...descriptor.plan.labelingWindows.map((window) => ({
      jobId: window.id,
      artifactType: 'label_window' as const,
      chapterId: window.chapterId,
      plannedParagraphIds: [...window.paragraphIds],
    })),
  ];
}

export function nativeAnalysisFenceInput(
  descriptor: NativeAnalysisWorkflowDescriptor,
  workflow: NativeBookWorkflowView,
): NativeAnalysisWorkflowFenceInput {
  return {
    workflowId: workflow.id,
    novelId: descriptor.novelId,
    contentRevisionId: descriptor.contentRevisionId,
    planHash: descriptor.planHash,
    fence: workflow.fence,
    jobs: nativeAnalysisJobPlan(descriptor),
  };
}

function promotionFailure(jobId: string, reason: string): NativeCheckpointReviewError {
  return new NativeCheckpointReviewError(`Native checkpoint promotion failed: ${jobId}`, [
    reviewItem({
      id: `native_promotion:${jobId}`,
      title: '로컬 분석 결과 승격 실패',
      detail: reason,
      errorCode: 'native_promotion_rejected',
    }),
  ]);
}

function validationFailure(
  jobId: string,
  issues: readonly { readonly code: string; readonly message: string; readonly paragraphId?: string }[],
): NativeCheckpointReviewError {
  const visible = issues.slice(0, 20);
  return new NativeCheckpointReviewError(`Native labeling checkpoint validation failed: ${jobId}`, [
    reviewItem({
      id: `native_validation:${jobId}`,
      title: '화자·감정 라벨 검증 실패',
      detail: visible.map((issue) => `${issue.code}: ${issue.message}`).join(' / '),
      errorCode: 'native_label_validation_failed',
      paragraphIds: visible.map((issue) => issue.paragraphId).filter((id): id is string => Boolean(id)),
    }),
  ]);
}

function compactSpeakerRiskFailure(
  jobId: string,
  checkpoint: Awaited<ReturnType<NativeWorkflowDependencyFactory['speakerBatchResult']>>,
): NativeCheckpointReviewError {
  const spanById = new Map(
    checkpoint.materialization.payload.canonicalSource.spanInventory.spans.map((span) => [span.id, span]),
  );
  const spanByIndex = new Map(
    checkpoint.materialization.payload.canonicalSource.spanInventory.spans.map((span) => [span.spanIndex, span]),
  );
  const paragraphIds = [
    ...new Set([
      ...checkpoint.aggregation.routedSpanIds.flatMap((spanId) => {
        const paragraphId = spanById.get(spanId)?.paragraphId;
        return paragraphId ? [paragraphId] : [];
      }),
      ...checkpoint.aggregation.riskRoutes.flatMap((route) =>
        route.targetSpanIndexes.flatMap((spanIndex) => {
          const paragraphId = spanByIndex.get(spanIndex)?.paragraphId;
          return paragraphId ? [paragraphId] : [];
        }),
      ),
    ]),
  ];
  const routeSummary = checkpoint.aggregation.riskRoutes
    .map((route) => `${route.riskClass}: ${route.reasonCodes.join(', ')}`)
    .join(' / ');
  return new NativeCheckpointReviewError(`Native compact speaker checkpoint requires review: ${jobId}`, [
    reviewItem({
      id: `native_speaker_risk:${jobId}`,
      title: '화자 판정 검토 필요',
      detail:
        routeSummary ||
        `${checkpoint.aggregation.routedSpanIds.length}개 화자 span이 자동 승인 기준을 통과하지 못했습니다.`,
      errorCode: 'native_speaker_risk_requires_review',
      paragraphIds,
    }),
  ]);
}

function speakerWorkflowPayload(
  checkpoint: Awaited<ReturnType<NativeWorkflowDependencyFactory['speakerBatchResult']>>,
): NativeSpeakerWorkflowArtifactPayloadV1 {
  const canonicalSpeakerEntries = Object.entries(checkpoint.materialization.payload.canonicalSource.speakerIdByEntityId)
    .map(([speakerEntityId, canonicalSpeakerId]) => [canonicalSpeakerId, speakerEntityId] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    version: 'native-speaker-workflow-artifact-v1',
    sequenceRecords: checkpoint.aggregation.sequenceRecords,
    speakerProvenanceDrafts: checkpoint.aggregation.speakerProvenanceDrafts,
    artifactDependencyIds: checkpoint.aggregation.artifactDependencyIds,
    speakerEntityIdByCanonicalSpeakerId: Object.fromEntries(canonicalSpeakerEntries),
    metadata: checkpoint.aggregation.metadata,
  };
}

async function verifyCheckpointRequest(input: {
  readonly checkpoint: NativeWorkflowCheckpointResult;
  readonly checkpoints: readonly NativeWorkflowCheckpointResult[];
  readonly workflow: NativeBookWorkflowView;
  readonly descriptor: NativeAnalysisWorkflowDescriptor;
  readonly dependencies: NativeWorkflowDependencyFactory;
  readonly bridge: NativeBookWorkflowBridge;
}): Promise<void> {
  const request = await rebuildNativeWorkflowJobRequest({
    plan: input.descriptor.plan,
    contentRevision: input.descriptor.contentRevisionId,
    workflow: input.workflow,
    checkpoints: input.checkpoints,
    dependencies: {
      bridge: input.bridge,
      loaders: input.dependencies.loaders,
      builders: input.dependencies.builders,
      materializeCompactLabeling: (materializeInput) => input.dependencies.materializeCompactLabeling(materializeInput),
      evaluateFinalization: async () => ({ outcome: 'needs_review', reviewItems: [{}] }),
    },
    jobId: input.checkpoint.jobId,
    expectedPlanHash: input.descriptor.planHash,
  });
  const providerWork = 'batch' in request ? request.batch : request.request;
  if (structuredIntegrityHash(providerWork) !== input.checkpoint.requestHash) {
    throw new NativeCheckpointReviewError(`Native checkpoint input drifted: ${input.checkpoint.jobId}`, [
      reviewItem({
        id: `native_request_drift:${input.checkpoint.jobId}`,
        title: '분석 요청 입력 변경 감지',
        detail: '본문, Character Graph, 사용자 수정 또는 provider 설정이 요청 이후 변경되었습니다.',
        errorCode: 'native_checkpoint_request_drift',
      }),
    ]);
  }
}

export async function promoteCompletedNativeCheckpoints(input: {
  readonly workflow: NativeBookWorkflowView;
  readonly descriptor: NativeAnalysisWorkflowDescriptor;
  readonly checkpoints: readonly NativeWorkflowCheckpointResult[];
  readonly dependencies: NativeWorkflowDependencyFactory;
  readonly repository: NativeWorkflowReaderRepository;
  readonly bridge: NativeBookWorkflowBridge;
}): Promise<void> {
  await input.repository.saveNativeAnalysisWorkflowFence(nativeAnalysisFenceInput(input.descriptor, input.workflow));
  input.dependencies.setCheckpoints(input.checkpoints);
  const provenance = await input.repository.listNativeAnalysisProvenance(input.descriptor.novelId);
  const promotedJobIds = new Set(
    provenance.filter((item) => item.workflowId === input.workflow.id).map((item) => item.jobId),
  );
  const graphAlreadyPromoted = promotedJobIds.has('character_graph_merge');
  const checkpoints = [...input.checkpoints].sort((left, right) => {
    const leftView = input.workflow.checkpoints.find((item) => item.jobId === left.jobId);
    const rightView = input.workflow.checkpoints.find((item) => item.jobId === right.jobId);
    return (leftView?.sequence ?? 0) - (rightView?.sequence ?? 0);
  });

  for (const checkpoint of checkpoints) {
    if (input.descriptor.plan.bundleWindows.some((window) => window.id === checkpoint.jobId)) {
      if (graphAlreadyPromoted) continue;
      try {
        await verifyCheckpointRequest({
          checkpoint,
          checkpoints,
          workflow: input.workflow,
          descriptor: input.descriptor,
          dependencies: input.dependencies,
          bridge: input.bridge,
        });
        await input.dependencies.bundleResult(checkpoint);
      } catch (error) {
        throw new NativeCheckpointReviewError(`Native bundle checkpoint is invalid: ${checkpoint.jobId}`, [
          reviewItem({
            id: `native_bundle_validation:${checkpoint.jobId}`,
            title: '캐릭터 번들 결과 검증 실패',
            detail: error instanceof Error ? error.message : String(error),
            errorCode: 'native_bundle_validation_failed',
          }),
        ]);
      }
      continue;
    }
    if (promotedJobIds.has(checkpoint.jobId)) continue;

    await verifyCheckpointRequest({
      checkpoint,
      checkpoints,
      workflow: input.workflow,
      descriptor: input.descriptor,
      dependencies: input.dependencies,
      bridge: input.bridge,
    });

    if (checkpoint.jobId === 'character_graph_merge') {
      let graph;
      try {
        graph = await input.dependencies.graphResult(checkpoint);
      } catch (error) {
        throw new NativeCheckpointReviewError('Native Character Graph checkpoint is invalid', [
          reviewItem({
            id: 'native_graph_validation:character_graph_merge',
            title: 'Character Graph 결과 검증 실패',
            detail: error instanceof Error ? error.message : String(error),
            errorCode: 'native_graph_validation_failed',
          }),
        ]);
      }
      const snapshot = await input.repository.getNativeAnalysisPromotionSnapshot(input.descriptor.novelId);
      const payload = { kind: 'character_graph' as const, graph };
      const artifact = await input.repository.stageNativeAnalysisOutput({
        workflowId: input.workflow.id,
        jobId: checkpoint.jobId,
        novelId: input.descriptor.novelId,
        artifactType: 'character_graph',
        workflowFence: input.workflow.fence,
        planHash: input.descriptor.planHash,
        expectedContentRevisionId: input.descriptor.contentRevisionId,
        expectedGraphFingerprint: snapshot.graphFingerprint,
        correctionFingerprint: snapshot.correctionFingerprint,
        plannedParagraphIds: [],
        outputHash: nativeAnalysisOutputHash(payload),
        payload,
      });
      const result = await input.repository.promoteNativeAnalysisOutput(artifact.id);
      if (result.status !== 'promoted' && result.status !== 'already_promoted') {
        throw promotionFailure(checkpoint.jobId, result.reason);
      }
      promotedJobIds.add(checkpoint.jobId);
      continue;
    }

    const window = input.descriptor.plan.labelingWindows.find((candidate) => candidate.id === checkpoint.jobId);
    if (!window) {
      throw new NativeCheckpointReviewError(`Unknown native checkpoint: ${checkpoint.jobId}`, [
        reviewItem({
          id: `native_checkpoint_unknown:${checkpoint.jobId}`,
          title: '계획에 없는 분석 결과',
          detail: `checkpoint ${checkpoint.jobId}는 저장된 작품 분석 계획에 없습니다.`,
          errorCode: 'native_checkpoint_unknown',
        }),
      ]);
    }
    let decoded;
    let compactCheckpoint: Awaited<ReturnType<NativeWorkflowDependencyFactory['speakerBatchResult']>> | undefined;
    try {
      compactCheckpoint =
        input.descriptor.labelingContract?.kind === 'speaker_attribution_v3'
          ? await input.dependencies.speakerBatchResult(checkpoint)
          : undefined;
      decoded = compactCheckpoint
        ? { source: compactCheckpoint.source, result: compactCheckpoint.aggregation.result }
        : await input.dependencies.labelingResult(checkpoint);
    } catch (error) {
      throw new NativeCheckpointReviewError(`Native labeling checkpoint is invalid: ${checkpoint.jobId}`, [
        reviewItem({
          id: `native_label_parse:${checkpoint.jobId}`,
          title: '화자·감정 라벨 응답 해석 실패',
          detail: error instanceof Error ? error.message : String(error),
          errorCode: 'native_label_parse_failed',
          paragraphIds: window.paragraphIds,
        }),
      ]);
    }
    const validation = validateChapterLabelingResult({
      novelId: input.descriptor.novelId,
      chapter: decoded.source.chapter,
      paragraphs: [...decoded.source.paragraphs],
      knownCharacters: decoded.source.knownCharacters ? [...decoded.source.knownCharacters] : undefined,
      characterGraph: await input.dependencies.graphResult(
        input.checkpoints.find((candidate) => candidate.jobId === 'character_graph_merge')!,
      ),
      userCorrections: decoded.source.userCorrections ? [...decoded.source.userCorrections] : undefined,
      validationPolicy:
        input.descriptor.labelingContract?.kind === 'speaker_attribution_v3'
          ? 'strict_tts'
          : resolveChapterLabelingRequestProfile({
              ...input.descriptor.provider.providerOptions,
            }).validationPolicy,
      result: decoded.result,
    });
    const quality = validateChapterLabelingQuality({
      chapter: decoded.source.chapter,
      paragraphs: [...decoded.source.paragraphs],
      result: decoded.result,
    });
    const errors = [
      ...validation.issues.filter((issue) => issue.severity === 'error'),
      ...quality.issues.filter((issue) => issue.severity === 'error'),
    ];
    const snapshot = await input.repository.getNativeAnalysisPromotionSnapshot(
      input.descriptor.novelId,
      window.chapterId,
    );
    const payload = {
      kind: 'label_window' as const,
      chapterId: window.chapterId,
      segments: decoded.result.segments,
      result: decoded.result,
      ...(compactCheckpoint ? { speakerWorkflow: speakerWorkflowPayload(compactCheckpoint) } : {}),
    };
    const artifact = await input.repository.stageNativeAnalysisOutput({
      workflowId: input.workflow.id,
      jobId: checkpoint.jobId,
      novelId: input.descriptor.novelId,
      chapterId: window.chapterId,
      artifactType: 'label_window',
      workflowFence: input.workflow.fence,
      planHash: input.descriptor.planHash,
      expectedContentRevisionId: input.descriptor.contentRevisionId,
      expectedGraphFingerprint: snapshot.graphFingerprint,
      correctionFingerprint: snapshot.correctionFingerprint,
      plannedParagraphIds: window.paragraphIds,
      outputHash: nativeAnalysisOutputHash(payload),
      payload,
    });
    if (errors.length > 0) throw validationFailure(checkpoint.jobId, errors);
    if (
      compactCheckpoint &&
      (compactCheckpoint.aggregation.riskRoutes.length > 0 || compactCheckpoint.aggregation.routedSpanIds.length > 0)
    ) {
      throw compactSpeakerRiskFailure(checkpoint.jobId, compactCheckpoint);
    }
    const result = await input.repository.promoteNativeAnalysisOutput(artifact.id);
    if (result.status !== 'promoted' && result.status !== 'already_promoted') {
      throw promotionFailure(checkpoint.jobId, result.reason);
    }
    promotedJobIds.add(checkpoint.jobId);
  }
}
