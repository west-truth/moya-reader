import { describe, expect, it, vi } from 'vitest';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { labeledSegmentId, segmentTextIntegrityHash } from '../../../domain/identity/ai-identities';
import type { Chapter, LabeledSegment, Novel, Paragraph, ParagraphPage } from '../../../domain/types';
import type { BookContentRevisionHandle } from '../../../storage/content-revision-read-handle';
import type {
  NativeAnalysisWorkflowDescriptor,
  NativeAnalysisWorkflowDescriptorInput,
  NativeAnalysisPromotionProvenance,
  NativeAnalysisStagedOutput,
} from '../../../storage/native-analysis-workflow';
import type {
  NativeBookWorkflowBridge,
  NativeBookWorkflowReviewRequest,
  NativeBookWorkflowSubmitRequest,
  NativeBookWorkflowView,
  NativeLabelMutationFinalizeRequest,
  NativeLabelMutationPrepareRequest,
} from './contracts';
import type { NativeWorkflowReaderRepository } from './native-workflow-dependencies';
import { NativeBookAnalysisWorkflowGateway } from './native-book-analysis-workflow-gateway';

const now = '2026-07-11T00:00:00.000Z';
const workflowDefinitionId = 'moya.ai.tts.book-preparation' as const;
const workflowVersion = '1.0.0';
const novel: Novel = {
  id: 'book-1',
  title: 'Book',
  sourceFileName: 'book.txt',
  sourceEncoding: 'utf-8',
  rawText: '',
  normalizedText: '',
  rawTextHash: 'raw-hash',
  normalizedTextHash: 'normalized-hash',
  createdAt: now,
  updatedAt: now,
  totalChapters: 1,
  totalCharacters: 12,
  totalParagraphs: 1,
  coverSeed: 1,
  lastReadOffset: 0,
  lastReadProgress: 0,
  favorite: false,
  analysisStatus: 'not_analyzed',
  activeContentRevisionId: 'revision-1',
};
const chapter: Chapter = {
  id: 'chapter-1',
  novelId: novel.id,
  index: 1,
  title: 'Chapter 1',
  normalizedText: '',
  textHash: 'chapter-hash',
  rawStartOffset: 0,
  rawEndOffset: 12,
  characterCount: 12,
  paragraphCount: 1,
  createdAt: now,
  updatedAt: now,
};
const paragraph: Paragraph = {
  id: 'paragraph-1',
  novelId: novel.id,
  chapterId: chapter.id,
  index: 0,
  text: 'Hello world.',
  startOffsetInChapter: 0,
  endOffsetInChapter: 12,
  textHash: 'paragraph-hash',
};
const page: ParagraphPage = {
  id: 'page-1',
  novelId: novel.id,
  chapterId: chapter.id,
  pageIndex: 0,
  startParagraphIndex: 0,
  endParagraphIndex: 0,
  paragraphs: [paragraph],
  textHash: 'page-hash',
};

function source(): BookContentRevisionHandle {
  return {
    novel,
    contentRevisionId: 'revision-1',
    listChapters: async () => [chapter],
    listParagraphs: async () => [paragraph],
    listParagraphPages: async () => [page],
    async *iterateParagraphPages() {
      yield page;
    },
  };
}

function viewFromSubmit(request: NativeBookWorkflowSubmitRequest, workflowId = 'workflow-1'): NativeBookWorkflowView {
  let sequence = 0;
  return {
    schemaVersion: request.schemaVersion ?? 2,
    id: workflowId,
    idempotencyKey: request.idempotencyKey,
    novelId: request.novelId,
    contentRevision: request.contentRevision,
    planHash: request.planHash,
    payloadHash: 'payload-hash',
    status: 'waiting_for_input',
    currentStage: 'character_graph_bootstrap',
    fence: 1,
    jobs: request.stages.flatMap((stage) =>
      stage.jobs.map((job) => ({
        id: job.id,
        stage: stage.stage,
        sequence: sequence++,
        status: 'waiting_for_input' as const,
        attempt: 0,
        jobType: job.jobType,
        contractFingerprint: job.contractFingerprint,
        errorCode: null,
      })),
    ),
    checkpoints: [],
    readinessOutcome: null,
    reviewItems: [],
    errorCode: null,
    createdAtMs: Date.parse(now),
    updatedAtMs: Date.parse(now),
  };
}

function harness() {
  let currentView: NativeBookWorkflowView | undefined;
  const descriptors = new Map<string, NativeAnalysisWorkflowDescriptor>();
  let submitCount = 0;
  const checkpointOutputs = new Map<string, unknown>();
  const stagedArtifacts = new Map<string, NativeAnalysisStagedOutput>();
  const provenance: NativeAnalysisPromotionProvenance[] = [];
  let storedSegments: LabeledSegment[] = [];
  const finalize = vi.fn(async (request) => {
    currentView = {
      ...currentView!,
      status: request.outcome === 'ready_for_tts' ? 'succeeded' : 'needs_review',
      currentStage: request.outcome === 'ready_for_tts' ? null : currentView!.currentStage,
      readinessOutcome: request.outcome,
      reviewItems: request.reviewItems,
    };
    return currentView;
  });
  const materialize = vi.fn(async (request) => {
    const requestHash = structuredIntegrityHash(request.request);
    currentView = {
      ...currentView!,
      status: 'queued',
      jobs: currentView!.jobs.map((job) =>
        job.id === request.jobId
          ? {
              ...job,
              status: 'queued',
              requestHash,
              providerId: request.request.providerId,
              modelId: request.request.modelId,
            }
          : job,
      ),
    };
    return currentView;
  });
  const requireReview = vi.fn(async (request: NativeBookWorkflowReviewRequest) => {
    currentView = {
      ...currentView!,
      fence: request.expectedFence + 1,
      status: 'needs_review',
      readinessOutcome: 'needs_review',
      reviewItems: request.reviewItems,
      errorCode: request.errorCode,
      jobs: currentView!.jobs.map((job) => (job.status === 'succeeded' ? job : { ...job, status: 'cancelled' })),
    };
    return currentView;
  });
  const prepareLabelMutation = vi.fn(async (request: NativeLabelMutationPrepareRequest) => {
    currentView = {
      ...currentView!,
      fence: request.expectedFence + 1,
      pendingLabelMutation: {
        operationId: request.operationId,
        commandHash: request.commandHash,
        command: request.command,
      },
    };
    return currentView;
  });
  const finalizeLabelMutation = vi.fn(async (request: NativeLabelMutationFinalizeRequest) => {
    currentView = {
      ...currentView!,
      status: request.resumeAfterReview ? 'waiting_for_input' : currentView!.status,
      readinessOutcome: request.resumeAfterReview ? null : currentView!.readinessOutcome,
      reviewItems: request.resumeAfterReview ? [] : currentView!.reviewItems,
      errorCode: request.resumeAfterReview ? null : currentView!.errorCode,
      pendingLabelMutation: undefined,
      lastLabelMutationReceipt: {
        operationId: request.operationId,
        commandHash: request.commandHash,
        receiptHash: request.receiptHash,
      },
      jobs: request.resumeAfterReview
        ? currentView!.jobs.map((job) =>
            job.status === 'cancelled' ? { ...job, status: 'waiting_for_input' as const } : job,
          )
        : currentView!.jobs,
    };
    return currentView;
  });
  const cancel = vi.fn(async (workflowId: string) => {
    if (currentView?.id === workflowId) currentView = { ...currentView, status: 'cancelled' };
    return currentView!;
  });
  const getActive = vi.fn(async () =>
    currentView && !['succeeded', 'cancelled'].includes(currentView.status) ? currentView : undefined,
  );
  const submit = vi.fn(async (request: NativeBookWorkflowSubmitRequest) => {
    submitCount += 1;
    currentView = viewFromSubmit(request, `workflow-${submitCount}`);
    return currentView;
  });
  const bridge: NativeBookWorkflowBridge = {
    submit,
    async get() {
      return currentView!;
    },
    getActive,
    materialize,
    finalize,
    requireReview,
    prepareLabelMutation,
    finalizeLabelMutation,
    async resume() {
      return currentView!;
    },
    cancel,
    async checkpoint(request) {
      const job = currentView!.jobs.find((candidate) => candidate.id === request.jobId)!;
      return {
        workflowId: 'workflow-1',
        jobId: request.jobId,
        requestHash: job.requestHash!,
        outputHash: `output-hash:${request.jobId}`,
        output: checkpointOutputs.get(request.jobId) ?? { invalid: true },
      };
    },
  };
  const repository = {
    openContentRevision: vi.fn(async () => source()),
    saveNativeAnalysisWorkflowDescriptor: vi.fn(async (input: NativeAnalysisWorkflowDescriptorInput) => {
      const descriptor = {
        ...input,
        descriptorFingerprint: 'descriptor-hash',
        createdAt: now,
        updatedAt: now,
      };
      descriptors.set(input.workflowId, descriptor);
      return descriptor;
    }),
    getNativeAnalysisWorkflowDescriptor: vi.fn(async (workflowId) => descriptors.get(workflowId)),
    deleteNativeAnalysisWorkflowDescriptor: vi.fn(async () => true),
    saveNativeAnalysisWorkflowFence: vi.fn(async (input) => ({
      ...input,
      id: `native_analysis_workflow:${input.workflowId}`,
      createdAt: now,
      updatedAt: now,
    })),
    listNativeAnalysisProvenance: vi.fn(async () => provenance),
    getNativeAnalysisStagedOutput: vi.fn(async (artifactId) => stagedArtifacts.get(artifactId)),
    listNativeAnalysisStagedOutputs: vi.fn(async (workflowId) =>
      [...stagedArtifacts.values()].filter((artifact) => artifact.workflowId === workflowId),
    ),
    saveNativeAnalysisReviewDraft: vi.fn(async (input) => {
      const artifact = stagedArtifacts.get(input.artifactId)!;
      const updated: NativeAnalysisStagedOutput = {
        ...artifact,
        reviewDraft: input.candidate,
        reviewEditIntents: input.editIntents,
        reviewRevision: (artifact.reviewRevision ?? 1) + 1,
        reviewStatus: 'editing',
        reviewUpdatedAt: now,
      };
      stagedArtifacts.set(updated.id, updated);
      return updated;
    }),
    rejectNativeAnalysisReview: vi.fn(async (input) => {
      const artifact = stagedArtifacts.get(input.artifactId)!;
      const updated: NativeAnalysisStagedOutput = {
        ...artifact,
        reviewRevision: (artifact.reviewRevision ?? 1) + 1,
        reviewStatus: 'rejected',
        reviewReason: input.reason,
        reviewUpdatedAt: now,
      };
      stagedArtifacts.set(updated.id, updated);
      return updated;
    }),
    promoteNativeAnalysisReview: vi.fn(async (command) => {
      const artifact = stagedArtifacts.get(command.artifactId)!;
      const updated: NativeAnalysisStagedOutput = {
        ...artifact,
        status: 'promoted',
        reviewStatus: 'approved',
        reviewRevision: command.expectedReviewRevision + 1,
        reviewUpdatedAt: command.approvedAt,
        promotedAt: command.approvedAt,
      };
      stagedArtifacts.set(updated.id, updated);
      provenance.push({
        id: `provenance:${artifact.jobId}`,
        artifactId: artifact.id,
        artifactType: artifact.artifactType,
        workflowId: artifact.workflowId,
        jobId: artifact.jobId,
        novelId: artifact.novelId,
        chapterId: artifact.chapterId,
        contentRevisionId: artifact.expectedContentRevisionId,
        workflowFence: artifact.workflowFence,
        planHash: artifact.planHash,
        expectedGraphFingerprint: artifact.expectedGraphFingerprint,
        correctionFingerprint: artifact.correctionFingerprint,
        plannedParagraphIds: artifact.plannedParagraphIds,
        outputHash: artifact.outputHash,
        canonicalOutputFingerprint: artifact.outputHash,
        syncOutboxItemId: `outbox:${artifact.jobId}`,
        syncEventId: `event:${artifact.jobId}`,
        promotedAt: command.approvedAt,
      });
      return {
        operationId: command.operationId,
        revisions: { segmentCollectionRevision: 'segments:reviewed', correctionRevisionId: 'corrections:reviewed' },
        updatedSegmentIds: [],
        createdCorrectionIds: [],
        invalidation: { obsoleteReviewArtifactIds: [], staleTTSRenderItemIds: [] },
        syncEventIds: [`event:${artifact.jobId}`],
      };
    }),
    getNativeAnalysisPromotionSnapshot: vi.fn(async () => ({
      novelId: novel.id,
      activeContentRevisionId: 'revision-1',
      graphFingerprint: 'graph-hash',
      correctionFingerprint: 'correction-hash',
    })),
    stageNativeAnalysisOutput: vi.fn(async (input) => {
      const artifact: NativeAnalysisStagedOutput = {
        ...input,
        id: `artifact:${input.jobId}`,
        status: 'staged',
        createdAt: now,
      };
      stagedArtifacts.set(artifact.id, artifact);
      return artifact;
    }),
    promoteNativeAnalysisOutput: vi.fn(async (artifactId) => {
      const artifact = stagedArtifacts.get(artifactId)!;
      if (artifact.payload.kind === 'label_window') storedSegments = [...artifact.payload.segments];
      const promoted = {
        id: `provenance:${artifact.jobId}`,
        artifactId,
        artifactType: artifact.artifactType,
        workflowId: artifact.workflowId,
        jobId: artifact.jobId,
        novelId: artifact.novelId,
        chapterId: artifact.chapterId,
        contentRevisionId: artifact.expectedContentRevisionId,
        workflowFence: artifact.workflowFence,
        planHash: artifact.planHash,
        expectedGraphFingerprint: artifact.expectedGraphFingerprint,
        correctionFingerprint: artifact.correctionFingerprint,
        plannedParagraphIds: artifact.plannedParagraphIds,
        outputHash: artifact.outputHash,
        canonicalOutputFingerprint: artifact.outputHash,
        syncOutboxItemId: `outbox:${artifact.jobId}`,
        syncEventId: `event:${artifact.jobId}`,
        promotedAt: now,
      };
      provenance.push(promoted);
      return { status: 'promoted', artifact, provenance: promoted };
    }),
    listCharacters: vi.fn(async () => []),
    listCharacterRelations: vi.fn(async () => []),
    listCorrections: vi.fn(async () => []),
    listSegments: vi.fn(async () => storedSegments),
    listVoiceProfiles: vi.fn(async () => []),
  } as unknown as NativeWorkflowReaderRepository;
  return {
    bridge,
    repository,
    submit,
    materialize,
    requireReview,
    cancel,
    finalize,
    prepareLabelMutation,
    finalizeLabelMutation,
    getView: () => currentView!,
    setView: (view: NativeBookWorkflowView) => {
      currentView = view;
    },
    clearDescriptor: () => {
      descriptors.delete('workflow-1');
    },
    completeJob: (jobId: string, output: unknown, nextStage: NativeBookWorkflowView['currentStage']) => {
      const job = currentView!.jobs.find((candidate) => candidate.id === jobId)!;
      checkpointOutputs.set(jobId, output);
      currentView = {
        ...currentView!,
        status: 'waiting_for_input',
        currentStage: nextStage,
        jobs: currentView!.jobs.map((candidate) =>
          candidate.id === jobId ? { ...candidate, status: 'succeeded' } : candidate,
        ),
        checkpoints: [
          ...currentView!.checkpoints,
          {
            jobId,
            stage: job.stage,
            sequence: job.sequence,
            requestHash: job.requestHash!,
            outputHash: `output-hash:${jobId}`,
            completedAtMs: Date.parse(now),
          },
        ],
      };
    },
  };
}

describe('NativeBookAnalysisWorkflowGateway', () => {
  it('pins a local revision, persists the descriptor, and materializes only the first job', async () => {
    const test = harness();
    const gateway = new NativeBookAnalysisWorkflowGateway(test.bridge, test.repository);

    const workflow = await gateway.start({
      bookId: novel.id,
      workflowDefinitionId,
      workflowVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
      providerOptions: { requestProfileId: 'default' },
    });

    expect(workflow.runtime).toBe('native');
    expect(workflow).toMatchObject({ workflowDefinitionId, workflowVersion });
    expect(workflow.status).toBe('queued');
    expect(workflow.readiness.outcome).toBe('pending');
    expect(test.materialize).toHaveBeenCalledTimes(1);
    expect(test.repository.saveNativeAnalysisWorkflowDescriptor).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'workflow-1',
        workflowDefinitionId,
        workflowVersion,
        contentRevisionId: 'revision-1',
        provider: expect.objectContaining({ providerId: 'openai', modelId: 'gpt-test' }),
        labelingContract: expect.objectContaining({
          kind: 'rich_chapter_labeling_v2',
          requestProfileId: 'chapter-labeling-v2-strict-tts',
        }),
      }),
    );
  });

  it('pins compact native execution and materializes its first logical job', async () => {
    const test = harness();
    const gateway = new NativeBookAnalysisWorkflowGateway(test.bridge, test.repository);

    const workflow = await gateway.start({
      bookId: novel.id,
      workflowDefinitionId,
      workflowVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
      providerOptions: { requestProfileId: 'speaker-attribution-v3-compact' },
    });

    expect(workflow.status).toBe('queued');
    expect(test.submit).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 3 }));
    expect(test.materialize).toHaveBeenCalledTimes(1);
    expect(test.repository.saveNativeAnalysisWorkflowDescriptor).toHaveBeenCalledWith(
      expect.objectContaining({
        planHash: test.getView().planHash,
        labelingContract: expect.objectContaining({ kind: 'speaker_attribution_v3' }),
      }),
    );
  });

  it('routes malformed completed checkpoints to a durable review transition', async () => {
    const test = harness();
    const gateway = new NativeBookAnalysisWorkflowGateway(test.bridge, test.repository);
    await gateway.start({
      bookId: novel.id,
      workflowDefinitionId,
      workflowVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
      providerOptions: { requestProfileId: 'chapter-labeling-v1' },
    });
    const firstJob = test.getView().jobs[0];
    test.setView({
      ...test.getView(),
      status: 'waiting_for_input',
      currentStage: 'character_graph_merge',
      jobs: test
        .getView()
        .jobs.map((job) =>
          job.id === firstJob.id ? { ...job, status: 'succeeded', requestHash: 'request-hash' } : job,
        ),
      checkpoints: [
        {
          jobId: firstJob.id,
          stage: firstJob.stage,
          sequence: firstJob.sequence,
          requestHash: 'request-hash',
          outputHash: 'output-hash',
          completedAtMs: Date.parse(now),
        },
      ],
    });

    const workflow = await gateway.get('workflow-1');

    expect(workflow.status).toBe('needs_review');
    expect(workflow.readiness.outcome).toBe('needs_review');
    expect(test.requireReview).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'workflow-1',
        errorCode: 'native_checkpoint_requires_review',
      }),
    );
  });

  it('promotes graph and labels before finalizing explicit local TTS readiness', async () => {
    const test = harness();
    const gateway = new NativeBookAnalysisWorkflowGateway(test.bridge, test.repository);
    await gateway.start({
      bookId: novel.id,
      workflowDefinitionId,
      workflowVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
      providerOptions: { requestProfileId: 'chapter-labeling-v1' },
    });
    const plan = (await test.repository.getNativeAnalysisWorkflowDescriptor('workflow-1'))!.plan;
    const bundleId = plan.bundleWindows[0].id;
    test.completeJob(
      bundleId,
      {
        bundle_id: plan.bundleWindows[0].bundleId,
        source_chapter_ids: [chapter.id],
        new_or_updated_characters: [],
        relations: [],
        bundle_summary_for_next: 'No named characters.',
      },
      'character_graph_merge',
    );
    await gateway.get('workflow-1');
    expect(test.materialize).toHaveBeenCalledTimes(2);

    test.completeJob(
      'character_graph_merge',
      { novel_id: novel.id, graph_version: 1, characters: [], relations: [] },
      'chapter_labeling',
    );
    await gateway.get('workflow-1');
    expect(test.repository.promoteNativeAnalysisOutput).toHaveBeenCalledTimes(1);
    expect(test.materialize).toHaveBeenCalledTimes(3);

    const labelId = plan.labelingWindows[0].id;
    test.completeJob(
      labelId,
      {
        chapter_id: chapter.id,
        analysis_version: 1,
        segments: [
          {
            paragraph_id: paragraph.id,
            start_offset: 0,
            end_offset: paragraph.text.length,
            type: 'narration',
            speaker_id: 'narrator',
            candidate_speakers: [],
            listener_ids: [],
            emotion: 'neutral',
            confidence: 1,
            evidence: 'Narration.',
          },
        ],
      },
      'tts_ready_preparation',
    );
    const workflow = await gateway.get('workflow-1');

    expect(test.repository.promoteNativeAnalysisOutput).toHaveBeenCalledTimes(2);
    expect(test.finalize).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ready_for_tts', reviewItems: [] }));
    expect(workflow.status).toBe('succeeded');
    expect(workflow.readiness.outcome).toBe('ready_for_tts');
  });

  it('retires a reviewed workflow after creating its replacement', async () => {
    const test = harness();
    const gateway = new NativeBookAnalysisWorkflowGateway(test.bridge, test.repository);
    const alternateDefinitionId = 'moya.ai.tts.alternate' as const;
    const alternateVersion = '2.1.0';
    await gateway.start({
      bookId: novel.id,
      workflowDefinitionId: alternateDefinitionId,
      workflowVersion: alternateVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
    });
    test.setView({
      ...test.getView(),
      status: 'needs_review',
      readinessOutcome: 'needs_review',
      reviewItems: [{ id: 'review-1' }],
    });

    const replacement = await gateway.retry('workflow-1');

    expect(replacement.id).toBe('workflow-2');
    expect(test.cancel).toHaveBeenCalledWith('workflow-1');
    expect(replacement.status).not.toBe('cancelled');
    expect(test.repository.saveNativeAnalysisWorkflowDescriptor).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workflowDefinitionId: alternateDefinitionId,
        workflowVersion: alternateVersion,
      }),
    );
  });

  it('leaves an orphaned active journal untouched during read-only discovery', async () => {
    const test = harness();
    const gateway = new NativeBookAnalysisWorkflowGateway(test.bridge, test.repository);
    await gateway.start({
      bookId: novel.id,
      workflowDefinitionId,
      workflowVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
    });
    test.clearDescriptor();

    await expect(gateway.getActive(novel.id)).resolves.toBeUndefined();
    expect(test.cancel).not.toHaveBeenCalled();
  });

  it('retires a failed predecessor when a terminal workflow is force-started', async () => {
    const test = harness();
    const gateway = new NativeBookAnalysisWorkflowGateway(test.bridge, test.repository);
    await gateway.start({
      bookId: novel.id,
      workflowDefinitionId,
      workflowVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
    });
    test.setView({ ...test.getView(), status: 'failed', errorCode: 'provider_failed' });

    const replacement = await gateway.start({
      bookId: novel.id,
      workflowDefinitionId,
      workflowVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
      force: true,
    });

    expect(replacement.id).toBe('workflow-2');
    expect(test.cancel).toHaveBeenCalledWith('workflow-1');
  });

  it('discovers an active descriptor without advancing or mutating the workflow', async () => {
    const test = harness();
    const gateway = new NativeBookAnalysisWorkflowGateway(test.bridge, test.repository);
    await gateway.start({
      bookId: novel.id,
      workflowDefinitionId,
      workflowVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
    });
    const materializeCount = test.materialize.mock.calls.length;

    const restored = await gateway.getActive(novel.id);

    expect(restored?.id).toBe('workflow-1');
    expect(restored).toMatchObject({ workflowDefinitionId, workflowVersion });
    expect(test.materialize).toHaveBeenCalledTimes(materializeCount);
    expect(test.cancel).not.toHaveBeenCalled();
  });

  it('forces a new native workflow when deterministic submit finds an orphaned terminal journal entry', async () => {
    const test = harness();
    const gateway = new NativeBookAnalysisWorkflowGateway(test.bridge, test.repository);
    await gateway.start({
      bookId: novel.id,
      workflowDefinitionId,
      workflowVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
    });
    const orphanedTerminal = { ...test.getView(), status: 'succeeded' as const, currentStage: null };
    test.clearDescriptor();
    test.submit.mockResolvedValueOnce(orphanedTerminal).mockResolvedValueOnce(orphanedTerminal);

    const replacement = await gateway.start({
      bookId: novel.id,
      workflowDefinitionId,
      workflowVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
    });

    expect(replacement.id).toBe('workflow-2');
    expect(test.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyKey: expect.stringContaining(':retry:') }),
    );
  });

  it('persists, approves, and resumes a native chapter-label review through the shared workspace gateway', async () => {
    const test = harness();
    const gateway = new NativeBookAnalysisWorkflowGateway(test.bridge, test.repository);
    await gateway.start({
      bookId: novel.id,
      workflowDefinitionId,
      workflowVersion,
      providerId: 'openai',
      modelId: 'gpt-test',
    });
    const descriptor = (await test.repository.getNativeAnalysisWorkflowDescriptor('workflow-1'))!;
    const window = descriptor.plan.labelingWindows[0]!;
    const segmentTextHash = segmentTextIntegrityHash(paragraph.text);
    const generated: LabeledSegment = {
      id: labeledSegmentId({
        novelId: novel.id,
        chapterId: chapter.id,
        paragraphId: paragraph.id,
        startOffset: 0,
        endOffset: paragraph.text.length,
        segmentTextHash,
      }),
      novelId: novel.id,
      chapterId: chapter.id,
      paragraphId: paragraph.id,
      segmentIndex: 0,
      startOffset: 0,
      endOffset: paragraph.text.length,
      segmentTextHash,
      type: 'narration',
      speakerId: 'unknown',
      candidateSpeakers: [],
      listenerIds: [],
      emotion: 'neutral',
      confidence: 0.5,
      isUserCorrected: false,
    };
    const candidate = { characters: [], segments: [generated] };
    const artifact = await test.repository.stageNativeAnalysisOutput({
      workflowId: 'workflow-1',
      jobId: window.id,
      novelId: novel.id,
      chapterId: chapter.id,
      artifactType: 'label_window',
      workflowFence: test.getView().fence,
      planHash: descriptor.planHash,
      expectedContentRevisionId: descriptor.contentRevisionId,
      expectedGraphFingerprint: 'graph-hash',
      correctionFingerprint: 'correction-hash',
      plannedParagraphIds: window.paragraphIds,
      outputHash: 'output-hash:review',
      payload: { kind: 'label_window', chapterId: chapter.id, segments: [generated], result: candidate },
    });
    await test.bridge.requireReview({
      workflowId: 'workflow-1',
      expectedFence: test.getView().fence,
      errorCode: 'native_checkpoint_requires_review',
      reviewItems: [{ id: `native_validation:${window.id}` }],
    });

    const [open] = await gateway.listReviews('workflow-1');
    expect(open).toMatchObject({ id: artifact.id, status: 'open', reviewRevision: 1 });
    const approvedCandidate = {
      ...candidate,
      segments: [{ ...generated, speakerId: 'narrator', confidence: 1, isUserCorrected: true }],
    };
    const saved = await gateway.saveReviewDraft(artifact.id, 1, approvedCandidate, undefined, {
      [generated.id]: { kind: 'segment_only' },
    });
    expect(saved).toMatchObject({ status: 'editing', reviewRevision: 2 });

    const approved = await gateway.approveReview(artifact.id, 2);

    expect(approved).toMatchObject({ status: 'promoted', reviewRevision: 3 });
    expect(test.prepareLabelMutation).toHaveBeenCalledOnce();
    expect(test.finalizeLabelMutation).toHaveBeenCalledWith(expect.objectContaining({ resumeAfterReview: true }));
    expect(test.getView().status).toBe('waiting_for_input');
    expect(test.getView().reviewItems).toEqual([]);
  });
});
