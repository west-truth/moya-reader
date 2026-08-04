import { describe, expect, it, vi } from 'vitest';
import type { Chapter, VoiceProfile } from '../../domain/types';
import type { HostedTTSWarmupRequest } from '../../providers/hosted-tts-warmup';
import { buildTTSRenderSpec } from '../../providers/tts-render-spec';
import type { TTSCacheGateway, TTSCacheReadinessInput } from './tts-cache-gateway';
import { inspectNativeTTSCache, runNativeTTSWarmup } from './native-tts-warmup-runner';

const chapter: Chapter = {
  id: 'chapter-1',
  novelId: 'book-1',
  index: 1,
  title: 'Chapter',
  normalizedText: '',
  textHash: 'sha256:chapter',
  rawStartOffset: 0,
  rawEndOffset: 5,
  characterCount: 5,
  paragraphCount: 1,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
};
const voiceProfile = {
  id: 'voice-1',
  novelId: 'book-1',
  characterId: 'speaker-1',
  role: 'character',
  providerId: 'openai-tts',
  providerVoiceId: 'alloy',
  label: 'Speaker',
  speed: 1,
  pitch: 1,
  isUserSelected: true,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
} satisfies VoiceProfile;

function warmupRequest(id: string): HostedTTSWarmupRequest {
  const renderSpec = buildTTSRenderSpec({
    novelId: 'book-1',
    chapterId: chapter.id,
    contentRevision: 'revision-1',
    chapterTextHash: chapter.textHash,
    speakerId: 'speaker-1',
    voiceProfile,
    segmentAnchors: [
      {
        segmentId: id,
        paragraphId: 'paragraph-1',
        startOffset: 0,
        endOffset: 5,
        segmentTextHash: `sha256:${id}`,
      },
    ],
    inputTextHash: `sha256:text-${id}`,
    providerOptionsHash: 'sha256:options',
  });
  return {
    requestKey: id,
    chapterId: chapter.id,
    paragraphId: 'paragraph-1',
    paragraphIndex: 0,
    speakerLabel: 'Speaker',
    text: 'Hello',
    request: {
      providerId: 'openai-tts',
      voiceProfileId: voiceProfile.id,
      speakerId: 'speaker-1',
      segmentIds: [id],
      inputTextHash: renderSpec.inputTextHash,
      renderSpec,
      providerOptions: {},
      audioCharacters: 5,
    },
  };
}

function gateway(): TTSCacheGateway {
  return {
    runtime: 'native',
    render: vi.fn(async (input) => ({
      cacheKey: input.renderSpecHash,
      renderSpecHash: input.renderSpecHash,
      contentRevision: input.contentRevision,
      cacheHit: input.renderSpec.segmentAnchors[0]?.segmentId === 'segment-1',
      synthesis: {
        providerId: 'openai-tts',
        contentType: 'audio/mpeg',
        audio: new Uint8Array([1]).buffer,
        byteSize: 1,
      },
    })),
    inspect: vi.fn(async (input: TTSCacheReadinessInput) => ({
      ok: true,
      planned: input.expected.length,
      ready: input.expected.length,
      missing: 0,
      byteSize: input.expected.length,
      readyRenderSpecHashes: input.expected.map((item) => item.renderSpecHash),
      missingRenderSpecHashes: [],
      evidenceHash: 'sha256:evidence',
      checkedAtMs: 1,
    })),
  };
}

describe('runNativeTTSWarmup', () => {
  it('retries transient render failures with bounded exponential backoff', async () => {
    const cache = gateway();
    vi.mocked(cache.render)
      .mockRejectedValueOnce(new Error('network temporarily unavailable'))
      .mockRejectedValueOnce(new Error('provider busy'));
    const waits: number[] = [];
    const events: string[] = [];
    const summary = await runNativeTTSWarmup({
      novelId: 'book-1',
      contentRevision: 'revision-1',
      chapters: [chapter],
      signal: new AbortController().signal,
      gateway: cache,
      loadChapterSource: async () => ({ chapterId: chapter.id, paragraphs: [], segments: [] }),
      buildRequests: () => [warmupRequest('segment-retry')],
      renderConcurrency: 1,
      retryLimit: 2,
      retryBaseDelayMs: 100,
      recoveryPolicy: { network: 'unmetered', charging: 'required' },
      random: () => 0.5,
      wait: async (durationMs) => {
        waits.push(durationMs);
      },
      observer: {
        planned: () => undefined,
        running: () => {
          events.push('running');
        },
        retrying: () => {
          events.push('retrying');
        },
        ready: () => {
          events.push('ready');
        },
        failed: () => {
          events.push('failed');
        },
      },
    });

    expect(summary).toMatchObject({ completed: 1, rendered: 1, failed: 0 });
    expect(waits).toEqual([100, 200]);
    expect(events).toEqual(['running', 'retrying', 'running', 'retrying', 'running', 'ready']);
    expect(cache.render).toHaveBeenCalledTimes(3);
    expect(cache.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ recoveryPolicy: { network: 'unmetered', charging: 'required' } }),
      expect.any(AbortSignal),
    );
  });

  it('does not retry a stable provider configuration failure', async () => {
    const cache = gateway();
    vi.mocked(cache.render).mockRejectedValueOnce(new Error('invalid voice configuration'));
    const retrying = vi.fn();

    const summary = await runNativeTTSWarmup({
      novelId: 'book-1',
      contentRevision: 'revision-1',
      chapters: [chapter],
      signal: new AbortController().signal,
      gateway: cache,
      loadChapterSource: async () => ({ chapterId: chapter.id, paragraphs: [], segments: [] }),
      buildRequests: () => [warmupRequest('segment-invalid-voice')],
      observer: {
        planned: () => undefined,
        running: () => undefined,
        retrying,
        ready: () => undefined,
        failed: () => undefined,
      },
    });

    expect(summary).toMatchObject({ completed: 0, failed: 1 });
    expect(cache.render).toHaveBeenCalledTimes(1);
    expect(retrying).not.toHaveBeenCalled();
  });

  it('uses a bounded provider retry-after hint as the retry delay floor', async () => {
    const cache = gateway();
    vi.mocked(cache.render).mockRejectedValueOnce(new Error('rate limited (retry-after-seconds=12)'));
    const waits: number[] = [];
    const summary = await runNativeTTSWarmup({
      novelId: 'book-1',
      contentRevision: 'revision-1',
      chapters: [chapter],
      signal: new AbortController().signal,
      gateway: cache,
      loadChapterSource: async () => ({ chapterId: chapter.id, paragraphs: [], segments: [] }),
      buildRequests: () => [warmupRequest('segment-rate-limited')],
      renderConcurrency: 1,
      retryLimit: 1,
      retryBaseDelayMs: 100,
      random: () => 0.5,
      wait: async (durationMs) => {
        waits.push(durationMs);
      },
    });

    expect(summary).toMatchObject({ completed: 1, failed: 0 });
    expect(waits).toEqual([12_000]);
    expect(cache.render).toHaveBeenCalledTimes(2);
  });

  it('reports durable item lifecycle events around native cache rendering', async () => {
    const events: string[] = [];
    const request = warmupRequest('segment-observed');
    const summary = await runNativeTTSWarmup({
      novelId: 'novel-1',
      contentRevision: 'revision-1',
      chapters: [chapter],
      signal: new AbortController().signal,
      gateway: gateway(),
      loadChapterSource: async () => ({ chapterId: chapter.id, paragraphs: [], segments: [] }),
      buildRequests: () => [request],
      observer: {
        planned: (items) => {
          events.push(`planned:${items.length}`);
        },
        running: () => {
          events.push('running');
        },
        ready: (_hash, result) => {
          events.push(`ready:${result.cacheHit}`);
        },
        failed: () => {
          events.push('failed');
        },
      },
    });

    expect(summary.failed).toBe(0);
    expect(events).toEqual(['planned:1', 'running', 'ready:false']);
  });

  it('loads chapters in batches, renders with bounded workers, and recomputes exact readiness', async () => {
    const cache = gateway();
    const summary = await runNativeTTSWarmup({
      novelId: 'book-1',
      contentRevision: 'revision-1',
      chapters: [chapter],
      signal: new AbortController().signal,
      gateway: cache,
      loadChapterSource: async () => ({
        chapterId: chapter.id,
        chapterTextHash: chapter.textHash,
        paragraphs: [],
        segments: [],
      }),
      buildRequests: () => [warmupRequest('segment-1'), warmupRequest('segment-2')],
      renderConcurrency: 2,
    });

    expect(summary).toMatchObject({ total: 2, completed: 2, cacheHits: 1, rendered: 1, failed: 0, aborted: false });
    expect(summary.readiness?.ok).toBe(true);
    expect(cache.render).toHaveBeenCalledTimes(2);
    expect(cache.inspect).toHaveBeenCalledOnce();
  });

  it('stops scheduling and skips readiness inspection after cancellation', async () => {
    const controller = new AbortController();
    const cache = gateway();
    vi.mocked(cache.render).mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const summary = await runNativeTTSWarmup({
      novelId: 'book-1',
      contentRevision: 'revision-1',
      chapters: [chapter],
      signal: controller.signal,
      gateway: cache,
      loadChapterSource: async () => ({ chapterId: chapter.id, paragraphs: [], segments: [] }),
      buildRequests: () => [warmupRequest('segment-1'), warmupRequest('segment-2')],
      renderConcurrency: 1,
    });

    expect(summary.aborted).toBe(true);
    expect(cache.render).toHaveBeenCalledOnce();
    expect(cache.inspect).not.toHaveBeenCalled();
  });

  it('inspects unique exact render specs without synthesizing audio', async () => {
    const cache = gateway();
    const request = warmupRequest('segment-1');
    const summary = await inspectNativeTTSCache({
      novelId: 'book-1',
      contentRevision: 'revision-1',
      chapters: [chapter],
      signal: new AbortController().signal,
      gateway: cache,
      loadChapterSource: async () => ({ chapterId: chapter.id, paragraphs: [], segments: [] }),
      buildRequests: () => [request, request],
    });

    expect(summary).toMatchObject({ total: 1, completed: 0, rendered: 0, cacheHits: 0, aborted: false });
    expect(cache.render).not.toHaveBeenCalled();
    expect(cache.inspect).toHaveBeenCalledWith(
      expect.objectContaining({ expected: [expect.objectContaining({ renderSpecHash: expect.any(String) })] }),
      expect.any(AbortSignal),
    );
  });
});
