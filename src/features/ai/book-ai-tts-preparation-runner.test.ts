import { describe, expect, it, vi } from 'vitest';
import type { BookAIWorkflowPlan } from '../../providers/book-ai-workflow-plan';
import {
  BookAnalysisWorkflowNotFoundError,
  type BookAnalysisWorkflow,
  type BookAnalysisWorkflowGateway,
} from './book-analysis-workflow-gateway';
import {
  ConfiguredBookAITTSPreparationRunner,
  GatewayBookAITTSPreparationRunner,
} from './book-ai-tts-preparation-runner';

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

function workflow(status = 'succeeded'): BookAnalysisWorkflow {
  return {
    id: 'workflow-1',
    novelId: 'book-1',
    workflowType: 'book_ai_tts',
    workflowDefinitionId: 'moya.ai.tts.book-preparation',
    workflowVersion: '1.0.0',
    runtime: 'hosted',
    providerId: 'mock',
    planHash: 'plan-1',
    plan,
    status,
    stage: status === 'succeeded' ? 'ready_for_tts' : 'labeling_chapters',
    readiness: { outcome: status === 'succeeded' ? 'ready_for_tts' : 'pending', reviewItems: [] },
    jobs: [],
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
  };
}

function gateway(overrides: Partial<BookAnalysisWorkflowGateway> = {}): BookAnalysisWorkflowGateway {
  const completed = workflow();
  return {
    runtime: 'hosted',
    supportsTTSCacheReadiness: true,
    getPlan: vi.fn(async () => plan),
    start: vi.fn(async () => completed),
    get: vi.fn(async () => completed),
    getActive: vi.fn(async () => completed),
    retry: vi.fn(async () => completed),
    cancel: vi.fn(async () => ({ ...completed, status: 'cancelled' })),
    refreshTTSCacheReadiness: vi.fn(async () => completed),
    ...overrides,
  };
}

describe('gateway-backed AI TTS preparation runner', () => {
  it('restores through active discovery when a stored workflow is stale', async () => {
    const active = workflow();
    const source = gateway({
      get: vi.fn(async () => {
        throw new BookAnalysisWorkflowNotFoundError('stale-workflow');
      }),
      getActive: vi.fn(async () => active),
    });
    const runner = new GatewayBookAITTSPreparationRunner(source);
    const signal = new AbortController().signal;

    await expect(runner.restore('book-1', 'stale-workflow', signal)).resolves.toBe(active);
    expect(source.get).toHaveBeenCalledWith('stale-workflow', signal);
    expect(source.getActive).toHaveBeenCalledWith('book-1', signal);
  });

  it('delegates lifecycle operations and owns terminal monitoring', async () => {
    const running = workflow('running');
    const completed = workflow();
    const get = vi.fn().mockResolvedValueOnce(running).mockResolvedValueOnce(completed);
    const source = gateway({ get });
    const runner = new GatewayBookAITTSPreparationRunner(source);
    const signal = new AbortController().signal;
    const progress = vi.fn();

    await runner.getPlan('book-1', undefined, signal);
    await runner.start({ bookId: 'book-1' }, signal);
    await runner.retry('workflow-1', signal);
    await runner.cancel('workflow-1', signal);
    await runner.refreshCacheReadiness?.('workflow-1', signal);
    await expect(
      runner.monitor('workflow-1', { signal, attempts: 2, pollIntervalMs: 0, onProgress: progress }),
    ).resolves.toBe(completed);

    expect(source.getPlan).toHaveBeenCalledWith('book-1', undefined, signal);
    expect(source.start).toHaveBeenCalledWith(
      {
        bookId: 'book-1',
        workflowDefinitionId: 'moya.ai.tts.book-preparation',
        workflowVersion: '1.0.0',
      },
      signal,
    );
    expect(source.retry).toHaveBeenCalledWith('workflow-1', signal);
    expect(source.cancel).toHaveBeenCalledWith('workflow-1', signal);
    expect(source.refreshTTSCacheReadiness).toHaveBeenCalledWith('workflow-1', signal);
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it('applies a trusted planning policy while delegating the production lifecycle', async () => {
    const configuredWorkflow = {
      ...workflow(),
      workflowDefinitionId: 'example.ai.tts.detailed' as const,
      workflowVersion: '2.0.0',
    };
    const source = gateway({
      start: vi.fn(async () => configuredWorkflow),
      retry: vi.fn(async () => configuredWorkflow),
    });
    const base = new GatewayBookAITTSPreparationRunner(source);
    const runner = new ConfiguredBookAITTSPreparationRunner('example.ai.tts.detailed', '2.0.0', base, {
      maxLabelingParagraphs: 2,
    });
    const signal = new AbortController().signal;

    await runner.getPlan('book-1', { maxBundleChapters: 1 }, signal);
    await runner.start({ bookId: 'book-1', planOptions: { maxLabelingParagraphs: 9, maxBundleChapters: 2 } }, signal);
    await runner.retry('workflow-1', signal);

    expect(runner.id).toBe('example.ai.tts.detailed');
    expect(source.getPlan).toHaveBeenCalledWith('book-1', { maxBundleChapters: 1, maxLabelingParagraphs: 2 }, signal);
    expect(source.start).toHaveBeenCalledWith(
      {
        bookId: 'book-1',
        workflowDefinitionId: 'example.ai.tts.detailed',
        workflowVersion: '2.0.0',
        planOptions: { maxLabelingParagraphs: 2, maxBundleChapters: 2 },
      },
      signal,
    );
    expect(source.retry).toHaveBeenCalledWith('workflow-1', signal);
  });

  it('rejects restore results from another definition or execution version', async () => {
    const source = gateway({
      get: vi.fn(async () => ({ ...workflow(), workflowVersion: '0.9.0' })),
    });
    const runner = new ConfiguredBookAITTSPreparationRunner(
      'moya.ai.tts.book-preparation',
      '1.0.0',
      new GatewayBookAITTSPreparationRunner(source),
      {},
      { restoresLegacyWorkflowIds: true },
    );

    await expect(runner.restore('book-1', 'workflow-1')).resolves.toBeUndefined();
  });
});
