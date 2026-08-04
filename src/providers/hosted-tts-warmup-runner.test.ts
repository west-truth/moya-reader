import { describe, expect, it, vi } from 'vitest';
import type { HostedTTSWarmupRequest } from './hosted-tts-warmup';
import { runHostedTTSWarmupQueue } from './hosted-tts-warmup-runner';

const request: HostedTTSWarmupRequest = {
  requestKey: 'request_1',
  chapterId: 'chapter_1',
  paragraphId: 'paragraph_1',
  paragraphIndex: 0,
  speakerLabel: 'narrator',
  text: 'hello',
  request: {
    providerId: 'provider_1',
    voiceProfileId: 'voice_1',
    speakerId: 'narrator',
    segmentIds: ['segment_1'],
    inputTextHash: 'text_hash',
  },
};

describe('runHostedTTSWarmupQueue', () => {
  it('downloads audio before reporting a request as ready', async () => {
    const order: string[] = [];
    const audio = new Blob(['audio'], { type: 'audio/mpeg' });
    const result = await runHostedTTSWarmupQueue({
      requests: [request],
      signal: new AbortController().signal,
      resolveCache: async () => ({ cacheHit: true, cacheKey: 'cache_1', optionsHash: 'options_1' }),
      pollJob: vi.fn(),
      onRequestStart: () => {
        order.push('start');
      },
      fetchAudio: async () => {
        order.push('audio');
        return audio;
      },
      onRequestReady: (_request, resolved, storedAudio) => {
        expect(resolved.cacheKey).toBe('cache_1');
        expect(storedAudio).toBe(audio);
        order.push('ready');
      },
    });

    expect(result).toMatchObject({ completed: 1, failed: 0, aborted: false });
    expect(order).toEqual(['start', 'audio', 'ready']);
  });

  it('reports persistence failures against the exact request', async () => {
    const onRequestFailed = vi.fn();
    const result = await runHostedTTSWarmupQueue({
      requests: [request],
      signal: new AbortController().signal,
      resolveCache: async () => ({ cacheHit: true, cacheKey: 'cache_1', optionsHash: 'options_1' }),
      pollJob: vi.fn(),
      fetchAudio: async () => {
        throw new Error('quota exceeded');
      },
      onRequestFailed,
    });

    expect(result).toMatchObject({ completed: 0, failed: 1, aborted: false });
    expect(onRequestFailed).toHaveBeenCalledWith(request, expect.objectContaining({ message: 'quota exceeded' }));
  });

  it('retries a transient request with bounded delay and records retry state', async () => {
    const resolveCache = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('temporarily unavailable'), { retryAfterMs: 2_000 }))
      .mockResolvedValue({ cacheHit: true, cacheKey: 'cache_1', optionsHash: 'options_1' });
    const wait = vi.fn(async () => undefined);
    const onRequestRetry = vi.fn();
    const result = await runHostedTTSWarmupQueue({
      requests: [request],
      signal: new AbortController().signal,
      resolveCache,
      pollJob: vi.fn(),
      fetchAudio: async () => new Blob(['audio'], { type: 'audio/mpeg' }),
      retryLimit: 2,
      random: () => 0,
      wait,
      onRequestRetry,
    });

    expect(result).toMatchObject({ completed: 1, failed: 0, aborted: false });
    expect(resolveCache).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
    expect(onRequestRetry).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ message: 'temporarily unavailable' }),
      expect.any(String),
    );
  });

  it('does not retry storage quota failures', async () => {
    const fetchAudio = vi.fn(async () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const result = await runHostedTTSWarmupQueue({
      requests: [request],
      signal: new AbortController().signal,
      resolveCache: async () => ({ cacheHit: true, cacheKey: 'cache_1', optionsHash: 'options_1' }),
      pollJob: vi.fn(),
      fetchAudio,
      retryLimit: 3,
      wait: vi.fn(async () => undefined),
    });

    expect(result).toMatchObject({ completed: 0, failed: 1 });
    expect(fetchAudio).toHaveBeenCalledOnce();
  });
});
