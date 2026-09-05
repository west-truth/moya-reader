import { chromium } from 'playwright-core';
import { SourceError } from './catalog.mjs';

const MAX_BYTES = 1024 * 1024;
const CHANNELS = new Set(['chromium', 'chrome', 'msedge']);

function abortable(operation, signal) {
  signal.throwIfAborted();
  let cancel;
  const aborted = new Promise((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  return Promise.race([operation, aborted]).finally(() => signal.removeEventListener('abort', cancel));
}

/** Opt-in normal browser networking. No persistent profile, script execution, or identity overrides. */
export function createBrowserSourceHttp({ channel, timeoutMs = 15_000 } = {}) {
  if (
    (channel !== undefined && !CHANNELS.has(channel)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000
  )
    throw new SourceError(500, 'invalid_source_http_transport');
  const shutdown = new AbortController();
  const waiting = [];
  let active = 0;
  let browserPromise;
  let disposing;

  function acquire(signal) {
    signal.throwIfAborted();
    if (active >= 2 && waiting.length >= 8) throw new SourceError(429, 'source_busy');
    return new Promise((resolve, reject) => {
      const entry = {
        start() {
          signal.removeEventListener('abort', cancel);
          active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active -= 1;
            waiting.shift()?.start();
          });
        },
      };
      const cancel = () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (active < 2) entry.start();
      else waiting.push(entry);
    });
  }
  function browser() {
    if (!browserPromise) {
      browserPromise = chromium
        .launch({ headless: true, ...(channel ? { channel } : {}), timeout: 15_000 })
        .then(async (instance) => {
          if (shutdown.signal.aborted) {
            await instance.close();
            throw shutdown.signal.reason;
          }
          instance.on('disconnected', () => {
            browserPromise = undefined;
          });
          return instance;
        })
        .catch(() => {
          browserPromise = undefined;
          throw new SourceError(503, 'source_browser_unavailable');
        });
    }
    return browserPromise;
  }
  async function fetchImpl(input, init = {}) {
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new SourceError(502, 'source_url_rejected');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.href.length > 4096
    )
      throw new SourceError(502, 'source_url_rejected');
    if (
      (init.method ?? 'GET') !== 'GET' ||
      init.body !== undefined ||
      (init.credentials !== undefined && init.credentials !== 'omit') ||
      (init.redirect !== undefined && init.redirect !== 'error')
    )
      throw new SourceError(502, 'source_request_rejected');
    const headers = new Headers(init.headers);
    const imageRequest = headers.get('accept') === 'image/jpeg, image/png, image/webp';
    const maximumBytes = imageRequest ? 8 * 1024 * 1024 : MAX_BYTES;
    if ([...headers.keys()].some((name) => !['accept', 'referer'].includes(name)))
      throw new SourceError(502, 'source_request_rejected');
    const abort = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, abort.signal, init.signal].filter(Boolean));
    const timer = setTimeout(() => abort.abort(new SourceError(504, 'source_timeout')), timeoutMs);
    let idle;
    let context;
    let release;
    let settled = false;
    const close = () => {
      void context?.close().catch(() => {});
    };
    const fail = (code) => abort.abort(new SourceError(502, code));
    const resetIdle = () => {
      if (settled) return;
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(new SourceError(504, 'source_timeout')), Math.min(timeoutMs, 10_000));
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      release = await acquire(signal);
      const instance = await abortable(browser(), signal);
      signal.throwIfAborted();
      context = await instance.newContext({
        javaScriptEnabled: false,
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      signal.throwIfAborted();
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable', {
        maxTotalBufferSize: maximumBytes + 65_536,
        maxResourceBufferSize: maximumBytes + 65_536,
      });
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      let finished;
      let captureStarted = false;
      const complete = new Promise((resolve) => {
        finished = resolve;
      });
      const { frameTree } = await cdp.send('Page.getFrameTree');
      cdp.on('Fetch.requestPaused', (event) => {
        void (async () => {
          if (event.resourceType !== 'Document' || event.frameId !== frameTree.frame.id)
            return cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' });
          if (
            event.redirectedRequestId ||
            event.request.url !== url.href ||
            event.request.method !== 'GET' ||
            [301, 302, 303, 307, 308].includes(event.responseStatusCode)
          ) {
            fail('source_redirect_rejected');
            return cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' });
          }
          if (event.responseErrorReason) return fail('source_request_failed');
          if (event.responseStatusCode !== undefined) {
            captureStarted = true;
            const responseHeaders = new Headers((event.responseHeaders ?? []).map(({ name, value }) => [name, value]));
            if (Number(responseHeaders.get('content-length')) > maximumBytes) return fail('source_response_limit');
            const mime = responseHeaders.get('content-type')?.split(';')[0].trim().toLowerCase();
            if (
              !(imageRequest ? ['image/jpeg', 'image/png', 'image/webp'] : ['application/json', 'text/html']).includes(
                mime,
              ) ||
              [204, 205, 304].includes(event.responseStatusCode)
            )
              return fail('source_invalid_response');
            const { stream } = await cdp.send('Fetch.takeResponseBodyAsStream', { requestId: event.requestId });
            const chunks = [];
            let length = 0;
            try {
              while (true) {
                resetIdle();
                const chunk = await abortable(cdp.send('IO.read', { handle: stream, size: 65_536 }), signal);
                const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
                length += bytes.length;
                if (length > maximumBytes) return fail('source_response_limit');
                chunks.push(bytes);
                if (chunk.eof) break;
              }
            } finally {
              clearTimeout(idle);
              await cdp.send('IO.close', { handle: stream }).catch(() => {});
            }
            // The raw decoded stream is complete. Do not render, normalize, or execute the document.
            await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' });
            finished(
              new Response(Buffer.concat(chunks, length), {
                status: event.responseStatusCode,
                headers: {
                  'Content-Type': responseHeaders.get('content-type'),
                  'Content-Length': String(length),
                },
              }),
            );
            return;
          }
          const outgoing = new Headers(event.request.headers);
          for (const [name, value] of headers) outgoing.set(name, value);
          return cdp.send('Fetch.continueRequest', {
            requestId: event.requestId,
            headers: [...outgoing].map(([name, value]) => ({ name, value })),
          });
        })().catch(() => {
          if (!signal.aborted) fail('source_request_failed');
        });
      });
      await cdp.send('Fetch.enable', {
        patterns: [
          { urlPattern: '*', requestStage: 'Request' },
          { urlPattern: '*', requestStage: 'Response' },
        ],
      });
      // Navigation is intentionally aborted after capture; its rejected promise must always be observed.
      void page.goto(url.href, { waitUntil: 'commit', timeout: 0 }).catch(() => {
        if (!captureStarted && !signal.aborted) fail('source_request_failed');
      });
      return await abortable(complete, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof SourceError) throw error;
      throw new SourceError(502, 'source_request_failed');
    } finally {
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      signal.removeEventListener('abort', close);
      await context?.close().catch(() => {});
      release?.();
    }
  }
  function dispose() {
    return (disposing ??= (async () => {
      shutdown.abort(new SourceError(503, 'server_stopping'));
      const instance = await browserPromise?.catch(() => undefined);
      await instance?.close();
    })());
  }
  return { fetchImpl, dispose };
}
