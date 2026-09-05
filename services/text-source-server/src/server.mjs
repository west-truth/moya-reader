import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_PATTERN, MAX_CONTENT_BYTES, SourceError, loadCatalog, revisionTag } from './catalog.mjs';
import { parseListParameters } from './adapter-contract.mjs';
import { createAdapterRegistry } from './adapter-registry.mjs';
import { createStaticCatalogAdapter } from './static-catalog-adapter.mjs';

function authenticated(value, key) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  return timingSafeEqual(
    createHash('sha256').update(value.slice(7)).digest(),
    createHash('sha256').update(key).digest(),
  );
}
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
function timeoutOption(value, fallback) {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)
    throw new SourceError(500, 'invalid_request_timeout');
  return timeout;
}

/** An adapter may ignore cancellation; its promise must not retain the HTTP slot. */
async function abortableOperation(operation, signal, pending) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const running = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return operation();
  });
  pending.add(running);
  running.then(
    () => pending.delete(running),
    () => pending.delete(running),
  );
  try {
    const result = await Promise.race([running, aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    pending.delete(running);
    signal.removeEventListener('abort', onAbort);
  }
}

async function drainCleanup(pending, timeoutMs) {
  if (!pending.size) return;
  let timer;
  try {
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createTextSourceServer(options) {
  const { serverKey, moyaOrigin } = options;
  if (typeof serverKey !== 'string' || serverKey.length < 16 || serverKey.startsWith('replace-with-'))
    throw new SourceError(500, 'invalid_server_key');
  if (moyaOrigin !== undefined) {
    let origin;
    try {
      origin = new URL(moyaOrigin);
    } catch {
      throw new SourceError(500, 'invalid_moya_origin');
    }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== moyaOrigin)
      throw new SourceError(500, 'invalid_moya_origin');
  }
  const catalog = await loadCatalog(options.catalogFile, options.sourceRoot);
  const { contentProvider, additionalAdapters = [] } = options;
  if (contentProvider !== undefined && typeof contentProvider !== 'function')
    throw new SourceError(500, 'invalid_content_provider_configuration');
  const registry = createAdapterRegistry([
    ...[...catalog.sources.values()].map((source) => createStaticCatalogAdapter(catalog, source, contentProvider)),
    ...additionalAdapters,
  ]);
  const timeouts = {
    metadata: timeoutOption(options.metadataTimeoutMs ?? options.requestTimeoutMs, 15_000),
    content: timeoutOption(options.contentTimeoutMs ?? options.requestTimeoutMs, 95_000),
  };
  const shutdownGraceMs = timeoutOption(options.shutdownGraceMs, 3_100);
  const controllers = new Set();
  const pendingOperations = new Set();
  const active = { metadata: 0, content: 0 };
  const limits = { metadata: 8, content: 2 };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Vary', 'Origin');
    if (request.headers.origin && request.headers.origin !== moyaOrigin)
      return json(response, 403, { error: 'origin_rejected' });
    if (request.headers.origin) {
      response.setHeader('Access-Control-Allow-Origin', moyaOrigin);
      response.setHeader('Access-Control-Expose-Headers', 'ETag, X-Moya-Source-Namespace');
    }
    if (request.method === 'OPTIONS') {
      if (
        !request.headers.origin ||
        request.headers['access-control-request-method'] !== 'GET' ||
        (request.headers['access-control-request-headers'] ?? '')
          .split(',')
          .some((header) => !['', 'authorization', 'accept'].includes(header.trim().toLowerCase()))
      )
        return json(response, 403, { error: 'preflight_rejected' });
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Authorization, Accept',
        'Access-Control-Max-Age': '600',
      });
      return response.end();
    }
    if (!authenticated(request.headers.authorization, serverKey))
      return json(response, 401, { error: 'authentication_required' });
    response.setHeader(
      'X-Moya-Source-Namespace',
      encodeURIComponent(JSON.stringify([catalog.instanceId, catalog.dataNamespace, 'single'])),
    );
    if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' });
    const abort = new AbortController();
    controllers.add(abort);
    let timer;
    let acquiredPool;
    const onClose = () => {
      if (!response.writableFinished) abort.abort(new SourceError(499, 'request_cancelled'));
    };
    request.once('aborted', onClose);
    response.once('close', onClose);
    try {
      if (!request.url || request.url.length > 4_096) throw new SourceError(400, 'invalid_route');
      const url = new URL(request.url, 'http://source.invalid');
      const pool = url.pathname.endsWith('/content') ? 'content' : 'metadata';
      if (active[pool] >= limits[pool]) throw new SourceError(429, `${pool}_busy`);
      active[pool] += 1;
      acquiredPool = pool;
      timer = setTimeout(() => abort.abort(new SourceError(504, 'request_timeout')), timeouts[pool]);
      timer.unref();
      const invoke = (operation) => abortableOperation(operation, abort.signal, pendingOperations);
      if (url.pathname === '/v1/health') {
        if (url.search) throw new SourceError(400, 'invalid_query');
        return json(response, 200, {
          protocolVersion: 1,
          instanceId: catalog.instanceId,
          dataNamespace: catalog.dataNamespace,
          capabilities: ['catalog', 'txt-content'],
          limits: { releaseBytes: MAX_CONTENT_BYTES },
        });
      }
      if (url.pathname === '/v1/sources')
        return json(
          response,
          200,
          await invoke(() =>
            registry.listSources({
              ...parseListParameters(url.searchParams),
              signal: abort.signal,
            }),
          ),
        );
      const match = url.pathname.match(
        /^\/v1\/sources\/([^/]+)\/works(?:\/([^/]+)(?:\/cover|\/releases(?:\/([^/]+)\/content)?)?)?$/u,
      );
      if (!match || match.slice(1).some((id) => id !== undefined && !ID_PATTERN.test(id)))
        throw new SourceError(404, 'not_found');
      const [, sourceId, workId, releaseId] = match;
      const adapter = registry.get(sourceId);
      if (url.pathname.endsWith('/cover')) {
        if (url.search) throw new SourceError(400, 'invalid_query');
        const { bytes, contentType } = await invoke(() => adapter.getCover({ workId, signal: abort.signal }));
        response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': bytes.length });
        return response.end(bytes);
      }
      if (!workId)
        return json(
          response,
          200,
          await invoke(() =>
            adapter.listWorks({
              ...parseListParameters(url.searchParams, { search: true }),
              signal: abort.signal,
            }),
          ),
        );
      if (!url.pathname.endsWith('/releases') && !releaseId) {
        if (url.search) throw new SourceError(400, 'invalid_query');
        return json(response, 200, await invoke(() => adapter.getWork({ workId, signal: abort.signal })));
      }
      if (!releaseId)
        return json(
          response,
          200,
          await invoke(() =>
            adapter.listReleases({
              workId,
              ...parseListParameters(url.searchParams),
              signal: abort.signal,
            }),
          ),
        );
      if (url.search) throw new SourceError(400, 'invalid_query');
      const { bytes, revision } = await invoke(() => adapter.getContent({ workId, releaseId, signal: abort.signal }));
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': bytes.length,
        ETag: revision ?? revisionTag(undefined, bytes),
      });
      response.end(bytes);
    } catch (error) {
      if (response.destroyed) return;
      const safe = error instanceof SourceError ? error : new SourceError(500, 'source_request_failed');
      if (safe.code === 'server_stopping' && !response.headersSent) response.setHeader('Connection', 'close');
      if (!response.headersSent) json(response, safe.status === 499 ? 503 : safe.status, { error: safe.code });
      else response.destroy();
    } finally {
      clearTimeout(timer);
      if (acquiredPool) active[acquiredPool] -= 1;
      controllers.delete(abort);
      request.removeListener('aborted', onClose);
      response.removeListener('close', onClose);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  let stopping;
  server.stop = () =>
    (stopping ??= (async () => {
      for (const controller of controllers) controller.abort(new SourceError(503, 'server_stopping'));
      await Promise.all([
        new Promise((resolve) => {
          const timer = setTimeout(() => server.closeAllConnections(), shutdownGraceMs);
          server.close(() => {
            clearTimeout(timer);
            resolve();
          });
          server.closeIdleConnections();
        }),
        drainCleanup(pendingOperations, shutdownGraceMs),
      ]);
    })());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let server;
  let configuredSources;
  try {
    const { configuredSourcesFromEnvironment } = await import('./source-configuration.mjs');
    configuredSources = await configuredSourcesFromEnvironment(process.env);
    server = await createTextSourceServer({
      catalogFile: process.env.CATALOG_FILE ?? './catalog.json',
      sourceRoot: process.env.SOURCE_ROOT ?? './content',
      serverKey: process.env.SERVER_KEY,
      moyaOrigin: process.env.MOYA_ORIGIN || undefined,
      ...configuredSources,
    });
    const port = Number(process.env.PORT ?? 9970);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SourceError(500, 'invalid_port');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, process.env.HOST ?? '127.0.0.1', resolve);
    });
    console.log('Moya text source server ready (protocol 1).');
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await server.stop();
      await configuredSources.dispose?.();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error(error instanceof SourceError ? error.code : 'text_source_startup_failed');
    server?.close();
    await configuredSources?.dispose?.();
    process.exitCode = 1;
  }
}
