import pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisInputRevision } from '../book-ai-workflow/analysis-input-contracts.js';
import { ProviderJobCancelledError, type ProviderJobRow } from './contracts.js';
import { testConfig } from './provider-job-test-harness.js';

const dependencies = vi.hoisted(() => ({
  assertPinnedPayload: vi.fn(),
  assertPinnedProfile: vi.fn(),
  verifyInput: vi.fn(),
  updateProgress: vi.fn(),
  assertNotCancelled: vi.fn(),
  lockForPersistence: vi.fn(),
  expand: vi.fn(),
  routeRisks: vi.fn(),
  selectEscalation: vi.fn(),
  compareEscalation: vi.fn(),
  validate: vi.fn(),
  quality: vi.fn(),
  reviewProfile: vi.fn(),
  stageArtifact: vi.fn(),
  ensureReview: vi.fn(),
  replaceSequenceDecisions: vi.fn(),
  putDependencies: vi.fn(),
  createDependency: vi.fn(),
  persistResult: vi.fn(),
  projectProvenance: vi.fn(),
  provenanceFingerprint: vi.fn(),
}));

vi.mock('../../../../../src/providers/speaker-attribution/workflow-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../src/providers/speaker-attribution/workflow-contract')>()),
  assertSpeakerAttributionPinnedPayload: dependencies.assertPinnedPayload,
}));

vi.mock('../book-ai-workflow/analysis-input-verification.js', () => ({
  assertPinnedRequestProfile: dependencies.assertPinnedProfile,
  verifyAnalysisInputBeforeExecution: dependencies.verifyInput,
}));

vi.mock('./job-lifecycle.js', () => ({
  updateProviderJobProgress: dependencies.updateProgress,
  assertProviderJobNotCancelled: dependencies.assertNotCancelled,
  lockProviderJobForPersistence: dependencies.lockForPersistence,
}));

vi.mock('../../../../../src/providers/speaker-attribution/canonical-batch-expander', () => ({
  expandSpeakerAttributionBatchToCanonicalLabels: dependencies.expand,
}));

vi.mock('../../../../../src/providers/speaker-attribution/speaker-provenance-projection', () => ({
  projectSpeakerSegmentProvenanceDrafts: dependencies.projectProvenance,
  speakerSegmentProvenanceDraftsFingerprint: dependencies.provenanceFingerprint,
}));

vi.mock('../../../../../src/providers/speaker-attribution/routing', () => ({
  routeSpeakerRisks: dependencies.routeRisks,
  selectIndependentEscalationTargets: dependencies.selectEscalation,
  compareIndependentSpeakerEscalation: dependencies.compareEscalation,
}));

vi.mock('../../../../../src/providers/chapter-labeling-validator', () => ({
  validateChapterLabelingResult: dependencies.validate,
}));

vi.mock('../../../../../src/providers/chapter-labeling-quality', () => ({
  validateChapterLabelingQuality: dependencies.quality,
}));

vi.mock('../book-ai-workflow/analysis-review-source.js', () => ({
  analysisReviewRequestProfile: dependencies.reviewProfile,
}));

vi.mock('../book-ai-workflow/staging-artifact-repository.js', () => ({
  stageAnalysisArtifact: dependencies.stageArtifact,
}));

vi.mock('../book-ai-workflow/analysis-review-repository.js', () => ({
  ensureChapterLabelAnalysisReview: dependencies.ensureReview,
}));

vi.mock('../speaker-workflow-state-service.js', () => ({
  replaceHostedSpeakerSequenceDecisions: dependencies.replaceSequenceDecisions,
  putHostedSpeakerArtifactDependencies: dependencies.putDependencies,
}));

vi.mock('../../../../../src/providers/speaker-attribution/artifact-dependency', () => ({
  createSpeakerArtifactDependency: dependencies.createDependency,
}));

vi.mock('./result-persistence.js', () => ({
  persistChapterLabelingResult: dependencies.persistResult,
}));

import { processSpeakerAttributionJob } from './speaker-attribution-handler.js';

function providerJob(): ProviderJobRow {
  return {
    id: 'speaker_job_1',
    user_id: 'user_1',
    book_id: 'book_1',
    chapter_id: 'chapter_1',
    job_type: 'speaker_attribution_v3',
    provider_id: 'mock',
    model_id: 'mock-speaker-v1',
    input_hash: 'input_hash_1',
    status: 'running',
    progress: {},
    current_attempt_id: 'attempt_1',
    execution: {
      attemptId: 'attempt_1',
      bullmqJobId: 'bullmq_attempt_1',
      attemptGeneration: 1,
      leaseOwner: 'worker_1',
      leaseTokenHash: 'lease_hash_1',
    },
  };
}

function inputRevision(): AnalysisInputRevision {
  const paragraph = {
    id: 'paragraph_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    index: 0,
    text: 'Narration.',
    startOffsetInChapter: 0,
    endOffsetInChapter: 10,
    textHash: 'paragraph_hash_1',
  };
  const chapter = {
    id: 'chapter_1',
    novelId: 'book_1',
    index: 1,
    title: 'Chapter 1',
    normalizedText: paragraph.text,
    textHash: 'chapter_hash_1',
    rawStartOffset: 0,
    rawEndOffset: 10,
    characterCount: 10,
    paragraphCount: 1,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  };
  return {
    id: 'input_revision_1',
    providerJobId: 'speaker_job_1',
    workflowId: 'workflow_1',
    userId: 'user_1',
    bookId: 'book_1',
    chapterId: 'chapter_1',
    jobType: 'speaker_attribution_v3',
    contentRevisionId: 'content_revision_1',
    contentRevisionNumber: 1,
    revisionFence: 1,
    normalizedTextHash: 'normalized_hash_1',
    characterGraphFingerprint: 'graph_hash_1',
    correctionFingerprint: 'correction_hash_1',
    requestProfile: {
      id: 'speaker-attribution-v3-compact',
      promptVersion: 'speaker-attributor-v4-readable-v1',
      schemaVersion: 'speaker-wire-v2',
    },
    providerId: 'mock',
    modelId: 'mock-speaker-v1',
    providerOptionsFingerprint: 'provider_options_hash_1',
    providerOptions: {},
    windowSpec: {
      windowId: 'window_1',
      sequence: 0,
      chapterAnchors: [{ chapterId: 'chapter_1', chapterIndex: 1, textHash: 'chapter_hash_1' }],
      paragraphAnchors: [
        { paragraphId: 'paragraph_1', chapterId: 'chapter_1', paragraphIndex: 0, textHash: 'paragraph_hash_1' },
      ],
    },
    sourceSnapshot: {
      kind: 'speaker_attribution_v3',
      contract: 'speaker-attribution-workflow-v3',
      sourceManifestFingerprint: 'source_manifest_hash_1',
      spanInventoryHash: 'span_inventory_hash_1',
      mentionInventoryHash: 'mention_inventory_hash_1',
      candidateMemoryHash: 'candidate_memory_hash_1',
      addressEventRevision: 'address_revision_1',
      temporalSnapshotHash: 'temporal_snapshot_hash_1',
      dialogueBurstInventoryHash: 'burst_hash_1',
      sieveVersion: 'deterministic-speaker-sieve-v2',
      sequenceDecoderVersion: 'dialogue-sequence-decision-v1',
      units: [],
      canonicalSource: {
        chapter,
        paragraphs: [paragraph],
        sourceParagraphs: [
          {
            paragraphId: paragraph.id,
            chapterId: paragraph.chapterId,
            paragraphIndex: paragraph.index,
            text: paragraph.text,
            textHash: paragraph.textHash,
            startOffsetInChapter: 0,
            endOffsetInChapter: 10,
          },
        ],
        characters: [],
        spanInventory: {
          spans: [{ id: 'span_1', paragraphId: 'paragraph_1', spanIndex: 0 }],
        },
        sieve: { decisions: [] },
        speakerIdByEntityId: {},
      },
      coversFullChapter: true,
      finalWindowForChapter: true,
    } as never,
    graphSnapshot: { novelId: 'book_1', characters: [], relations: [] },
    correctionsSnapshot: [],
    inputHash: 'input_hash_1',
    createdAt: '2026-07-13T00:00:00.000Z',
  };
}

function transactionPool() {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql.trim().replace(/\s+/g, ' '));
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as pg.Pool;
  return { pool, client, statements };
}

beforeEach(() => {
  vi.resetAllMocks();
  dependencies.verifyInput.mockResolvedValue(undefined);
  dependencies.updateProgress.mockResolvedValue(true);
  dependencies.assertNotCancelled.mockResolvedValue(undefined);
  dependencies.lockForPersistence.mockResolvedValue(undefined);
  dependencies.routeRisks.mockReturnValue([]);
  dependencies.selectEscalation.mockReturnValue([]);
  dependencies.expand.mockReturnValue({
    result: {
      characters: [],
      segments: [],
      episodeContextSummary: { scene: '', activeCharacters: [], unresolved: [] },
      uncertainties: [],
      segmentAnnotations: {},
    },
    routedSpanIds: ['span_1'],
    pendingSpeakerEntities: [],
  });
  dependencies.validate.mockReturnValue({ ok: true, issues: [], summary: { errorCount: 0, warningCount: 0 } });
  dependencies.quality.mockReturnValue({ ok: true, issues: [], summary: { issueCount: 0 } });
  dependencies.reviewProfile.mockReturnValue({ validationPolicy: 'legacy' });
  dependencies.stageArtifact.mockResolvedValue({ id: 'artifact_1' });
  dependencies.ensureReview.mockResolvedValue({ id: 'review_1' });
  dependencies.replaceSequenceDecisions.mockResolvedValue(undefined);
  dependencies.putDependencies.mockResolvedValue(undefined);
  dependencies.createDependency.mockReturnValue({ id: 'dependency_1' });
  dependencies.projectProvenance.mockReturnValue([]);
  dependencies.provenanceFingerprint.mockReturnValue('speaker_provenance_hash_1');
});

describe('compact speaker review persistence fences', () => {
  it('does not open a review when cancellation is observed before the transaction', async () => {
    const job = providerJob();
    const { pool } = transactionPool();
    dependencies.assertNotCancelled.mockRejectedValueOnce(new ProviderJobCancelledError(job.id));

    await expect(
      processSpeakerAttributionJob(pool, testConfig(), job, {}, undefined, inputRevision()),
    ).rejects.toBeInstanceOf(ProviderJobCancelledError);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(dependencies.stageArtifact).not.toHaveBeenCalled();
    expect(dependencies.ensureReview).not.toHaveBeenCalled();
  });

  it('rolls back before staging when the provider-attempt lease is lost at the persistence lock', async () => {
    const job = providerJob();
    const { pool, statements } = transactionPool();
    dependencies.lockForPersistence.mockRejectedValueOnce(new ProviderJobCancelledError(job.id));

    await expect(
      processSpeakerAttributionJob(pool, testConfig(), job, {}, undefined, inputRevision()),
    ).rejects.toBeInstanceOf(ProviderJobCancelledError);

    expect(statements).toEqual(['begin', 'rollback']);
    expect(dependencies.stageArtifact).not.toHaveBeenCalled();
    expect(dependencies.ensureReview).not.toHaveBeenCalled();
  });

  it('applies the terminal success update through the same transaction and rolls back when it loses the fence', async () => {
    const job = providerJob();
    const { pool, client, statements } = transactionPool();
    dependencies.updateProgress.mockImplementation(async (_queryable, _job, patch) => patch.status !== 'succeeded');

    await expect(
      processSpeakerAttributionJob(pool, testConfig(), job, {}, undefined, inputRevision()),
    ).rejects.toBeInstanceOf(ProviderJobCancelledError);

    expect(dependencies.lockForPersistence).toHaveBeenCalledWith(client, job);
    expect(dependencies.updateProgress).toHaveBeenCalledWith(
      client,
      job,
      expect.objectContaining({
        status: 'succeeded',
        mergeProgress: expect.objectContaining({
          manualReview: expect.objectContaining({ status: 'open', reviewArtifactId: 'review_1' }),
        }),
      }),
    );
    expect(statements.at(-1)).toBe('rollback');
    expect(statements).not.toContain('commit');
    expect(dependencies.stageArtifact.mock.invocationCallOrder[0]).toBeGreaterThan(
      dependencies.lockForPersistence.mock.invocationCallOrder[0]!,
    );
  });
});
