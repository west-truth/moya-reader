import { describe, expect, it } from 'vitest';
import type { HostedTTSWarmupChapterSource, HostedTTSWarmupRequest } from '../providers/hosted-tts-warmup';
import { runHostedTTSBackgroundWarmup } from '../providers/hosted-tts-background-warmup-runner';

interface TestChapter {
  readonly id: string;
}

function source(chapterId: string): HostedTTSWarmupChapterSource {
  return {
    chapterId,
    paragraphs: [
      {
        id: `${chapterId}_paragraph`,
        novelId: 'book_1',
        chapterId,
        index: 0,
        text: 'cached text stays out of requests',
        startOffsetInChapter: 0,
        endOffsetInChapter: 32,
        textHash: `${chapterId}_paragraph_hash`,
      },
    ],
    segments: [],
  };
}

function request(chapterId: string): HostedTTSWarmupRequest {
  return {
    requestKey: `key_${chapterId}`,
    chapterId,
    paragraphId: `${chapterId}_paragraph`,
    paragraphIndex: 0,
    speakerLabel: 'speaker',
    text: `text_${chapterId}`,
    request: {
      providerId: 'openai-tts',
      providerModel: 'gpt-4o-mini-tts',
      voiceProfileId: 'voice_1',
      speakerId: 'char_1',
      segmentIds: [`${chapterId}_segment`],
      inputTextHash: `${chapterId}_hash`,
    },
  };
}

describe('runHostedTTSBackgroundWarmup', () => {
  it('loads chapters in bounded batches, runs warmup queues, and aggregates results', async () => {
    const statuses: string[] = [];
    const loaded: string[] = [];
    const queued: string[][] = [];
    let yields = 0;

    const result = await runHostedTTSBackgroundWarmup<TestChapter>({
      chapters: [{ id: 'chapter_1' }, { id: 'chapter_2' }, { id: 'chapter_3' }],
      signal: new AbortController().signal,
      chapterBatchSize: 2,
      loadChapterSource: async (chapter) => {
        loaded.push(chapter.id);
        return source(chapter.id);
      },
      buildRequests: (sources) => sources.map((chapterSource) => request(chapterSource.chapterId)),
      runQueue: async (requests) => {
        queued.push(requests.map((warmupRequest) => warmupRequest.chapterId));
        return {
          total: requests.length,
          completed: requests.length,
          cacheHits: 1,
          jobs: requests.length - 1,
          failed: 0,
          aborted: false,
        };
      },
      yieldBetweenBatches: async () => {
        yields += 1;
      },
      onStatus: (status) => statuses.push(status),
    });

    expect(result).toEqual({
      total: 3,
      completed: 3,
      cacheHits: 2,
      jobs: 1,
      failed: 0,
      aborted: false,
      batches: 2,
      chapters: 3,
      skippedChapters: 0,
      sourceFailures: 0,
    });
    expect(loaded).toEqual(['chapter_1', 'chapter_2', 'chapter_3']);
    expect(queued).toEqual([['chapter_1', 'chapter_2'], ['chapter_3']]);
    expect(yields).toBe(1);
    expect(statuses).toEqual(['background warmup batch 1/2', 'background warmup batch 2/2']);
  });

  it('tracks skipped chapters and source failures without failing the whole warmup', async () => {
    const result = await runHostedTTSBackgroundWarmup<TestChapter>({
      chapters: [{ id: 'chapter_1' }, { id: 'empty' }, { id: 'broken' }, { id: 'chapter_2' }],
      signal: new AbortController().signal,
      chapterBatchSize: 4,
      loadChapterSource: async (chapter) => {
        if (chapter.id === 'empty') return undefined;
        if (chapter.id === 'broken') throw new Error('read failed');
        return source(chapter.id);
      },
      buildRequests: (sources) => sources.map((chapterSource) => request(chapterSource.chapterId)),
      runQueue: async (requests) => ({
        total: requests.length,
        completed: requests.length - 1,
        cacheHits: 0,
        jobs: 1,
        failed: 1,
        aborted: false,
      }),
    });

    expect(result).toEqual({
      total: 2,
      completed: 1,
      cacheHits: 0,
      jobs: 1,
      failed: 1,
      aborted: false,
      batches: 1,
      chapters: 2,
      skippedChapters: 1,
      sourceFailures: 1,
    });
  });

  it('returns an aborted summary when a queued batch aborts', async () => {
    const result = await runHostedTTSBackgroundWarmup<TestChapter>({
      chapters: [{ id: 'chapter_1' }, { id: 'chapter_2' }],
      signal: new AbortController().signal,
      chapterBatchSize: 1,
      loadChapterSource: async (chapter) => source(chapter.id),
      buildRequests: (sources) => sources.map((chapterSource) => request(chapterSource.chapterId)),
      runQueue: async () => ({
        total: 1,
        completed: 0,
        cacheHits: 0,
        jobs: 0,
        failed: 0,
        aborted: true,
      }),
    });

    expect(result).toEqual({
      total: 1,
      completed: 0,
      cacheHits: 0,
      jobs: 0,
      failed: 0,
      aborted: true,
      batches: 1,
      chapters: 1,
      skippedChapters: 0,
      sourceFailures: 0,
    });
  });
});
