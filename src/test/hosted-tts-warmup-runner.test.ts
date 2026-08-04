import { describe, expect, it } from 'vitest';
import type { ProviderJob, TTSCacheResolveInput } from '../providers/provider-jobs';
import type { HostedTTSWarmupRequest } from '../providers/hosted-tts-warmup';
import { runHostedTTSWarmupQueue } from '../providers/hosted-tts-warmup-runner';

function request(id: string, chapterId: string): HostedTTSWarmupRequest {
  return {
    requestKey: `key_${id}`,
    chapterId,
    paragraphId: `paragraph_${id}`,
    paragraphIndex: Number(id.replace(/\D/g, '')) || 0,
    speakerLabel: 'speaker',
    text: `text_${id}`,
    request: {
      providerId: 'openai-tts',
      providerModel: 'gpt-4o-mini-tts',
      voiceProfileId: 'voice_1',
      speakerId: 'char_1',
      segmentIds: [`segment_${id}`],
      inputTextHash: `hash_${id}`,
    } satisfies TTSCacheResolveInput,
  };
}

function job(id: string): ProviderJob {
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

describe('runHostedTTSWarmupQueue', () => {
  it('resolves warmup requests in order and polls cache-miss jobs', async () => {
    const controller = new AbortController();
    const statuses: string[] = [];
    const jobsSeen: string[] = [];
    const resolvedChapters: string[] = [];
    const polledJobs: string[] = [];

    const result = await runHostedTTSWarmupQueue({
      requests: [request('1', 'chapter_1'), request('2', 'chapter_2')],
      signal: controller.signal,
      resolveCache: async (warmupRequest) => {
        resolvedChapters.push(warmupRequest.chapterId);
        return warmupRequest.chapterId === 'chapter_1'
          ? { cacheHit: true, cacheKey: 'cache_1', optionsHash: 'options_1' }
          : { cacheHit: false, cacheKey: 'cache_2', optionsHash: 'options_2', job: job('job_2') };
      },
      pollJob: async (providerJob) => {
        polledJobs.push(providerJob.id);
        return { ...providerJob, status: 'succeeded' };
      },
      onStatus: (status) => statuses.push(status),
      onJob: (providerJob) => jobsSeen.push(providerJob.id),
    });

    expect(result).toEqual({
      total: 2,
      completed: 2,
      cacheHits: 1,
      jobs: 1,
      failed: 0,
      aborted: false,
    });
    expect(resolvedChapters).toEqual(['chapter_1', 'chapter_2']);
    expect(statuses).toEqual(['warmup 1/2', 'warmup 2/2']);
    expect(jobsSeen).toEqual(['job_2']);
    expect(polledJobs).toEqual(['job_2']);
  });

  it('continues after non-abort resolve failures and reports partial failure', async () => {
    const result = await runHostedTTSWarmupQueue({
      requests: [request('1', 'chapter_1'), request('2', 'chapter_2')],
      signal: new AbortController().signal,
      resolveCache: async (warmupRequest) => {
        if (warmupRequest.chapterId === 'chapter_1') throw new Error('temporary failure');
        return { cacheHit: true, cacheKey: 'cache_2', optionsHash: 'options_2' };
      },
      pollJob: async (providerJob) => providerJob,
    });

    expect(result).toEqual({
      total: 2,
      completed: 1,
      cacheHits: 1,
      jobs: 0,
      failed: 1,
      aborted: false,
    });
  });

  it('stops without marking failure when aborted', async () => {
    const controller = new AbortController();
    const resolvedChapters: string[] = [];

    const result = await runHostedTTSWarmupQueue({
      requests: [request('1', 'chapter_1'), request('2', 'chapter_2')],
      signal: controller.signal,
      resolveCache: async (warmupRequest) => {
        resolvedChapters.push(warmupRequest.chapterId);
        controller.abort();
        return { cacheHit: true, cacheKey: 'cache_1', optionsHash: 'options_1' };
      },
      pollJob: async (providerJob) => providerJob,
    });

    expect(result).toEqual({
      total: 2,
      completed: 1,
      cacheHits: 1,
      jobs: 0,
      failed: 0,
      aborted: true,
    });
    expect(resolvedChapters).toEqual(['chapter_1']);
  });
});
