import type { HostedTTSWarmupChapterSource, HostedTTSWarmupRequest } from './hosted-tts-warmup';
import { DEFAULT_HOSTED_TTS_BACKGROUND_WARMUP_CHAPTER_BATCH_LIMIT } from './hosted-tts-warmup';
import type { HostedTTSWarmupSummary } from './hosted-tts-warmup-runner';

export interface HostedTTSBackgroundWarmupSummary extends HostedTTSWarmupSummary {
  readonly batches: number;
  readonly chapters: number;
  readonly skippedChapters: number;
  readonly sourceFailures: number;
}

export interface RunHostedTTSBackgroundWarmupInput<TChapter> {
  readonly chapters: TChapter[];
  readonly signal: AbortSignal;
  readonly chapterBatchSize?: number;
  readonly loadChapterSource: (
    chapter: TChapter,
    signal: AbortSignal,
  ) => Promise<HostedTTSWarmupChapterSource | undefined>;
  readonly buildRequests: (sources: HostedTTSWarmupChapterSource[]) => HostedTTSWarmupRequest[];
  readonly runQueue: (
    requests: HostedTTSWarmupRequest[],
    signal: AbortSignal,
  ) => Promise<HostedTTSWarmupSummary>;
  readonly yieldBetweenBatches?: () => Promise<void>;
  readonly onStatus?: (status: string) => void;
  readonly isAbortError?: (error: unknown) => boolean;
}

export async function runHostedTTSBackgroundWarmup<TChapter>(
  input: RunHostedTTSBackgroundWarmupInput<TChapter>,
): Promise<HostedTTSBackgroundWarmupSummary> {
  const chapterBatchSize = Math.max(
    1,
    Math.floor(input.chapterBatchSize ?? DEFAULT_HOSTED_TTS_BACKGROUND_WARMUP_CHAPTER_BATCH_LIMIT),
  );
  const totalBatches = Math.ceil(input.chapters.length / chapterBatchSize);
  let total = 0;
  let completed = 0;
  let cacheHits = 0;
  let jobs = 0;
  let failed = 0;
  let batches = 0;
  let chapters = 0;
  let skippedChapters = 0;
  let sourceFailures = 0;
  const makeSummary = (aborted: boolean, batchCount = batches): HostedTTSBackgroundWarmupSummary => ({
    total,
    completed,
    cacheHits,
    jobs,
    failed,
    batches: batchCount,
    chapters,
    skippedChapters,
    sourceFailures,
    aborted,
  });

  for (let batchStart = 0; batchStart < input.chapters.length; batchStart += chapterBatchSize) {
    if (input.signal.aborted) {
      return makeSummary(true);
    }

    const batchIndex = batches + 1;
    const batch = input.chapters.slice(batchStart, batchStart + chapterBatchSize);
    input.onStatus?.(`background warmup batch ${batchIndex}/${totalBatches}`);

    const sources: HostedTTSWarmupChapterSource[] = [];
    for (const chapter of batch) {
      if (input.signal.aborted) {
        return makeSummary(true);
      }
      try {
        const source = await input.loadChapterSource(chapter, input.signal);
        if (source && source.paragraphs.length > 0) {
          sources.push(source);
          chapters += 1;
        } else {
          skippedChapters += 1;
        }
      } catch (error) {
        if (input.signal.aborted || input.isAbortError?.(error)) {
          return makeSummary(true);
        }
        sourceFailures += 1;
      }
    }

    const requests = sources.length ? input.buildRequests(sources) : [];
    if (requests.length) {
      const summary = await input.runQueue(requests, input.signal);
      total += summary.total;
      completed += summary.completed;
      cacheHits += summary.cacheHits;
      jobs += summary.jobs;
      failed += summary.failed;
      if (summary.aborted) {
        return makeSummary(true, batches + 1);
      }
    }
    batches += 1;

    if (input.yieldBetweenBatches && batchStart + chapterBatchSize < input.chapters.length) {
      try {
        await input.yieldBetweenBatches();
      } catch (error) {
        if (input.signal.aborted || input.isAbortError?.(error)) {
          return makeSummary(true);
        }
        throw error;
      }
    }
  }

  return makeSummary(false);
}
