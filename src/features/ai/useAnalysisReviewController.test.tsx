import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ChapterLabelAnalysisReviewArtifact } from '../../providers/analysis-review';
import type { BookAnalysisWorkflow, BookAnalysisWorkflowGateway } from './book-analysis-workflow-gateway';
import { useAnalysisReviewController } from './useAnalysisReviewController';

const candidate: ChapterLabelAnalysisReviewArtifact['candidate'] = {
  characters: [],
  segments: [],
};

function artifact(): ChapterLabelAnalysisReviewArtifact {
  return {
    id: 'review-1',
    workflowId: 'workflow-1',
    providerJobId: 'job-1',
    inputRevisionId: 'revision-1',
    stagingArtifactId: 'artifact-1',
    reviewKind: 'chapter_labeling',
    windowId: 'window-1',
    chapterId: 'chapter-1',
    chapter: {
      id: 'chapter-1',
      novelId: 'book-1',
      index: 0,
      title: '1화',
      normalizedText: '',
      textHash: 'chapter-hash',
      characterCount: 0,
      paragraphCount: 0,
      rawStartOffset: 0,
      rawEndOffset: 0,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    },
    paragraphs: [],
    haloParagraphs: [],
    characterOptions: [],
    candidate,
    candidateHash: 'candidate-hash',
    originalCandidate: candidate,
    originalCandidateHash: 'candidate-hash',
    editIntents: {},
    validationIssues: [],
    qualityIssues: [],
    validationSummary: { errorCount: 0, warningCount: 0, issueCodes: [] },
    qualitySummary: { errorCount: 0, warningCount: 0, issueCodes: [] },
    status: 'open',
    reviewRevision: 1,
    contentRevisionId: 'content-1',
    revisionFence: 1,
    graphFingerprint: 'graph-hash',
    correctionFingerprint: 'correction-hash',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

function workflow(status = 'needs_review'): BookAnalysisWorkflow {
  return {
    id: 'workflow-1',
    novelId: 'book-1',
    workflowType: 'book_ai_tts',
    workflowDefinitionId: 'moya.ai.tts.book-preparation',
    workflowVersion: '1.0.0',
    runtime: 'hosted',
    providerId: 'mock',
    planHash: 'plan-hash',
    plan: {
      novelId: 'book-1',
      totalChapters: 0,
      totalCharacters: 0,
      stages: [],
      bundleWindows: [],
      labelingChapters: [],
      labelingWindows: [],
      ttsReady: { chapterIds: [], dependsOnLabelingWindowIds: [] },
    },
    status,
    stage: status,
    readiness: { outcome: status === 'needs_review' ? 'needs_review' : 'pending', reviewItems: [] },
    jobs: [],
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

describe('analysis review controller', () => {
  it('loads, revision-saves, approves, refreshes artifacts, and resumes the workflow', async () => {
    const open = artifact();
    const saved = { ...open, status: 'editing' as const, reviewRevision: 2 };
    const promoted = {
      ...saved,
      status: 'promoted' as const,
      reviewRevision: 4,
      promotedArtifactId: 'artifact-promoted',
    };
    const resumed = workflow('running');
    const gateway = {
      runtime: 'hosted' as const,
      supportsTTSCacheReadiness: true,
      getPlan: vi.fn(),
      start: vi.fn(),
      get: vi.fn(async () => resumed),
      retry: vi.fn(),
      cancel: vi.fn(),
      listReviews: vi.fn(async () => [open]),
      saveReviewDraft: vi.fn(async () => saved),
      rejectReview: vi.fn(),
      approveReview: vi.fn(async () => promoted),
    } satisfies BookAnalysisWorkflowGateway;
    const resumeWorkflow = vi.fn();
    const onReviewPromoted = vi.fn(async () => undefined);
    const notify = vi.fn();
    let controller!: ReturnType<typeof useAnalysisReviewController>;
    function Harness() {
      controller = useAnalysisReviewController({
        gateway,
        workflow: workflow(),
        bookId: 'book-1',
        resumeWorkflow,
        onReviewPromoted,
        notify,
      });
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
      await Promise.resolve();
    });
    expect(controller.reviews).toEqual([open]);

    await act(async () => controller.saveDraft(open.id, candidate, {}));
    expect(gateway.saveReviewDraft).toHaveBeenCalledWith(open.id, 1, candidate, expect.any(AbortSignal), {});
    expect(controller.reviews[0]).toMatchObject({ status: 'editing', reviewRevision: 2 });

    await act(async () => controller.approve(open.id));
    expect(gateway.approveReview).toHaveBeenCalledWith(open.id, 2, expect.any(AbortSignal));
    expect(onReviewPromoted).toHaveBeenCalledWith(resumed);
    expect(resumeWorkflow).toHaveBeenCalledWith(resumed);
    expect(controller.reviews[0]).toMatchObject({ status: 'promoted', reviewRevision: 4 });
    await act(async () => renderer.unmount());
  });
});
