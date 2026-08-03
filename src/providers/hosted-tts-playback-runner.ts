import type { ProviderJob, TTSCacheResolveInput, TTSCacheResolveResult } from './provider-jobs';
import type { HostedTTSPrefetchedAudio } from './hosted-tts-prefetch';

export type HostedTTSPlaybackRunnerStatus =
  | 'prefetch_hit'
  | 'cache_lookup'
  | 'cache_hit'
  | 'cache_ready'
  | 'playing'
  | 'fallback_system';

export interface HostedTTSPlaybackRunnerResult {
  readonly played: boolean;
  readonly aborted: boolean;
  readonly fallback: boolean;
  readonly errorMessage?: string;
}

export interface RunHostedTTSPlaybackInput {
  readonly chapterId: string;
  readonly requestKey: string;
  readonly request: TTSCacheResolveInput;
  readonly signal: AbortSignal;
  readonly takePrefetched?: (requestKey: string) => HostedTTSPrefetchedAudio | undefined;
  readonly shouldContinue: () => boolean;
  readonly waitForResume: () => Promise<boolean>;
  readonly resolveCache: (
    chapterId: string,
    request: TTSCacheResolveInput,
    signal: AbortSignal,
  ) => Promise<TTSCacheResolveResult>;
  readonly pollJob: (job: ProviderJob, signal: AbortSignal) => Promise<ProviderJob>;
  readonly fetchAudio: (chapterId: string, cacheKey: string, signal: AbortSignal) => Promise<Blob>;
  readonly playAudio: (blob: Blob) => Promise<boolean>;
  readonly onStatus?: (status: HostedTTSPlaybackRunnerStatus | string) => void;
  readonly onJob?: (job: ProviderJob | undefined) => void;
  readonly isAbortError?: (error: unknown) => boolean;
}

export interface RunHostedTTSPrefetchInput {
  readonly chapterId: string;
  readonly requestKey: string;
  readonly request: TTSCacheResolveInput;
  readonly signal: AbortSignal;
  readonly shouldContinue: () => boolean;
  readonly resolveCache: (
    chapterId: string,
    request: TTSCacheResolveInput,
    signal: AbortSignal,
  ) => Promise<TTSCacheResolveResult>;
  readonly pollJob: (job: ProviderJob, signal: AbortSignal) => Promise<ProviderJob>;
  readonly fetchAudio: (chapterId: string, cacheKey: string, signal: AbortSignal) => Promise<Blob>;
  readonly rememberPrefetched: (requestKey: string, audio: HostedTTSPrefetchedAudio) => void;
  readonly isAbortError?: (error: unknown) => boolean;
}

export interface HostedTTSPrefetchRunnerResult {
  readonly stored: boolean;
  readonly aborted: boolean;
  readonly failed: boolean;
}

export async function runHostedTTSPlayback(
  input: RunHostedTTSPlaybackInput,
): Promise<HostedTTSPlaybackRunnerResult> {
  try {
    const prefetched = input.takePrefetched?.(input.requestKey);
    if (prefetched) {
      input.onJob?.(undefined);
      input.onStatus?.('prefetch_hit');
      if (!input.shouldContinue() || !(await input.waitForResume())) return stoppedResult();
      return { played: await input.playAudio(prefetched.blob), aborted: false, fallback: false };
    }

    input.onJob?.(undefined);
    input.onStatus?.('cache_lookup');
    const resolved = await input.resolveCache(input.chapterId, input.request, input.signal);
    if (resolved.cacheHit) {
      input.onJob?.(undefined);
      input.onStatus?.('cache_hit');
    } else if (resolved.job) {
      input.onJob?.(resolved.job);
      input.onStatus?.(resolved.job.status);
      await input.pollJob(resolved.job, input.signal);
      input.onStatus?.('cache_ready');
    }

    if (!input.shouldContinue() || !(await input.waitForResume())) return stoppedResult();
    const blob = await input.fetchAudio(input.chapterId, resolved.cacheKey, input.signal);
    if (!input.shouldContinue() || !(await input.waitForResume())) return stoppedResult();
    input.onStatus?.('playing');
    return { played: await input.playAudio(blob), aborted: false, fallback: false };
  } catch (error) {
    if (input.signal.aborted || input.isAbortError?.(error)) return { played: true, aborted: true, fallback: false };
    input.onStatus?.('fallback_system');
    return {
      played: false,
      aborted: false,
      fallback: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runHostedTTSPrefetch(input: RunHostedTTSPrefetchInput): Promise<HostedTTSPrefetchRunnerResult> {
  try {
    if (!input.shouldContinue()) return { stored: false, aborted: false, failed: false };
    const resolved = await input.resolveCache(input.chapterId, input.request, input.signal);
    if (resolved.job) await input.pollJob(resolved.job, input.signal);
    if (!input.shouldContinue()) return { stored: false, aborted: false, failed: false };
    const blob = await input.fetchAudio(input.chapterId, resolved.cacheKey, input.signal);
    if (!input.shouldContinue()) return { stored: false, aborted: false, failed: false };
    input.rememberPrefetched(input.requestKey, { cacheKey: resolved.cacheKey, blob });
    return { stored: true, aborted: false, failed: false };
  } catch (error) {
    if (input.signal.aborted || input.isAbortError?.(error)) return { stored: false, aborted: true, failed: false };
    return { stored: false, aborted: false, failed: true };
  }
}

function stoppedResult(): HostedTTSPlaybackRunnerResult {
  return { played: true, aborted: false, fallback: false };
}
