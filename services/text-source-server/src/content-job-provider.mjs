import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { MAX_CONTENT_BYTES, SourceError } from './catalog.mjs';

const JOB_ID = /^[a-f0-9-]{36}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

async function jsonRequest(endpoint, key, route, { body, signal, maximum = 64 * 1024, stallMs = 10_000 } = {}) {
  const stalled = new AbortController();
  const combined = AbortSignal.any([signal, stalled.signal].filter(Boolean));
  let timer;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stalled.abort(new SourceError(504, 'content_provider_body_timeout')), stallMs);
    timer.unref?.();
  };
  let reader;
  try {
    resetTimer();
    const response = await fetch(new URL(route, endpoint), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: combined,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Lab-Request': '1' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) throw new SourceError(502, 'content_provider_response_limit');
    reader = response.body?.getReader();
    if (!reader) throw new SourceError(502, 'content_provider_invalid_response');
    const chunks = [];
    let size = 0;
    while (true) {
      resetTimer();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new SourceError(502, 'content_provider_response_limit');
      chunks.push(value);
    }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new SourceError(502, 'content_provider_authentication_required');
      if (response.status === 429) throw new SourceError(503, 'content_provider_busy');
      if (response.status === 503) throw new SourceError(503, 'content_provider_unavailable');
      throw new SourceError(502, 'content_provider_request_failed');
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
      throw new SourceError(502, 'content_provider_invalid_response');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
    } catch {
      throw new SourceError(502, 'content_provider_invalid_response');
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (stalled.signal.aborted) throw new SourceError(504, 'content_provider_body_timeout');
    if (error instanceof SourceError) throw error;
    throw new SourceError(502, 'content_provider_request_failed');
  } finally {
    clearTimeout(timer);
    stalled.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export function createContentJobProvider({
  endpoint,
  key,
  timeoutMs = 90_000,
  pollMs = 500,
  stallMs = 10_000,
  cleanupMs = 3_000,
}) {
  let base;
  try {
    base = new URL(endpoint);
  } catch {
    throw new SourceError(500, 'invalid_content_provider_configuration');
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    typeof key !== 'string' ||
    !key
  )
    throw new SourceError(500, 'invalid_content_provider_configuration');
  return async function materialize(chapterUrl, callerSignal) {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
    let jobId;
    try {
      signal.throwIfAborted();
      const opened = await jsonRequest(base, key, '/v1/jobs', {
        body: { requestId: randomUUID(), url: chapterUrl, kind: 'novel' },
        signal,
        stallMs,
      });
      if (typeof opened?.id !== 'string' || !JOB_ID.test(opened.id))
        throw new SourceError(502, 'content_provider_invalid_job');
      jobId = opened.id;
      let snapshot = opened;
      while (true) {
        signal.throwIfAborted();
        if (snapshot.id !== jobId || snapshot.kind !== 'novel')
          throw new SourceError(502, 'content_provider_invalid_job');
        if (snapshot.state === 'ready') break;
        if (!['queued', 'authenticating'].includes(snapshot.state)) {
          if (snapshot.state === 'failed') {
            if (snapshot.error === 'manual_login_or_paid_content') throw new SourceError(403, 'source_access_required');
            if (snapshot.error === 'manual_viewer_confirmation_required')
              throw new SourceError(409, 'source_verification_required');
            if (snapshot.error === 'novel_too_large') throw new SourceError(413, 'source_size_limit');
          }
          throw new SourceError(502, 'content_provider_job_failed');
        }
        await sleep(pollMs, undefined, { signal });
        snapshot = await jsonRequest(base, key, `/v1/jobs/${jobId}`, { signal, stallMs });
      }
      const manifest = await jsonRequest(base, key, `/v1/jobs/${jobId}/manifest`, {
        body: {},
        signal,
        maximum: MAX_JSON_BYTES,
        stallMs,
      });
      if (
        manifest?.id !== jobId ||
        manifest.chapterUrl !== chapterUrl ||
        manifest.kind !== 'novel' ||
        typeof manifest.text !== 'string' ||
        !manifest.text.trim()
      )
        throw new SourceError(502, 'content_provider_invalid_manifest');
      const bytes = Buffer.from(manifest.text, 'utf8');
      if (bytes.length > MAX_CONTENT_BYTES) throw new SourceError(413, 'source_size_limit');
      signal.throwIfAborted();
      return bytes;
    } catch (error) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (signal.aborted) throw new SourceError(504, 'content_provider_request_timeout');
      throw error;
    } finally {
      // A received job ID is cleaned up even after caller cancellation. Unknown creation outcomes rely on content provider TTL.
      if (jobId)
        await jsonRequest(base, key, `/v1/jobs/${jobId}/close`, {
          body: {},
          signal: AbortSignal.timeout(cleanupMs),
          stallMs: Math.min(stallMs, cleanupMs),
        }).catch(() => {});
    }
  };
}
