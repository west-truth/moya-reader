import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { describe, expect, it } from 'vitest';
import type { Chapter, Character, Paragraph } from '../../../domain/types';
import type {
  AnalyzeCharacterBundleInput,
  ChapterLabelingResult,
  CharacterBundleAnalysisResult,
  CharacterGraph,
  LabelChapterSegmentsInput,
  MergeCharacterGraphInput,
} from '../../../providers/ai';
import { planBookAIWorkflow, type BookAIWorkflowPlan } from '../../../providers/book-ai-workflow-plan';
import type {
  NativeBookWorkflowBridge,
  NativeBookWorkflowFinalizeRequest,
  NativeBookWorkflowMaterializeRequest,
  NativeBookWorkflowView,
  NativeStructuredJsonRequest,
  NativeWorkflowCheckpointResult,
  NativeWorkflowCheckpointView,
  NativeWorkflowStage,
} from './contracts';
import {
  buildNativeCompactExecutionManifest,
  buildNativeBookWorkflowSubmitRequest,
  nativeBookWorkflowPlanHash,
  nativeBookWorkflowPlanHashPayload,
  nativeCompactExecutionPlanHashPayload,
} from './manifest';
import {
  orchestrateNextNativeWorkflowStep,
  resumeNativeWorkflow,
  type NativeWorkflowOrchestratorDependencies,
} from './orchestrator';

const CONTENT_REVISION = 'revision_1';

function chapter(index: number): Chapter {
  return {
    id: `chapter_${index}`,
    novelId: 'book_1',
    index,
    title: `Chapter ${index}`,
    normalizedText: `chapter ${index}`,
    textHash: `chapter_hash_${index}`,
    rawStartOffset: 0,
    rawEndOffset: 10,
    characterCount: 10,
    paragraphCount: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

function paragraph(sourceChapter: Chapter): Paragraph {
  return {
    id: `${sourceChapter.id}_paragraph_0`,
    novelId: sourceChapter.novelId,
    chapterId: sourceChapter.id,
    index: 0,
    text: sourceChapter.normalizedText,
    startOffsetInChapter: 0,
    endOffsetInChapter: sourceChapter.normalizedText.length,
    textHash: `${sourceChapter.id}_paragraph_hash_0`,
  };
}

function character(id: string): Character {
  return {
    id,
    novelId: 'book_1',
    canonicalName: id,
    aliases: [],
    color: '#123456',
    confidence: 0.9,
    isUserConfirmed: false,
  };
}

function graph(...characterIds: string[]): CharacterGraph {
  return {
    novelId: 'book_1',
    characters: characterIds.map(character),
    relations: [],
  };
}

function plan(): BookAIWorkflowPlan {
  return planBookAIWorkflow({
    novelId: 'book_1',
    chapters: [chapter(1), chapter(2)],
    options: { maxBundleChapters: 1 },
  });
}

function bundleResult(bundleId: string, summary: string, characterId: string): CharacterBundleAnalysisResult {
  return {
    novelId: 'book_1',
    bundleId,
    sourceChapterIds: [],
    discoveredGraph: graph(characterId),
    bundleSummaryForNext: summary,
  };
}

function labelResult(chapterId: string, summary: string): ChapterLabelingResult {
  return {
    characters: [],
    segments: [],
    episodeContextSummary: {
      chapterId,
      scene: `scene ${chapterId}`,
      activeCharacterIds: ['character_1'],
      unresolved: ['question'],
      summaryForNextChapter: summary,
    },
  };
}

function checkpoint(jobId: string, output: unknown): NativeWorkflowCheckpointResult {
  return {
    workflowId: 'workflow_1',
    jobId,
    requestHash: `request_hash_${jobId}`,
    outputHash: `output_hash_${jobId}`,
    output,
  };
}

function stageForJob(workflowPlan: BookAIWorkflowPlan, jobId: string): NativeWorkflowStage {
  if (workflowPlan.bundleWindows.some((window) => window.id === jobId)) return 'character_graph_bootstrap';
  if (jobId === 'character_graph_merge') return 'character_graph_merge';
  return 'chapter_labeling';
}

function orderedJobIds(workflowPlan: BookAIWorkflowPlan): string[] {
  return [
    ...workflowPlan.bundleWindows.map((window) => window.id),
    'character_graph_merge',
    ...workflowPlan.labelingWindows.map((window) => window.id),
  ];
}

function workflowView(
  workflowPlan: BookAIWorkflowPlan,
  checkpoints: readonly NativeWorkflowCheckpointResult[],
  patch: Partial<NativeBookWorkflowView> = {},
): NativeBookWorkflowView {
  const completedIds = new Set(checkpoints.map((item) => item.jobId));
  const jobs = orderedJobIds(workflowPlan).map((id, sequence) => ({
    id,
    stage: stageForJob(workflowPlan, id),
    sequence,
    status: completedIds.has(id) ? ('succeeded' as const) : ('waiting_for_input' as const),
    attempt: completedIds.has(id) ? 1 : 0,
    ...(completedIds.has(id)
      ? {
          requestHash: `request_hash_${id}`,
          providerId: 'test-provider',
          modelId: 'test-model',
        }
      : {}),
    errorCode: null,
  }));
  const checkpointViews: NativeWorkflowCheckpointView[] = checkpoints.map((item) => {
    const sequence = jobs.find((job) => job.id === item.jobId)?.sequence ?? -1;
    return {
      jobId: item.jobId,
      stage: stageForJob(workflowPlan, item.jobId),
      sequence,
      requestHash: item.requestHash,
      outputHash: item.outputHash,
      completedAtMs: sequence + 1,
    };
  });
  const nextJob = jobs.find((job) => job.status === 'waiting_for_input');
  return {
    schemaVersion: 2,
    id: 'workflow_1',
    idempotencyKey: 'idempotency_1',
    novelId: workflowPlan.novelId,
    contentRevision: CONTENT_REVISION,
    planHash: nativeBookWorkflowPlanHash(workflowPlan, CONTENT_REVISION),
    payloadHash: 'payload_hash',
    status: 'waiting_for_input',
    currentStage: nextJob?.stage ?? 'tts_ready_preparation',
    fence: 7,
    jobs,
    checkpoints: checkpointViews,
    readinessOutcome: null,
    reviewItems: [],
    errorCode: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    ...patch,
  };
}

function structuredRequest(prompt: string): NativeStructuredJsonRequest {
  return {
    providerId: 'test-provider',
    modelId: 'test-model',
    prompt,
    responseSchema: { type: 'object' },
    jsonSchemaName: 'test_result',
    providerOptions: {},
  };
}

function bridgeHarness(view: NativeBookWorkflowView, checkpoints: readonly NativeWorkflowCheckpointResult[]) {
  const materialized: NativeBookWorkflowMaterializeRequest[] = [];
  const finalized: NativeBookWorkflowFinalizeRequest[] = [];
  const checkpointRequests: string[] = [];
  const resumeRequests: string[] = [];
  const checkpointMap = new Map(checkpoints.map((item) => [item.jobId, item]));
  const bridge: NativeBookWorkflowBridge = {
    async submit() {
      return view;
    },
    async get() {
      return view;
    },
    async getActive() {
      return view;
    },
    async materialize(request) {
      materialized.push(request);
      return view;
    },
    async finalize(request) {
      finalized.push(request);
      return {
        ...view,
        status: request.outcome === 'ready_for_tts' ? 'succeeded' : 'needs_review',
        readinessOutcome: request.outcome,
        reviewItems: request.reviewItems,
      };
    },
    async requireReview(request) {
      finalized.push({
        workflowId: request.workflowId,
        expectedFence: request.expectedFence,
        outcome: 'needs_review',
        reviewItems: request.reviewItems,
      });
      return {
        ...view,
        status: 'needs_review',
        readinessOutcome: 'needs_review',
        reviewItems: request.reviewItems,
      };
    },
    async resume(workflowId) {
      resumeRequests.push(workflowId);
      return view.status === 'failed' ? { ...view, status: 'queued' } : view;
    },
    async cancel() {
      return { ...view, status: 'cancelled' };
    },
    async checkpoint(request) {
      checkpointRequests.push(request.jobId);
      const result = checkpointMap.get(request.jobId);
      if (!result) throw new Error(`Missing test checkpoint: ${request.jobId}`);
      return result;
    },
  };
  return { bridge, materialized, finalized, checkpointRequests, resumeRequests };
}

function dependencies(
  bridge: NativeBookWorkflowBridge,
  captures: {
    bundleInputs: AnalyzeCharacterBundleInput[];
    mergeInputs: MergeCharacterGraphInput[];
    labelingInputs: LabelChapterSegmentsInput[];
  },
): NativeWorkflowOrchestratorDependencies {
  const chapters = new Map([chapter(1), chapter(2)].map((item) => [item.id, item]));
  return {
    bridge,
    loaders: {
      loadBundleSource(window) {
        return {
          chapters: window.chapterIds.map((chapterId) => {
            const sourceChapter = chapters.get(chapterId);
            if (!sourceChapter) throw new Error(`Missing chapter: ${chapterId}`);
            return { chapter: sourceChapter, paragraphs: [paragraph(sourceChapter)] };
          }),
        };
      },
      loadGraphMergeSource() {
        return { existingGraph: graph('existing_character') };
      },
      loadLabelingSource(window) {
        const sourceChapter = chapters.get(window.chapterId);
        if (!sourceChapter) throw new Error(`Missing chapter: ${window.chapterId}`);
        return { chapter: sourceChapter, paragraphs: [paragraph(sourceChapter)] };
      },
      loadBundleCheckpoint(checkpointResult) {
        return checkpointResult.output as CharacterBundleAnalysisResult;
      },
      loadGraphCheckpoint(checkpointResult) {
        return checkpointResult.output as CharacterGraph;
      },
      loadLabelingCheckpoint(checkpointResult) {
        return checkpointResult.output as ChapterLabelingResult;
      },
    },
    builders: {
      buildBundleRequest(input) {
        captures.bundleInputs.push(input);
        return structuredRequest(`bundle:${input.bundleId}`);
      },
      buildGraphMergeRequest(input) {
        captures.mergeInputs.push(input);
        return structuredRequest('merge');
      },
      buildLabelingRequest(input) {
        captures.labelingInputs.push(input);
        return structuredRequest(`label:${input.chapter.id}`);
      },
    },
    evaluateFinalization() {
      return { outcome: 'ready_for_tts', reviewItems: [] };
    },
  };
}

function captures() {
  return {
    bundleInputs: [] as AnalyzeCharacterBundleInput[],
    mergeInputs: [] as MergeCharacterGraphInput[],
    labelingInputs: [] as LabelChapterSegmentsInput[],
  };
}

describe('native workflow manifest', () => {
  it('builds the canonical four-stage request and hashes only the v2 plan identity payload', () => {
    const workflowPlan = plan();
    const request = buildNativeBookWorkflowSubmitRequest({ plan: workflowPlan, contentRevision: CONTENT_REVISION });
    const payload = nativeBookWorkflowPlanHashPayload(workflowPlan, CONTENT_REVISION);

    expect(request.planHash).toBe(
      structuredIntegrityHash({
        schemaVersion: 2,
        novelId: 'book_1',
        contentRevision: CONTENT_REVISION,
        stages: payload.stages,
      }),
    );
    expect(request.idempotencyKey).toBe(request.planHash);
    expect(request).not.toHaveProperty('schemaVersion');
    expect(request.stages.map((stage) => stage.stage)).toEqual([
      'character_graph_bootstrap',
      'character_graph_merge',
      'chapter_labeling',
      'tts_ready_preparation',
    ]);
    expect(request.stages[0].jobs.every((job) => job.request === undefined)).toBe(true);
    expect(request.stages[1].jobs.map((job) => job.id)).toEqual(['character_graph_merge']);
    expect(request.stages[3].jobs).toEqual([]);
    expect(request.stages.flatMap((stage) => stage.jobs).every((job) => job.jobType === undefined)).toBe(true);

    const firstJobId = request.stages[0].jobs[0].id;
    const requestWithMaterializedJob = buildNativeBookWorkflowSubmitRequest({
      plan: workflowPlan,
      contentRevision: CONTENT_REVISION,
      requestsByJobId: { [firstJobId]: structuredRequest('first bundle') },
    });
    expect(requestWithMaterializedJob.planHash).toBe(request.planHash);
    expect(requestWithMaterializedJob.stages[0].jobs[0].request).toEqual(structuredRequest('first bundle'));
  });

  it('hashes compact execution job identities and contract fingerprints in schema v3', () => {
    const workflowPlan = plan();
    const contractFingerprint = 'sha256:compact-contract';
    const compactExecutionManifest = buildNativeCompactExecutionManifest(workflowPlan, contractFingerprint);
    const request = buildNativeBookWorkflowSubmitRequest({
      plan: workflowPlan,
      contentRevision: CONTENT_REVISION,
      compactExecutionManifest,
    });
    const payload = nativeCompactExecutionPlanHashPayload({
      plan: workflowPlan,
      contentRevision: CONTENT_REVISION,
      manifest: compactExecutionManifest,
    });

    expect(request.schemaVersion).toBe(3);
    expect(request.planHash).toBe(structuredIntegrityHash(payload));
    expect(request.stages[2].jobs[0]).toMatchObject({
      id: workflowPlan.labelingWindows[0].id,
      jobType: 'speaker_attribution_v3',
      contractFingerprint,
    });

    const tampered = structuredClone(compactExecutionManifest);
    (tampered.stages[2].jobs[0] as { contractFingerprint: string }).contractFingerprint = 'sha256:tampered-contract';
    expect(
      buildNativeBookWorkflowSubmitRequest({
        plan: workflowPlan,
        contentRevision: CONTENT_REVISION,
        compactExecutionManifest: tampered,
      }).planHash,
    ).not.toBe(request.planHash);

    const packetJobs = structuredClone(compactExecutionManifest);
    (packetJobs.stages[2].jobs[0] as { id: string }).id = `${workflowPlan.labelingWindows[0].id}:packet-1`;
    expect(() =>
      buildNativeBookWorkflowSubmitRequest({
        plan: workflowPlan,
        contentRevision: CONTENT_REVISION,
        compactExecutionManifest: packetJobs,
      }),
    ).toThrow(/logical plan windows/i);
  });
});

describe('native workflow materialization', () => {
  it('hands bundle N the prior summary and hands graph merge every bundle graph', async () => {
    const workflowPlan = plan();
    const firstBundle = bundleResult(workflowPlan.bundleWindows[0].id, 'summary one', 'bundle_character_1');
    const secondBundle = bundleResult(workflowPlan.bundleWindows[1].id, 'summary two', 'bundle_character_2');
    const firstCheckpoint = checkpoint(workflowPlan.bundleWindows[0].id, firstBundle);
    const secondCheckpoint = checkpoint(workflowPlan.bundleWindows[1].id, secondBundle);

    const bundleBridge = bridgeHarness(workflowView(workflowPlan, [firstCheckpoint]), [firstCheckpoint]);
    const bundleCaptures = captures();
    const bundleStep = await orchestrateNextNativeWorkflowStep({
      plan: workflowPlan,
      contentRevision: CONTENT_REVISION,
      workflow: workflowView(workflowPlan, [firstCheckpoint]),
      checkpoints: [firstCheckpoint],
      dependencies: dependencies(bundleBridge.bridge, bundleCaptures),
    });

    expect(bundleStep).toMatchObject({
      kind: 'materialized',
      stage: 'character_graph_bootstrap',
      jobId: workflowPlan.bundleWindows[1].id,
    });
    expect(bundleCaptures.bundleInputs).toHaveLength(1);
    expect(bundleCaptures.bundleInputs[0].previousBundleSummary).toBe('summary one');
    expect(bundleBridge.materialized).toHaveLength(1);

    const mergeCheckpoints = [firstCheckpoint, secondCheckpoint];
    const mergeBridge = bridgeHarness(workflowView(workflowPlan, mergeCheckpoints), mergeCheckpoints);
    const mergeCaptures = captures();
    const mergeStep = await orchestrateNextNativeWorkflowStep({
      plan: workflowPlan,
      contentRevision: CONTENT_REVISION,
      workflow: workflowView(workflowPlan, mergeCheckpoints),
      checkpoints: mergeCheckpoints,
      dependencies: dependencies(mergeBridge.bridge, mergeCaptures),
    });

    expect(mergeStep).toMatchObject({ kind: 'materialized', stage: 'character_graph_merge' });
    expect(mergeCaptures.mergeInputs[0].discoveredGraph.characters.map((item) => item.id)).toEqual([
      'bundle_character_1',
      'bundle_character_2',
    ]);
    expect(mergeCaptures.mergeInputs[0].sourceContext?.summary).toBe('summary one\nsummary two');
  });

  it('hands the second labeling window the merged graph and prior Episode Context', async () => {
    const workflowPlan = plan();
    const mergedGraph = graph('merged_character');
    const priorLabel = labelResult(workflowPlan.labelingWindows[0].chapterId, 'episode handoff');
    const priorCheckpoints = [
      checkpoint(workflowPlan.bundleWindows[0].id, bundleResult(workflowPlan.bundleWindows[0].id, 'one', 'c1')),
      checkpoint(workflowPlan.bundleWindows[1].id, bundleResult(workflowPlan.bundleWindows[1].id, 'two', 'c2')),
      checkpoint('character_graph_merge', mergedGraph),
      checkpoint(workflowPlan.labelingWindows[0].id, priorLabel),
    ];
    const harness = bridgeHarness(workflowView(workflowPlan, priorCheckpoints), priorCheckpoints);
    const inputCaptures = captures();

    const result = await orchestrateNextNativeWorkflowStep({
      plan: workflowPlan,
      contentRevision: CONTENT_REVISION,
      workflow: workflowView(workflowPlan, priorCheckpoints),
      checkpoints: priorCheckpoints,
      dependencies: dependencies(harness.bridge, inputCaptures),
    });

    expect(result).toMatchObject({
      kind: 'materialized',
      stage: 'chapter_labeling',
      jobId: workflowPlan.labelingWindows[1].id,
    });
    expect(inputCaptures.labelingInputs).toHaveLength(1);
    expect(inputCaptures.labelingInputs[0].characterGraph).toEqual(mergedGraph);
    expect(inputCaptures.labelingInputs[0].previousEpisodeContext).toMatchObject({
      chapterId: workflowPlan.labelingWindows[0].chapterId,
      summary: 'episode handoff',
      activeCharacterIds: ['character_1'],
      unresolved: ['question'],
      version: 'episode-context-v2',
      scene: `scene ${workflowPlan.labelingWindows[0].chapterId}`,
      recentTurns: [],
      unresolvedReferences: ['question'],
      sourceWindowId: workflowPlan.labelingWindows[0].id,
    });
  });

  it('detects plan hash drift before loading input or crossing the bridge', async () => {
    const workflowPlan = plan();
    const driftedPlan = planBookAIWorkflow({
      novelId: 'book_1',
      chapters: [{ ...chapter(1), textHash: 'changed_chapter_hash' }, chapter(2)],
      options: { maxBundleChapters: 1 },
    });
    const view = workflowView(workflowPlan, []);
    const harness = bridgeHarness(view, []);
    const inputCaptures = captures();

    const result = await orchestrateNextNativeWorkflowStep({
      plan: driftedPlan,
      contentRevision: CONTENT_REVISION,
      workflow: view,
      checkpoints: [],
      dependencies: dependencies(harness.bridge, inputCaptures),
    });

    expect(result).toEqual({
      kind: 'plan_drift',
      expectedPlanHash: nativeBookWorkflowPlanHash(driftedPlan, CONTENT_REVISION),
      actualPlanHash: nativeBookWorkflowPlanHash(workflowPlan, CONTENT_REVISION),
    });
    expect(harness.materialized).toEqual([]);
    expect(inputCaptures.bundleInputs).toEqual([]);
    expect(nativeBookWorkflowPlanHash(workflowPlan, CONTENT_REVISION)).not.toBe(
      nativeBookWorkflowPlanHash(workflowPlan, 'revision_2'),
    );
  });

  it('restarts from durable checkpoints and materializes only the next job', async () => {
    const workflowPlan = plan();
    const firstCheckpoint = checkpoint(
      workflowPlan.bundleWindows[0].id,
      bundleResult(workflowPlan.bundleWindows[0].id, 'restart summary', 'restart_character'),
    );
    const view = workflowView(workflowPlan, [firstCheckpoint]);
    const harness = bridgeHarness(view, [firstCheckpoint]);
    const inputCaptures = captures();

    const result = await resumeNativeWorkflow({
      workflowId: view.id,
      plan: workflowPlan,
      contentRevision: CONTENT_REVISION,
      dependencies: dependencies(harness.bridge, inputCaptures),
    });

    expect(harness.checkpointRequests).toEqual([workflowPlan.bundleWindows[0].id]);
    expect(harness.resumeRequests).toEqual([view.id]);
    expect(harness.materialized.map((request) => request.jobId)).toEqual([workflowPlan.bundleWindows[1].id]);
    expect(inputCaptures.bundleInputs[0].previousBundleSummary).toBe('restart summary');
    expect(result.kind).toBe('materialized');
  });

  it('requeues a failed Rust workflow before orchestrating another step', async () => {
    const workflowPlan = plan();
    const view = workflowView(workflowPlan, [], { status: 'failed' });
    const harness = bridgeHarness(view, []);
    const result = await resumeNativeWorkflow({
      workflowId: view.id,
      plan: workflowPlan,
      contentRevision: CONTENT_REVISION,
      dependencies: dependencies(harness.bridge, captures()),
    });

    expect(harness.resumeRequests).toEqual([view.id]);
    expect(result).toEqual({ kind: 'idle', status: 'queued' });
  });

  it('routes a completed schema-v1 workflow to review instead of trusting its legacy plan hash', async () => {
    const workflowPlan = plan();
    const view = workflowView(workflowPlan, [], {
      schemaVersion: 1,
      planHash: 'sha256:legacy-plan',
      currentStage: 'tts_ready_preparation',
      jobs: [],
      checkpoints: [],
    });
    const harness = bridgeHarness(view, []);
    const result = await orchestrateNextNativeWorkflowStep({
      plan: workflowPlan,
      contentRevision: CONTENT_REVISION,
      workflow: view,
      checkpoints: [],
      dependencies: dependencies(harness.bridge, captures()),
    });

    expect(result.kind).toBe('finalized');
    expect(harness.finalized[0]).toMatchObject({ outcome: 'needs_review' });
  });

  it('sends a needs-review finalization request after the complete checkpoint prefix', async () => {
    const workflowPlan = plan();
    const outputs: unknown[] = [
      bundleResult(workflowPlan.bundleWindows[0].id, 'one', 'c1'),
      bundleResult(workflowPlan.bundleWindows[1].id, 'two', 'c2'),
      graph('merged'),
      labelResult(workflowPlan.labelingWindows[0].chapterId, 'label one'),
      labelResult(workflowPlan.labelingWindows[1].chapterId, 'label two'),
    ];
    const allCheckpoints = orderedJobIds(workflowPlan).map((jobId, index) => checkpoint(jobId, outputs[index]));
    const view = workflowView(workflowPlan, allCheckpoints);
    const harness = bridgeHarness(view, allCheckpoints);
    const orchestratorDependencies: NativeWorkflowOrchestratorDependencies = {
      ...dependencies(harness.bridge, captures()),
      evaluateFinalization: () => ({
        outcome: 'needs_review',
        reviewItems: [{ code: 'tts_readiness_failed' }],
      }),
    };

    const result = await orchestrateNextNativeWorkflowStep({
      plan: workflowPlan,
      contentRevision: CONTENT_REVISION,
      workflow: view,
      checkpoints: allCheckpoints,
      dependencies: orchestratorDependencies,
    });

    expect(harness.finalized).toEqual([
      {
        workflowId: view.id,
        expectedFence: view.fence,
        outcome: 'needs_review',
        reviewItems: [{ code: 'tts_readiness_failed' }],
      },
    ]);
    expect(result).toMatchObject({ kind: 'finalized', workflow: { status: 'needs_review' } });
    expect(harness.materialized).toEqual([]);
  });
});
