import type { TaskProgress, TaskProgressCallback } from '@noveldesk/contracts';
import { randomUuid } from '../../utils/random-uuid';

function validProgress(value: unknown): value is TaskProgress {
  if (!value || typeof value !== 'object') return false;
  const p = value as TaskProgress;
  return (
    ['preparing', 'uploading', 'downloading', 'verifying', 'saving', 'finalizing'].includes(p.phase) &&
    (p.completed === undefined || (Number.isFinite(p.completed) && p.completed >= 0)) &&
    (p.total === undefined || (Number.isFinite(p.total) && p.total > 0)) &&
    (p.unit === undefined || ['bytes', 'images', 'items'].includes(p.unit))
  );
}

export async function withRequestProgress<T>(
  request: <R>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<R>,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  onProgress?: TaskProgressCallback,
  progressPath = `${path}/progress`,
): Promise<T> {
  if (!onProgress) return request<T>(path, init, timeoutMs);
  const id = randomUuid();
  const pollAbort = new AbortController();
  let active = !init.signal?.aborted;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const value = await request<unknown>(`${progressPath}/${id}`, { signal: pollAbort.signal }, 5000);
      if (validProgress(value)) {
        failures = 0;
        if (active) onProgress(value);
      } else {
        failures++;
      }
    } catch {
      failures++;
      // Older servers and missed telemetry must not fail or replay the operation.
    }
    if (active && failures < 3) timer = setTimeout(() => void poll(), 500);
  };
  if (active) timer = setTimeout(() => void poll(), 250);
  const stop = () => {
    active = false;
    clearTimeout(timer);
    pollAbort.abort();
  };
  init.signal?.addEventListener('abort', stop, { once: true });
  try {
    return await request<T>(`${path}${path.includes('?') ? '&' : '?'}progressId=${id}`, init, timeoutMs);
  } finally {
    stop();
    init.signal?.removeEventListener('abort', stop);
  }
}
