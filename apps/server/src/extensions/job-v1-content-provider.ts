import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ManagedContentProvider } from './content-provider-registry.js';

const JOB_ID = /^[a-f0-9-]{36}$/;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

const failure = (code: string) => new Error(code);

async function jsonRequest(
  endpoint: URL,
  key: string | undefined,
  route: string,
  options: { body?: object; signal: AbortSignal; maximum?: number; stallMs: number },
) {
  const maximum = options.maximum ?? 64 * 1024;
  const stalled = new AbortController();
  const combined = AbortSignal.any([options.signal, stalled.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stalled.abort(), options.stallMs);
    timer.unref?.();
  };
  try {
    resetTimer();
    const response = await fetch(new URL(route, endpoint), {
      method: options.body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: combined,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Lab-Request': '1' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) throw failure('content_provider_response_limit');
    reader = response.body?.getReader();
    if (!reader) throw failure('content_provider_invalid_response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      resetTimer();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw failure('content_provider_response_limit');
      chunks.push(value);
    }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw failure('content_provider_authentication_required');
      if (response.status === 429) throw failure('content_provider_busy');
      if (response.status === 503) throw failure('content_provider_unavailable');
      throw failure('content_provider_request_failed');
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
      throw failure('content_provider_invalid_response');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
    } catch {
      throw failure('content_provider_invalid_response');
    }
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    if (stalled.signal.aborted) throw failure('content_provider_body_timeout');
    if (error instanceof Error && error.message.startsWith('content_provider_')) throw error;
    throw failure('content_provider_request_failed');
  } finally {
    clearTimeout(timer);
    stalled.abort();
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Client for the public job-v1 HTTP contract. It has no catalog or vendor-specific behavior. */
export function createJobV1ContentProvider(options: Record<string, unknown>): ManagedContentProvider {
  let endpoint: URL;
  try {
    endpoint = new URL(String(options.endpoint));
  } catch {
    throw failure('invalid_content_provider_configuration');
  }
  const key = options.key;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pollMs = options.pollMs ?? 500;
  const stallMs = options.stallMs ?? 10_000;
  const cleanupMs = options.cleanupMs ?? 3_000;
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/' ||
    (key !== undefined && (typeof key !== 'string' || /[\r\n]/u.test(key))) ||
    ![timeoutMs, pollMs, stallMs, cleanupMs].every((value) => typeof value === 'number' && value > 0)
  )
    throw failure('invalid_content_provider_configuration');

  return async (chapterUrl, callerSignal = new AbortController().signal) => {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs as number)]);
    let jobId: string | undefined;
    try {
      signal.throwIfAborted();
      const opened = await jsonRequest(endpoint, key, '/v1/jobs', {
        body: { requestId: randomUUID(), url: chapterUrl, kind: 'novel' },
        signal,
        stallMs: stallMs as number,
      });
      if (!record(opened) || typeof opened.id !== 'string' || !JOB_ID.test(opened.id))
        throw failure('content_provider_invalid_job');
      jobId = opened.id;
      let snapshot = opened;
      while (true) {
        signal.throwIfAborted();
        if (snapshot.id !== jobId || snapshot.kind !== 'novel') throw failure('content_provider_invalid_job');
        if (snapshot.state === 'ready') break;
        if (!['queued', 'authenticating'].includes(String(snapshot.state))) {
          if (snapshot.state === 'failed') {
            if (snapshot.error === 'manual_login_or_paid_content') throw failure('source_access_required');
            if (snapshot.error === 'manual_viewer_confirmation_required') throw failure('source_verification_required');
            if (snapshot.error === 'novel_too_large') throw failure('source_size_limit');
          }
          throw failure('content_provider_job_failed');
        }
        await sleep(pollMs as number, undefined, { signal });
        const next = await jsonRequest(endpoint, key, `/v1/jobs/${jobId}`, {
          signal,
          stallMs: stallMs as number,
        });
        if (!record(next)) throw failure('content_provider_invalid_job');
        snapshot = next;
      }
      const manifest = await jsonRequest(endpoint, key, `/v1/jobs/${jobId}/manifest`, {
        body: {},
        signal,
        maximum: MAX_JSON_BYTES,
        stallMs: stallMs as number,
      });
      if (
        !record(manifest) ||
        manifest.id !== jobId ||
        manifest.chapterUrl !== chapterUrl ||
        manifest.kind !== 'novel' ||
        typeof manifest.text !== 'string' ||
        !manifest.text.trim()
      )
        throw failure('content_provider_invalid_manifest');
      const bytes = Buffer.from(manifest.text, 'utf8');
      if (bytes.length > MAX_CONTENT_BYTES) throw failure('source_size_limit');
      signal.throwIfAborted();
      return bytes;
    } catch (error) {
      if (callerSignal.aborted) throw callerSignal.reason;
      if (signal.aborted) throw failure('content_provider_request_timeout');
      throw error;
    } finally {
      if (jobId)
        await jsonRequest(endpoint, key, `/v1/jobs/${jobId}/close`, {
          body: {},
          signal: AbortSignal.timeout(cleanupMs as number),
          stallMs: Math.min(stallMs as number, cleanupMs as number),
        }).catch(() => undefined);
    }
  };
}
