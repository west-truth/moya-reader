import { describe, expect, it, vi } from 'vitest';
import type { BookAnalysisWorkflow } from '../ai/book-analysis-workflow-gateway';
import {
  applyNativeTTSCacheReadiness,
  shouldApplyNativeTTSReadiness,
  type NativeTTSCacheControllerInput,
} from './native-tts-cache-controller';
import type { NativeTTSWarmupSummary } from './native-tts-warmup-runner';

const readiness = {
  ok: true,
  planned: 1,
  ready: 1,
  missing: 0,
  byteSize: 3,
  readyRenderSpecHashes: ['sha256:ready'],
  missingRenderSpecHashes: [],
  evidenceHash: 'sha256:evidence',
  checkedAtMs: 1,
};

function summary(patch: Partial<NativeTTSWarmupSummary> = {}): NativeTTSWarmupSummary {
  return {
    total: 1,
    completed: 1,
    cacheHits: 0,
    rendered: 1,
    failed: 0,
    sourceFailures: 0,
    chapters: 1,
    aborted: false,
    readiness,
    ...patch,
  };
}

describe('native TTS cache controller', () => {
  it('promotes readiness only after a successful full-book render', () => {
    expect(shouldApplyNativeTTSReadiness('render', { fullScan: true }, summary())).toBe(true);
    expect(shouldApplyNativeTTSReadiness('render', { fullScan: false }, summary())).toBe(false);
    expect(shouldApplyNativeTTSReadiness('render', { fullScan: true }, summary({ sourceFailures: 1 }))).toBe(false);
    expect(shouldApplyNativeTTSReadiness('inspect', { fullScan: true }, summary())).toBe(false);
  });

  it('downgrades a ready workflow when exact cache evidence becomes incomplete', () => {
    const adoptWorkflow = vi.fn(() => true);
    const workflow = {
      id: 'workflow-1',
      novelId: 'book-1',
      workflowType: 'book_ai_tts',
      runtime: 'native',
      providerId: 'openai',
      planHash: 'sha256:plan',
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
      status: 'succeeded',
      stage: 'audio_cache_ready',
      readiness: { outcome: 'ready_for_tts', reviewItems: [] },
      jobs: [],
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    } satisfies BookAnalysisWorkflow;
    const input = {
      workflow,
      adoptWorkflow,
    } as unknown as NativeTTSCacheControllerInput;

    applyNativeTTSCacheReadiness(input, {
      ...readiness,
      ok: false,
      ready: 0,
      missing: 1,
      readyRenderSpecHashes: [],
      missingRenderSpecHashes: ['sha256:missing'],
      evidenceHash: 'sha256:missing-evidence',
    });

    expect(adoptWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'ready_for_tts',
        progress: expect.objectContaining({ ttsCacheReadiness: expect.any(Object) }),
      }),
      { confirmsTTSReadiness: true },
    );
  });
});
