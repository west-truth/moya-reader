import { SourceError } from './catalog.mjs';
import { setTimeout as delay } from 'node:timers/promises';

/** Trusted adapters select origins; remote links cannot widen this boundary. */
export async function fetchSourceBytes(
  urlValue,
  {
    allowedOrigins,
    signal,
    maxBytes = 1024 * 1024,
    timeoutMs = 15_000,
    stallMs = 10_000,
    mime = 'application/json',
    headers = {},
    method = 'GET',
    body,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    throw new SourceError(502, 'source_url_rejected');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.length > 4096 ||
    !allowedOrigins?.includes(url.origin)
  )
    throw new SourceError(502, 'source_url_rejected');
  const abort = new AbortController();
  const combined = AbortSignal.any([signal, abort.signal].filter(Boolean));
  const total = setTimeout(() => abort.abort(new SourceError(504, 'source_timeout')), timeoutMs);
  let idle;
  let reader;
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => abort.abort(new SourceError(504, 'source_timeout')), stallMs);
  };
  combined.addEventListener('abort', cancel, { once: true });
  try {
    combined.throwIfAborted();
    const request = {
      method,
      body,
      signal: combined,
      redirect: 'error',
      credentials: 'omit',
      headers: { Accept: Array.isArray(mime) ? mime.join(', ') : mime, ...headers },
    };
    let response;
    try {
      response = await fetchImpl(url, request);
    } catch (error) {
      // Retry only a read-only request that failed before headers. Keep the original total deadline.
      if (method !== 'GET' || !['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(error?.cause?.code)) throw error;
      await delay(300, undefined, { signal: combined });
      response = await fetchImpl(url, request);
    }
    reader = response.body?.getReader();
    combined.throwIfAborted();
    if (!response.ok) {
      const status = [401, 403, 404, 429].includes(response.status) ? response.status : 502;
      throw new SourceError(
        status,
        status === 404
          ? 'content_unavailable'
          : status === 401 || status === 403
            ? 'source_authentication_required'
            : status === 429
              ? 'source_busy'
              : 'source_request_failed',
      );
    }
    if (
      !reader ||
      response.redirected ||
      !(Array.isArray(mime) ? mime : [mime]).includes(
        response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(),
      ) ||
      Number(response.headers.get('content-length')) > maxBytes
    )
      throw new SourceError(502, 'source_invalid_response');
    const chunks = [];
    let length = 0;
    while (true) {
      combined.throwIfAborted();
      resetIdle();
      const { done, value } = await reader.read();
      clearTimeout(idle);
      combined.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new SourceError(502, 'source_response_limit');
      chunks.push(value);
    }
    return { bytes: Buffer.concat(chunks, length), headers: response.headers };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (abort.signal.aborted) throw new SourceError(504, 'source_timeout');
    if (error instanceof SourceError) throw error;
    throw new SourceError(502, 'source_request_failed');
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    combined.removeEventListener('abort', cancel);
    abort.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export async function fetchSourceJson(url, options) {
  const { bytes } = await fetchSourceBytes(url, options);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new SourceError(502, 'source_invalid_json');
  }
}
