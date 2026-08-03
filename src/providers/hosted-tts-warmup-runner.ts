import type { ProviderJob, TTSCacheResolveResult } from './provider-jobs';
import type { HostedTTSWarmupRequest } from './hosted-tts-warmup';

const DEFAULT_RETRY_BASE_DELAY_MS = 750;
const MAX_PROVIDER_RETRY_AFTER_MS = 5 * 60 * 1_000;

export interface HostedTTSWarmupSummary {
  readonly total: number;
  readonly completed: number;
  readonly cacheHits: number;
  readonly jobs: number;
  readonly failed: number;
  readonly aborted: boolean;
}

export interface RunHostedTTSWarmupQueueInput {
  readonly requests: HostedTTSWarmupRequest[];
  readonly signal: AbortSignal;
  readonly resolveCache: (request: HostedTTSWarmupRequest, signal: AbortSignal) => Promise<TTSCacheResolveResult>;
  readonly pollJob: (job: ProviderJob, signal: AbortSignal) => Promise<ProviderJob>;
  readonly fetchAudio?: (
    request: HostedTTSWarmupRequest,
    resolved: TTSCacheResolveResult,
    signal: AbortSignal,
  ) => Promise<Blob>;
  readonly onRequestStart?: (request: HostedTTSWarmupRequest) => void | Promise<void>;
  readonly onRequestReady?: (
    request: HostedTTSWarmupRequest,
    resolved: TTSCacheResolveResult,
    audio?: Blob,
  ) => void | Promise<void>;
  readonly onRequestFailed?: (request: HostedTTSWarmupRequest, error: unknown) => void | Promise<void>;
  readonly onRequestRetry?: (
    request: HostedTTSWarmupRequest,
    error: unknown,
    nextAttemptAt: string,
  ) => void | Promise<void>;
  readonly retryLimit?: number;
  readonly retryBaseDelayMs?: number;
  readonly wait?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly onStatus?: (status: string) => void;
  readonly onJob?: (job: ProviderJob) => void;
  readonly isAbortError?: (error: unknown) => boolean;
}

export async function runHostedTTSWarmupQueue(input: RunHostedTTSWarmupQueueInput): Promise<HostedTTSWarmupSummary> {
  let cacheHits = 0;
  let jobs = 0;
  let failed = 0;
  let completed = 0;

  for (let index = 0; index < input.requests.length; index += 1) {
    if (input.signal.aborted) {
      return summary(input.requests.length, completed, cacheHits, jobs, failed, true);
    }
    const request = input.requests[index];
    let attempt = 0;
    let requestCreatedJob = false;
    while (!input.signal.aborted) {
      try {
        attempt += 1;
        input.onStatus?.(`warmup ${index + 1}/${input.requests.length}`);
        await input.onRequestStart?.(request);
        const resolved = await input.resolveCache(request, input.signal);
        if (resolved.job) {
          requestCreatedJob = true;
          input.onJob?.(resolved.job);
          await input.pollJob(resolved.job, input.signal);
        }
        const audio = await input.fetchAudio?.(request, resolved, input.signal);
        await input.onRequestReady?.(request, resolved, audio);
        if (resolved.cacheHit) cacheHits += 1;
        if (requestCreatedJob) jobs += 1;
        completed += 1;
        break;
      } catch (error) {
        if (input.signal.aborted || input.isAbortError?.(error)) {
          return summary(input.requests.length, completed, cacheHits, jobs, failed, true);
        }
        if (attempt <= Math.max(0, input.retryLimit ?? 0) && retryableHostedTTSError(error)) {
          const delayMs = hostedTTSRetryDelayMs(
            attempt,
            input.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
            input.random ?? Math.random,
            hostedTTSProviderRetryAfterMs(error),
          );
          await input.onRequestRetry?.(request, error, new Date(Date.now() + delayMs).toISOString());
          try {
            await (input.wait ?? waitForRetry)(delayMs, input.signal);
            continue;
          } catch (waitError) {
            if (input.signal.aborted || input.isAbortError?.(waitError)) {
              return summary(input.requests.length, completed, cacheHits, jobs, failed, true);
            }
            throw waitError;
          }
        }
        await input.onRequestFailed?.(request, error);
        failed += 1;
        break;
      }
    }
  }

  return summary(input.requests.length, completed, cacheHits, jobs, failed, false);
}

function hostedTTSProviderRetryAfterMs(error: unknown): number {
  if (typeof error === 'object' && error) {
    const record = error as Record<string, unknown>;
    const milliseconds = Number(record.retryAfterMs ?? record.retry_after_ms);
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      return Math.min(MAX_PROVIDER_RETRY_AFTER_MS, Math.round(milliseconds));
    }
    const seconds = Number(record.retryAfterSeconds ?? record.retry_after_seconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(MAX_PROVIDER_RETRY_AFTER_MS, Math.round(seconds * 1_000));
    }
  }
  const marker = /retry-after-seconds=(\d+)/i.exec(error instanceof Error ? error.message : String(error));
  const seconds = Number(marker?.[1]);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(MAX_PROVIDER_RETRY_AFTER_MS, Math.round(seconds * 1_000))
    : 0;
}

function hostedTTSRetryDelayMs(
  attempt: number,
  baseDelayMs: number,
  random: () => number,
  providerRetryAfterMs: number,
): number {
  const exponential = Math.min(30_000, Math.max(100, baseDelayMs) * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exponential * (0.8 + Math.min(1, Math.max(0, random())) * 0.4));
  return Math.max(jittered, providerRetryAfterMs);
}

function retryableHostedTTSError(error: unknown): boolean {
  if (typeof error === 'object' && error && 'retryable' in error && typeof error.retryable === 'boolean') {
    return error.retryable;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return !/(\b(?:400|401|403|404|413|422)\b|auth|unauthor|forbidden|invalid (?:voice|argument|request)|unsupported|credential|api[- ]?key|not configured|configuration|quota|storage)/u.test(
    message,
  );
}

function waitForRetry(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function summary(
  total: number,
  completed: number,
  cacheHits: number,
  jobs: number,
  failed: number,
  aborted: boolean,
): HostedTTSWarmupSummary {
  return {
    total,
    completed,
    cacheHits,
    jobs,
    failed,
    aborted,
  };
}
