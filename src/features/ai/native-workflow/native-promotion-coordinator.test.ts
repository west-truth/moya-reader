import { structuredIntegrityHash, textIntegrityHash } from '@noveldesk/text-core/hash';
import { describe, expect, it, vi } from 'vitest';
import { labeledSegmentId } from '../../../domain/identity/ai-identities';
import type { Chapter, LabeledSegment, Paragraph } from '../../../domain/types';
import { planBookAIWorkflow } from '../../../providers/book-ai-workflow-plan';
import type { NativeAnalysisWorkflowDescriptor } from '../../../storage/native-analysis-workflow';
import type { NativeBookWorkflowView, NativeStructuredJsonBatch, NativeWorkflowCheckpointResult } from './contracts';
import { resolveNativeLabelingContract } from './labeling-contract';
import { NativeCheckpointReviewError, promoteCompletedNativeCheckpoints } from './native-promotion-coordinator';
import type { NativeWorkflowDependencyFactory, NativeWorkflowReaderRepository } from './native-workflow-dependencies';

const chapter: Chapter = {
  id: 'chapter_1',
  novelId: 'book_1',
  index: 1,
  title: 'Chapter 1',
  normalizedText: 'Hello',
  textHash: textIntegrityHash('Hello'),
  rawStartOffset: 0,
  rawEndOffset: 5,
  characterCount: 5,
  paragraphCount: 1,
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
};
const paragraph: Paragraph = {
  id: 'paragraph_1',
  novelId: 'book_1',
  chapterId: chapter.id,
  index: 0,
  text: 'Hello',
  textHash: textIntegrityHash('Hello'),
  startOffsetInChapter: 0,
  endOffsetInChapter: 5,
};
const segmentTextHash = textIntegrityHash(paragraph.text);
const segment: LabeledSegment = {
  id: labeledSegmentId({
    novelId: 'book_1',
    chapterId: chapter.id,
    paragraphId: paragraph.id,
    startOffset: 0,
    endOffset: 5,
    segmentTextHash,
  }),
  novelId: 'book_1',
  chapterId: chapter.id,
  paragraphId: paragraph.id,
  segmentIndex: 0,
  startOffset: 0,
  endOffset: 5,
  segmentTextHash,
  type: 'narration',
  speakerId: 'narrator',
  candidateSpeakers: [],
  listenerIds: [],
  emotion: 'neutral',
  confidence: 1,
  isUserCorrected: false,
};

function harness(withRisk: boolean) {
  const plan = planBookAIWorkflow({
    novelId: 'book_1',
    chapters: [chapter],
    paragraphs: [{ ...paragraph, length: paragraph.text.length }],
  });
  const bundleId = plan.bundleWindows[0]!.id;
  const labelId = plan.labelingWindows[0]!.id;
  const batch: NativeStructuredJsonBatch = { version: 'native-structured-json-batch-v1', units: [] };
  const checkpoints: NativeWorkflowCheckpointResult[] = [
    {
      workflowId: 'workflow_1',
      jobId: bundleId,
      requestHash: 'bundle_request',
      outputHash: 'bundle_output',
      output: {},
    },
    {
      workflowId: 'workflow_1',
      jobId: 'character_graph_merge',
      requestHash: 'graph_request',
      outputHash: 'graph_output',
      output: {},
    },
    {
      workflowId: 'workflow_1',
      jobId: labelId,
      requestHash: structuredIntegrityHash(batch),
      outputHash: 'label_output',
      output: { version: 'native-structured-json-batch-result-v1', units: [] },
    },
  ];
  const workflow: NativeBookWorkflowView = {
    schemaVersion: 3,
    id: 'workflow_1',
    idempotencyKey: 'idempotency_1',
    novelId: 'book_1',
    contentRevision: 'revision_1',
    planHash: 'plan_hash_1',
    payloadHash: 'payload_hash_1',
    status: 'waiting_for_input',
    currentStage: 'tts_ready_preparation',
    fence: 1,
    jobs: checkpoints.map((checkpoint, sequence) => ({
      id: checkpoint.jobId,
      stage:
        checkpoint.jobId === bundleId
          ? 'character_graph_bootstrap'
          : checkpoint.jobId === 'character_graph_merge'
            ? 'character_graph_merge'
            : 'chapter_labeling',
      sequence,
      status: 'succeeded',
      attempt: 1,
      requestHash: checkpoint.requestHash,
      errorCode: null,
    })),
    checkpoints: checkpoints.map((checkpoint, sequence) => ({
      jobId: checkpoint.jobId,
      stage:
        checkpoint.jobId === bundleId
          ? 'character_graph_bootstrap'
          : checkpoint.jobId === 'character_graph_merge'
            ? 'character_graph_merge'
            : 'chapter_labeling',
      sequence,
      requestHash: checkpoint.requestHash,
      outputHash: checkpoint.outputHash,
      completedAtMs: sequence,
    })),
    readinessOutcome: null,
    reviewItems: [],
    errorCode: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const descriptor: NativeAnalysisWorkflowDescriptor = {
    workflowId: workflow.id,
    workflowDefinitionId: 'moya.ai.tts.book-preparation',
    workflowVersion: '1.0.0',
    novelId: 'book_1',
    contentRevisionId: 'revision_1',
    planHash: workflow.planHash,
    plan,
    provider: {
      providerId: 'openai',
      modelId: 'test-model',
      providerOptions: { requestProfileId: 'speaker-attribution-v3-compact' },
    },
    labelingContract: resolveNativeLabelingContract({ requestProfileId: 'speaker-attribution-v3-compact' }),
    descriptorFingerprint: 'descriptor_fingerprint',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  };
  const riskRoute = {
    version: 'speaker-risk-route-v1' as const,
    riskClass: 'semantic' as const,
    action: 'independent_escalation_or_review' as const,
    targetSpanIndexes: [0],
    reasonCodes: ['semantic_ambiguity'],
    providerRetryAllowed: false,
    escalationAllowed: true,
    fingerprint: 'risk_fingerprint',
  };
  const compactCheckpoint = {
    source: { chapter, paragraphs: [paragraph], knownCharacters: [], userCorrections: [] },
    materialization: {
      source: { correctionCursor: 'correction_fingerprint' },
      payload: {
        canonicalSource: {
          speakerIdByEntityId: { entity_narrator: 'narrator' },
          spanInventory: {
            spans: [{ id: 'span_1', spanIndex: 0, paragraphId: paragraph.id }],
          },
        },
      },
    },
    aggregation: {
      result: { characters: [], segments: [segment] },
      routedSpanIds: withRisk ? ['span_1'] : [],
      sequenceRecords: [],
      artifactDependencyIds: ['source_fingerprint'],
      speakerProvenanceDrafts: [],
      riskRoutes: withRisk ? [riskRoute] : [],
      metadata: {
        version: 'native-speaker-batch-metadata-v1',
        jobId: labelId,
        packetFingerprints: [],
        requestHashes: [],
        outputHashes: [],
        sequenceDecisionIds: [],
        riskRoutes: withRisk ? [riskRoute] : [],
        routedSpanCount: withRisk ? 1 : 0,
        pendingSpeakerEntityCount: 0,
        speakerProvenanceCount: 0,
        speakerProvenanceFingerprint: 'provenance_fingerprint',
        providerExecutions: [],
      },
    },
  };
  const stageNativeAnalysisOutput = vi.fn(async (input) => ({
    ...input,
    id: `artifact:${input.jobId}`,
    status: 'staged' as const,
    createdAt: '2026-07-13T00:00:00.000Z',
  }));
  const promoteNativeAnalysisOutput = vi.fn(async () => ({ status: 'promoted' as const }));
  const repository = {
    saveNativeAnalysisWorkflowFence: vi.fn(async (input) => input),
    listNativeAnalysisProvenance: vi.fn(async () => [{ workflowId: workflow.id, jobId: 'character_graph_merge' }]),
    getNativeAnalysisPromotionSnapshot: vi.fn(async () => ({
      novelId: 'book_1',
      chapterId: chapter.id,
      activeContentRevisionId: 'revision_1',
      graphFingerprint: 'graph_fingerprint',
      correctionFingerprint: 'correction_fingerprint',
    })),
    stageNativeAnalysisOutput,
    promoteNativeAnalysisOutput,
  } as unknown as NativeWorkflowReaderRepository;
  const dependencies = {
    loaders: {},
    builders: {},
    setCheckpoints: vi.fn(),
    materializeCompactLabeling: vi.fn(async () => ({
      workflowId: workflow.id,
      jobId: labelId,
      expectedFence: workflow.fence,
      batch,
    })),
    speakerBatchResult: vi.fn(async () => compactCheckpoint),
    graphResult: vi.fn(async () => ({ novelId: 'book_1', characters: [], relations: [] })),
  } as unknown as NativeWorkflowDependencyFactory;
  return {
    plan,
    workflow,
    descriptor,
    checkpoints,
    repository,
    dependencies,
    stageNativeAnalysisOutput,
    promoteNativeAnalysisOutput,
  };
}

describe('native compact speaker promotion coordination', () => {
  it('stages the text-free speaker workflow payload before atomic promotion', async () => {
    const test = harness(false);
    await promoteCompletedNativeCheckpoints({
      workflow: test.workflow,
      descriptor: test.descriptor,
      checkpoints: test.checkpoints,
      dependencies: test.dependencies,
      repository: test.repository,
      bridge: {} as never,
    });

    expect(test.stageNativeAnalysisOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          speakerWorkflow: expect.objectContaining({
            version: 'native-speaker-workflow-artifact-v1',
            artifactDependencyIds: ['source_fingerprint'],
            speakerEntityIdByCanonicalSpeakerId: { narrator: 'entity_narrator' },
          }),
        }),
      }),
    );
    expect(test.promoteNativeAnalysisOutput).toHaveBeenCalledTimes(1);
  });

  it('keeps routed speaker risk staged and requires review instead of promotion', async () => {
    const test = harness(true);
    await expect(
      promoteCompletedNativeCheckpoints({
        workflow: test.workflow,
        descriptor: test.descriptor,
        checkpoints: test.checkpoints,
        dependencies: test.dependencies,
        repository: test.repository,
        bridge: {} as never,
      }),
    ).rejects.toMatchObject({
      name: NativeCheckpointReviewError.name,
      reviewItems: [expect.objectContaining({ errorCode: 'native_speaker_risk_requires_review' })],
    });
    expect(test.stageNativeAnalysisOutput).toHaveBeenCalledTimes(1);
    expect(test.promoteNativeAnalysisOutput).not.toHaveBeenCalled();
  });
});
