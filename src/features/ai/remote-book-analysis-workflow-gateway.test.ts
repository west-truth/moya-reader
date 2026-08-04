import { describe, expect, it, vi } from 'vitest';
import type { BookAIWorkflowPlan } from '../../providers/book-ai-workflow-plan';
import type { RemoteApiClient, RemoteBookAIWorkflow } from '../../services/remote/remote-api-client';
import { RemoteBookAnalysisWorkflowGateway } from './remote-book-analysis-workflow-gateway';
import type { ChapterLabelAnalysisReviewArtifact } from '../../providers/analysis-review';

const plan: BookAIWorkflowPlan = {
  novelId: 'book-1',
  totalChapters: 0,
  totalCharacters: 0,
  stages: [],
  bundleWindows: [],
  labelingChapters: [],
  labelingWindows: [],
  ttsReady: { chapterIds: [], dependsOnLabelingWindowIds: [] },
};

const workflow: RemoteBookAIWorkflow = {
  id: 'workflow-1',
  novelId: 'book-1',
  workflowType: 'book_ai_tts',
  providerId: 'openai',
  modelId: 'gpt-test',
  planHash: 'plan-hash',
  plan,
  status: 'running',
  stage: 'building_graph',
  jobs: [],
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
};

describe('RemoteBookAnalysisWorkflowGateway', () => {
  it('normalizes hosted responses and delegates every workflow operation', async () => {
    const review = {
      id: 'review-1',
      reviewRevision: 1,
      candidate: { characters: [], segments: [] },
    } as unknown as ChapterLabelAnalysisReviewArtifact;
    const client = {
      getBookAIWorkflowPlan: vi.fn(async () => ({ plan })),
      startBookAIWorkflow: vi.fn(async () => ({ workflow })),
      getBookAIWorkflow: vi.fn(async () => ({ workflow })),
      retryBookAIWorkflow: vi.fn(async () => ({ workflow })),
      cancelBookAIWorkflow: vi.fn(async () => ({ workflow })),
      refreshBookAIWorkflowTTSCacheReadiness: vi.fn(async () => ({ workflow })),
      listBookAIWorkflowReviews: vi.fn(async () => ({ reviews: [review] })),
      saveAnalysisReviewDraft: vi.fn(async () => ({ review: { ...review, reviewRevision: 2 } })),
      rejectAnalysisReviewArtifact: vi.fn(async () => ({ review: { ...review, status: 'rejected' } })),
      approveAnalysisReviewArtifact: vi.fn(async () => ({ review: { ...review, status: 'promoted' } })),
    } as unknown as RemoteApiClient;
    const gateway = new RemoteBookAnalysisWorkflowGateway(client);
    const signal = new AbortController().signal;

    await expect(gateway.getPlan('book-1', { maxBundleChapters: 2 }, signal)).resolves.toBe(plan);
    await expect(
      gateway.start({
        bookId: 'book-1',
        providerId: 'openai',
        modelId: 'gpt-test',
        providerOptions: { requestProfileId: 'default' },
      }),
    ).resolves.toMatchObject({ id: 'workflow-1', runtime: 'hosted' });
    await expect(gateway.get('workflow-1', signal)).resolves.toMatchObject({ runtime: 'hosted' });
    await expect(gateway.retry('workflow-1', signal)).resolves.toMatchObject({ runtime: 'hosted' });
    await expect(gateway.cancel('workflow-1', signal)).resolves.toMatchObject({ runtime: 'hosted' });
    await expect(gateway.refreshTTSCacheReadiness('workflow-1', signal)).resolves.toMatchObject({ runtime: 'hosted' });
    await expect(gateway.listReviews('workflow-1', signal)).resolves.toEqual([review]);
    await expect(gateway.saveReviewDraft('review-1', 1, review.candidate, signal)).resolves.toMatchObject({
      reviewRevision: 2,
    });
    await expect(gateway.rejectReview('review-1', 1, 'not useful', signal)).resolves.toMatchObject({
      status: 'rejected',
    });
    await expect(gateway.approveReview('review-1', 1, signal)).resolves.toMatchObject({ status: 'promoted' });

    expect(client.startBookAIWorkflow).toHaveBeenCalledWith({
      bookId: 'book-1',
      providerId: 'openai',
      modelId: 'gpt-test',
    });
    expect(client.getBookAIWorkflow).toHaveBeenCalledWith('workflow-1', signal);
    expect(client.saveAnalysisReviewDraft).toHaveBeenCalledWith(
      'review-1',
      { expectedReviewRevision: 1, candidate: review.candidate, editIntents: {} },
      signal,
    );
  });
});
