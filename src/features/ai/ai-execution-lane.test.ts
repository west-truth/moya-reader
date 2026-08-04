import { describe, expect, it, vi } from 'vitest';
import { AIExecutionLane } from './ai-execution-lane';
import type { BookAnalysisWorkflow } from './book-analysis-workflow-gateway';
import { pollBookAIWorkflowUntilTerminal } from './book-ai-workflow-runner';
import { pollRemoteProviderJobUntilTerminal } from './useAnalysisExecutionController';

function workflow(status: string): BookAnalysisWorkflow {
  return {
    id: 'workflow-1',
    novelId: 'book-1',
    workflowType: 'book_ai_tts',
    runtime: 'hosted',
    providerId: 'mock',
    planHash: 'plan-hash',
    plan: {
      novelId: 'book-1',
      totalChapters: 0,
      totalCharacters: 0,
      stages: [],
      bundleWindows: [],
      labelingWindows: [],
      labelingChapters: [],
      ttsReady: { chapterIds: [], dependsOnLabelingWindowIds: [] },
    },
    status,
    stage: status,
    readiness: {
      outcome: status === 'needs_review' ? 'needs_review' : 'pending',
      reviewItems: [],
    },
    jobs: [],
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
}

describe('AI execution lane', () => {
  it('aborts and fences the previous target generation', () => {
    const lane = new AIExecutionLane();
    const first = lane.begin('book-1/chapter-1');
    const second = lane.begin('book-2/chapter-1');

    expect(first.controller.signal.aborted).toBe(true);
    expect(lane.isCurrent(first)).toBe(false);
    expect(lane.isCurrent(second, 'book-2/chapter-1')).toBe(true);
  });

  it('treats needs_review as a terminal workflow result', async () => {
    const gateway = {
      get: vi.fn().mockResolvedValue(workflow('needs_review')),
    };
    const onProgress = vi.fn();

    const result = await pollBookAIWorkflowUntilTerminal({
      gateway,
      workflowId: 'workflow-1',
      signal: new AbortController().signal,
      attempts: 2,
      delay: async () => undefined,
      onProgress,
    });

    expect(result.status).toBe('needs_review');
    expect(gateway.get).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(result);
  });

  it('stops provider polling when the target rejects a late progress commit', async () => {
    const job = {
      id: 'job-1',
      novelId: 'book-1',
      jobType: 'chapter_segment_labeling' as const,
      providerId: 'mock',
      inputHash: 'input-hash',
      status: 'running' as const,
      stage: 'running',
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
    };
    const client = { getProviderJob: vi.fn().mockResolvedValue({ job }) };

    await expect(
      pollRemoteProviderJobUntilTerminal({
        client,
        jobId: job.id,
        signal: new AbortController().signal,
        delay: async () => undefined,
        onProgress: () => false,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.getProviderJob).toHaveBeenCalledTimes(1);
  });
});
