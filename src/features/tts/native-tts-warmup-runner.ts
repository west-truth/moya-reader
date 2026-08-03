import type { Chapter } from '../../domain/types';
import { ttsRenderSpecIntegrityHash } from '../../domain/identity/tts-identities';
import type { HostedTTSWarmupChapterSource, HostedTTSWarmupRequest } from '../../providers/hosted-tts-warmup';
import { nativeTTSCacheRenderInput, nativeTTSExpectedRender } from './native-tts-cache-request';
import type { TTSCacheGateway, TTSCacheReadiness, TTSNativeRecoveryPolicy } from './tts-cache-gateway';

const DEFAULT_RENDER_CONCURRENCY = 2;
const DEFAULT_CHAPTER_BATCH_SIZE = 3;
const READINESS_BATCH_SIZE = 256;
const DEFAULT_RETRY_LIMIT = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 750;
const MAX_PROVIDER_RETRY_AFTER_MS = 5 * 60 * 1_000;

export interface NativeTTSWarmupSummary {
  readonly total: number;
  readonly completed: number;
  readonly cacheHits: number;
  readonly rendered: number;
  readonly failed: number;
  readonly sourceFailures: number;
  readonly chapters: number;
  readonly aborted: boolean;
  readonly readiness?: TTSCacheReadiness;
}

function combineReadiness(parts: readonly TTSCacheReadiness[]): TTSCacheReadiness | undefined {
  if (parts.length === 0) return undefined;
  const planned = parts.reduce((total, part) => total + part.planned, 0);
  const ready = parts.reduce((total, part) => total + part.ready, 0);
  const missing = parts.reduce((total, part) => total + part.missing, 0);
  const byteSize = parts.reduce((total, part) => total + part.byteSize, 0);
  const ok = planned > 0 && missing === 0 && parts.every((part) => part.ok);
  return {
    ok,
    planned,
    ready,
    missing,
    byteSize,
    readyRenderSpecHashes: parts.flatMap((part) => part.readyRenderSpecHashes).slice(0, 128),
    missingRenderSpecHashes: parts.flatMap((part) => part.missingRenderSpecHashes).slice(0, 128),
    evidenceHash: ttsRenderSpecIntegrityHash({
      parts: parts.map((part) => part.evidenceHash),
      planned,
      ready,
      missing,
      byteSize,
      ok,
    }),
    checkedAtMs: Math.max(...parts.map((part) => part.checkedAtMs)),
  };
}

export interface NativeTTSWarmupInput {
  readonly novelId: string;
  readonly contentRevision: string;
  readonly chapters: readonly Chapter[];
  readonly signal: AbortSignal;
  readonly gateway: TTSCacheGateway;
  readonly loadChapterSource: (
    chapter: Chapter,
    signal: AbortSignal,
  ) => Promise<HostedTTSWarmupChapterSource | undefined>;
  readonly buildRequests: (sources: HostedTTSWarmupChapterSource[]) => HostedTTSWarmupRequest[];
  readonly chapterBatchSize?: number;
  readonly renderConcurrency?: number;
  readonly inspectOnly?: boolean;
  readonly onStatus?: (status: string) => void;
  readonly observer?: NativeTTSWarmupObserver;
  readonly retryLimit?: number;
  readonly retryBaseDelayMs?: number;
  readonly wait?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly recoveryPolicy?: TTSNativeRecoveryPolicy;
}

export interface NativeTTSWarmupPlannedItem {
  readonly chapterId: string;
  readonly paragraphId: string;
  readonly cacheKey: string;
  readonly renderSpecHash: string;
}

export interface NativeTTSWarmupObserver {
  planned(items: readonly NativeTTSWarmupPlannedItem[]): void | Promise<void>;
  running(renderSpecHash: string): void | Promise<void>;
  ready(
    renderSpecHash: string,
    result: { readonly cacheKey: string; readonly byteSize: number; readonly cacheHit: boolean },
  ): void | Promise<void>;
  failed(renderSpecHash: string, error: unknown): void | Promise<void>;
  retrying?(renderSpecHash: string, error: unknown, nextAttemptAt: string): void | Promise<void>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function nativeTTSProviderRetryAfterMs(error: unknown): number | undefined {
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
  const message = error instanceof Error ? error.message : String(error);
  const marker = /retry-after-seconds=(\d+)/i.exec(message);
  const seconds = Number(marker?.[1]);
  if (Number.isFinite(seconds) && seconds > 0)
    return Math.min(MAX_PROVIDER_RETRY_AFTER_MS, Math.round(seconds * 1_000));
  return undefined;
}

export function nativeTTSRetryDelayMs(
  attempt: number,
  baseDelayMs: number,
  random = Math.random,
  providerRetryAfterMs = 0,
): number {
  const exponential = Math.min(30_000, Math.max(100, baseDelayMs) * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exponential * (0.8 + Math.min(1, Math.max(0, random())) * 0.4));
  return Math.max(jittered, Math.min(MAX_PROVIDER_RETRY_AFTER_MS, Math.max(0, providerRetryAfterMs)));
}

function retryableNativeTTSError(error: unknown): boolean {
  if (typeof error === 'object' && error && 'retryable' in error && typeof error.retryable === 'boolean') {
    return error.retryable;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return !/(\b(?:400|401|403|404|422)\b|auth|unauthor|forbidden|invalid (?:voice|argument|request)|unsupported|credential|api[- ]?key|not configured|configuration)/u.test(
    message,
  );
}

function defaultWait(durationMs: number, signal: AbortSignal): Promise<void> {
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

async function renderBatch(input: {
  requests: readonly HostedTTSWarmupRequest[];
  contentRevision: string;
  signal: AbortSignal;
  gateway: TTSCacheGateway;
  concurrency: number;
  onStatus?: (status: string) => void;
  observer?: NativeTTSWarmupObserver;
  retryLimit: number;
  retryBaseDelayMs: number;
  wait: (durationMs: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
  recoveryPolicy?: TTSNativeRecoveryPolicy;
}): Promise<{ completed: number; cacheHits: number; rendered: number; failed: number; aborted: boolean }> {
  let cursor = 0;
  let completed = 0;
  let cacheHits = 0;
  let rendered = 0;
  let failed = 0;
  let aborted = false;
  const worker = async () => {
    while (!input.signal.aborted) {
      const index = cursor;
      cursor += 1;
      const request = input.requests[index];
      if (!request) return;
      const expected = nativeTTSExpectedRender(request);
      let attempt = 0;
      while (!input.signal.aborted)
        try {
          attempt += 1;
          input.onStatus?.(`native warmup ${index + 1}/${input.requests.length}`);
          await input.observer?.running(expected.renderSpecHash);
          const result = await input.gateway.render(
            nativeTTSCacheRenderInput(request, input.contentRevision, undefined, input.recoveryPolicy),
            input.signal,
          );
          await input.observer?.ready(expected.renderSpecHash, {
            cacheKey: result.cacheKey,
            byteSize: result.synthesis.byteSize,
            cacheHit: result.cacheHit,
          });
          completed += 1;
          if (result.cacheHit) cacheHits += 1;
          else rendered += 1;
          break;
        } catch (error) {
          if (input.signal.aborted || isAbortError(error)) {
            aborted = true;
            return;
          }
          if (attempt <= input.retryLimit && retryableNativeTTSError(error)) {
            const delayMs = nativeTTSRetryDelayMs(
              attempt,
              input.retryBaseDelayMs,
              input.random,
              nativeTTSProviderRetryAfterMs(error),
            );
            const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
            await input.observer?.retrying?.(expected.renderSpecHash, error, nextAttemptAt);
            try {
              await input.wait(delayMs, input.signal);
              continue;
            } catch (waitError) {
              if (input.signal.aborted || isAbortError(waitError)) {
                aborted = true;
                return;
              }
              throw waitError;
            }
          }
          await input.observer?.failed(expected.renderSpecHash, error);
          failed += 1;
          break;
        }
    }
    aborted = true;
  };
  await Promise.all(Array.from({ length: Math.max(1, input.concurrency) }, worker));
  return { completed, cacheHits, rendered, failed, aborted: aborted || input.signal.aborted };
}

export async function runNativeTTSWarmup(input: NativeTTSWarmupInput): Promise<NativeTTSWarmupSummary> {
  const chapterBatchSize = Math.max(1, input.chapterBatchSize ?? DEFAULT_CHAPTER_BATCH_SIZE);
  const renderConcurrency = Math.max(1, input.renderConcurrency ?? DEFAULT_RENDER_CONCURRENCY);
  const readinessParts: TTSCacheReadiness[] = [];
  const plannedRenderSpecHashes = new Set<string>();
  let completed = 0;
  let cacheHits = 0;
  let rendered = 0;
  let failed = 0;
  let sourceFailures = 0;
  let processedChapters = 0;

  for (let offset = 0; offset < input.chapters.length; offset += chapterBatchSize) {
    if (input.signal.aborted) break;
    const chapterBatch = input.chapters.slice(offset, offset + chapterBatchSize);
    input.onStatus?.(`native warmup chapters ${offset + 1}-${offset + chapterBatch.length}/${input.chapters.length}`);
    const sources: HostedTTSWarmupChapterSource[] = [];
    for (const chapter of chapterBatch) {
      if (input.signal.aborted) break;
      try {
        const source = await input.loadChapterSource(chapter, input.signal);
        if (source) {
          if (source.paragraphs.length > 0) {
            sources.push(source);
            processedChapters += 1;
          } else sourceFailures += 1;
        } else sourceFailures += 1;
      } catch (error) {
        if (input.signal.aborted || isAbortError(error)) break;
        sourceFailures += 1;
      }
    }
    const batchExpected: ReturnType<typeof nativeTTSExpectedRender>[] = [];
    const builtRequests = input.buildRequests(sources);
    sourceFailures += sources.filter(
      (source) => !builtRequests.some((request) => request.chapterId === source.chapterId),
    ).length;
    const requests = builtRequests.filter((request) => {
      const item = nativeTTSExpectedRender(request);
      if (plannedRenderSpecHashes.has(item.renderSpecHash)) return false;
      plannedRenderSpecHashes.add(item.renderSpecHash);
      batchExpected.push(item);
      return true;
    });
    await input.observer?.planned(
      requests.map((request) => {
        const expected = nativeTTSExpectedRender(request);
        return {
          chapterId: request.chapterId,
          paragraphId: request.paragraphId,
          cacheKey: expected.renderSpecHash,
          renderSpecHash: expected.renderSpecHash,
        };
      }),
    );
    if (!input.inspectOnly) {
      const batch = await renderBatch({
        requests,
        contentRevision: input.contentRevision,
        signal: input.signal,
        gateway: input.gateway,
        concurrency: renderConcurrency,
        onStatus: input.onStatus,
        observer: input.observer,
        retryLimit: Math.max(0, input.retryLimit ?? DEFAULT_RETRY_LIMIT),
        retryBaseDelayMs: Math.max(100, input.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS),
        wait: input.wait ?? defaultWait,
        random: input.random ?? Math.random,
        recoveryPolicy: input.recoveryPolicy,
      });
      completed += batch.completed;
      cacheHits += batch.cacheHits;
      rendered += batch.rendered;
      failed += batch.failed;
      if (batch.aborted) break;
    }
    if (!input.signal.aborted && batchExpected.length > 0) {
      for (let expectedOffset = 0; expectedOffset < batchExpected.length; expectedOffset += READINESS_BATCH_SIZE) {
        input.signal.throwIfAborted();
        readinessParts.push(
          await input.gateway.inspect(
            {
              novelId: input.novelId,
              contentRevision: input.contentRevision,
              expected: batchExpected.slice(expectedOffset, expectedOffset + READINESS_BATCH_SIZE),
            },
            input.signal,
          ),
        );
      }
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }

  const readiness = input.signal.aborted
    ? undefined
    : (combineReadiness(readinessParts) ??
      (await input.gateway.inspect(
        { novelId: input.novelId, contentRevision: input.contentRevision, expected: [] },
        input.signal,
      )));
  return {
    total: plannedRenderSpecHashes.size,
    completed,
    cacheHits,
    rendered,
    failed,
    sourceFailures,
    chapters: processedChapters,
    aborted: input.signal.aborted,
    readiness,
  };
}

export function inspectNativeTTSCache(input: Omit<NativeTTSWarmupInput, 'inspectOnly'>) {
  return runNativeTTSWarmup({ ...input, inspectOnly: true });
}
