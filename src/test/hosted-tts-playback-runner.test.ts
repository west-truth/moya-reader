import { describe, expect, it } from 'vitest';
import type { ProviderJob, TTSCacheResolveInput, TTSCacheResolveResult } from '../providers/provider-jobs';
import { runHostedTTSPlayback, runHostedTTSPrefetch } from '../providers/hosted-tts-playback-runner';

const request: TTSCacheResolveInput = {
  providerId: 'openai-tts',
  providerModel: 'gpt-4o-mini-tts',
  voiceProfileId: 'voice_1',
  speakerId: 'char_1',
  segmentIds: ['segment_1'],
  inputTextHash: 'hash_1',
};

function job(id = 'job_1'): ProviderJob {
  return {
    id,
    novelId: 'book_1',
    chapterId: 'chapter_1',
    type: 'tts_synthesis',
    providerId: 'openai-tts',
    modelId: 'gpt-4o-mini-tts',
    inputHash: `input_${id}`,
    status: 'queued',
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
  };
}

function audioBlob(label = 'audio'): Blob {
  return new Blob([label], { type: 'audio/mpeg' });
}

describe('runHostedTTSPlayback', () => {
  it('plays prefetched audio without resolving the cache again', async () => {
    const statuses: string[] = [];
    const played: Blob[] = [];

    const result = await runHostedTTSPlayback({
      chapterId: 'chapter_1',
      requestKey: 'request_1',
      request,
      signal: new AbortController().signal,
      takePrefetched: () => ({ cacheKey: 'cache_prefetched', blob: audioBlob('prefetched') }),
      shouldContinue: () => true,
      waitForResume: async () => true,
      resolveCache: async () => {
        throw new Error('resolve should not run for prefetch hits');
      },
      pollJob: async (providerJob) => providerJob,
      fetchAudio: async () => {
        throw new Error('fetch should not run for prefetch hits');
      },
      playAudio: async (blob) => {
        played.push(blob);
        return true;
      },
      onStatus: (status) => statuses.push(status),
    });

    expect(result).toEqual({ played: true, aborted: false, fallback: false });
    expect(statuses).toEqual(['prefetch_hit']);
    expect(played).toHaveLength(1);
  });

  it('resolves a cache miss, polls the synthesis job, fetches audio, and plays it', async () => {
    const statuses: string[] = [];
    const polledJobs: string[] = [];
    const fetched: Array<{ chapterId: string; cacheKey: string }> = [];

    const result = await runHostedTTSPlayback({
      chapterId: 'chapter_1',
      requestKey: 'request_1',
      request,
      signal: new AbortController().signal,
      shouldContinue: () => true,
      waitForResume: async () => true,
      resolveCache: async () => ({
        cacheHit: false,
        cacheKey: 'cache_1',
        optionsHash: 'options_1',
        job: job('job_1'),
      }),
      pollJob: async (providerJob) => {
        polledJobs.push(providerJob.id);
        return { ...providerJob, status: 'succeeded' };
      },
      fetchAudio: async (chapterId, cacheKey) => {
        fetched.push({ chapterId, cacheKey });
        return audioBlob();
      },
      playAudio: async () => true,
      onStatus: (status) => statuses.push(status),
    });

    expect(result).toEqual({ played: true, aborted: false, fallback: false });
    expect(statuses).toEqual(['cache_lookup', 'queued', 'cache_ready', 'playing']);
    expect(polledJobs).toEqual(['job_1']);
    expect(fetched).toEqual([{ chapterId: 'chapter_1', cacheKey: 'cache_1' }]);
  });

  it('returns a fallback result for non-abort failures', async () => {
    const statuses: string[] = [];

    const result = await runHostedTTSPlayback({
      chapterId: 'chapter_1',
      requestKey: 'request_1',
      request,
      signal: new AbortController().signal,
      shouldContinue: () => true,
      waitForResume: async () => true,
      resolveCache: async () => {
        throw new Error('provider unavailable');
      },
      pollJob: async (providerJob) => providerJob,
      fetchAudio: async () => audioBlob(),
      playAudio: async () => true,
      onStatus: (status) => statuses.push(status),
    });

    expect(result).toEqual({
      played: false,
      aborted: false,
      fallback: true,
      errorMessage: 'provider unavailable',
    });
    expect(statuses).toEqual(['cache_lookup', 'fallback_system']);
  });
});

describe('runHostedTTSPrefetch', () => {
  it('resolves, polls, fetches, and stores prefetched audio', async () => {
    const stored: Array<{ key: string; cacheKey: string; blob: Blob }> = [];

    const result = await runHostedTTSPrefetch({
      chapterId: 'chapter_1',
      requestKey: 'request_1',
      request,
      signal: new AbortController().signal,
      shouldContinue: () => true,
      resolveCache: async (): Promise<TTSCacheResolveResult> => ({
        cacheHit: false,
        cacheKey: 'cache_1',
        optionsHash: 'options_1',
        job: job('job_1'),
      }),
      pollJob: async (providerJob) => ({ ...providerJob, status: 'succeeded' }),
      fetchAudio: async () => audioBlob('prefetch'),
      rememberPrefetched: (key, audio) => stored.push({ key, ...audio }),
    });

    expect(result).toEqual({ stored: true, aborted: false, failed: false });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ key: 'request_1', cacheKey: 'cache_1' });
  });

  it('treats prefetch failures as non-fatal', async () => {
    const result = await runHostedTTSPrefetch({
      chapterId: 'chapter_1',
      requestKey: 'request_1',
      request,
      signal: new AbortController().signal,
      shouldContinue: () => true,
      resolveCache: async () => {
        throw new Error('temporary failure');
      },
      pollJob: async (providerJob) => providerJob,
      fetchAudio: async () => audioBlob(),
      rememberPrefetched: () => {
        throw new Error('nothing should be stored');
      },
    });

    expect(result).toEqual({ stored: false, aborted: false, failed: true });
  });
});
