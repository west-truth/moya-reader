import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';

const PREFIX = '/api/integrations/text-sources';
const ID = '[A-Za-z0-9_-]{1,128}';
const ROUTE = new RegExp(
  `^/v1/(?:health|sources(?:/${ID}/works(?:/${ID}(?:/cover|/releases(?:/${ID}/content)?)?)?)?)$`,
);
const MAX_ERROR_BYTES = 8 * 1024;
// Exact protocol codes only. Provider messages, URLs, and arbitrary diagnostic codes stay upstream.
const SAFE_ERROR_CODES = new Set([
  'authentication_required',
  'origin_rejected',
  'content_provider_not_configured',
  'invalid_content_provider_configuration',
  'content_provider_authentication_required',
  'content_provider_busy',
  'content_provider_unavailable',
  'content_provider_request_failed',
  'content_provider_job_failed',
  'content_provider_request_timeout',
  'content_provider_body_timeout',
  'content_provider_invalid_manifest',
  'content_provider_invalid_response',
  'content_provider_invalid_job',
  'content_provider_response_limit',
  'source_authentication_required',
  'source_access_required',
  'source_verification_required',
  'source_busy',
  'source_timeout',
  'source_request_failed',
  'source_browser_unavailable',
  'source_invalid_response',
  'source_invalid_json',
  'source_invalid_metadata',
  'source_catalog_changed',
  'source_catalog_limit',
  'source_pagination_stalled',
  'source_size_limit',
  'content_unavailable',
  'not_found',
  'invalid_pagination',
  'invalid_utf8_content',
  'request_timeout',
  'content_busy',
  'metadata_busy',
  'server_stopping',
]);

function upstreamErrorCode(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const code = (value as Record<string, unknown>).error;
    if (typeof code === 'string' && SAFE_ERROR_CODES.has(code)) return code;
  }
  return 'source_request_failed';
}

function upstreamErrorStatus(status: number): number {
  // A companion/provider login problem must never invalidate the user's Moya session.
  return [404, 409, 413, 422, 429, 503, 504].includes(status) ? status : 502;
}

/** Registered behind Moya's existing account/session authentication hook. */
export async function registerTextSourceGateway(
  app: FastifyInstance,
  config: ServerConfig,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  app.get(`${PREFIX}/*`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (!config.textSourceServerUrl || !config.textSourceServerKey) {
      return reply.code(503).send({
        error: 'text_source_server_not_configured',
        detail: '텍스트 소스 서버가 설정되지 않았습니다.',
      });
    }
    const incoming = new URL(request.url, 'http://moya.invalid');
    const path = incoming.pathname.slice(PREFIX.length);
    if (
      !ROUTE.test(path) ||
      incoming.search.length > 2048 ||
      [...incoming.searchParams.keys()].some((key) => key !== 'query' && key !== 'cursor')
    ) {
      return reply.code(400).send({ detail: '지원하지 않는 텍스트 소스 요청입니다.' });
    }
    const content = path.endsWith('/content');
    const cover = path.endsWith('/cover');
    const abort = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    request.raw.once('aborted', cancel);
    reply.raw.once('close', cancel);
    const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? (content ? 130_000 : 15_000));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelBody = () => {
      void reader?.cancel().catch(() => undefined);
    };
    abort.signal.addEventListener('abort', cancelBody, { once: true });
    try {
      const response = await fetchImpl(`${config.textSourceServerUrl}${path}${incoming.search}`, {
        method: 'GET',
        redirect: 'error',
        signal: abort.signal,
        // Browser/Moya credentials and Fetch Metadata never reach the companion.
        headers: {
          Accept: cover ? 'image/jpeg, image/png, image/webp' : content ? 'text/plain' : 'application/json',
          Authorization: `Bearer ${config.textSourceServerKey}`,
        },
      });
      if (!response.body) {
        return reply
          .code(upstreamErrorStatus(response.status))
          .send({ error: 'source_request_failed', detail: '텍스트 소스 요청을 완료하지 못했습니다.' });
      }
      const maximumBytes = !response.ok
        ? MAX_ERROR_BYTES
        : cover
          ? 8 * 1024 * 1024
          : content
            ? 2 * 1024 * 1024
            : 1024 * 1024;
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (
        !(
          response.ok && cover
            ? ['image/jpeg', 'image/png', 'image/webp']
            : [!response.ok || !content ? 'application/json' : 'text/plain']
        ).includes(mime ?? '') ||
        Number(response.headers.get('content-length')) > maximumBytes
      ) {
        await response.body.cancel();
        return reply.code(502).send({
          error: 'source_invalid_response',
          detail: '텍스트 소스 응답 형식 또는 크기가 올바르지 않습니다.',
        });
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        abort.signal.throwIfAborted();
        const idle = setTimeout(() => abort.abort(), Math.min(options.timeoutMs ?? 10_000, 10_000));
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } finally {
          clearTimeout(idle);
        }
        abort.signal.throwIfAborted();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > maximumBytes) throw new Error('response_limit');
        chunks.push(chunk.value);
      }
      const body = Buffer.concat(chunks);
      if (!response.ok) {
        const error = upstreamErrorCode(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
        return reply
          .code(upstreamErrorStatus(response.status))
          .send({ error, detail: '텍스트 소스 요청을 완료하지 못했습니다.' });
      }
      if (content) new TextDecoder('utf-8', { fatal: true }).decode(body);
      else if (!cover) JSON.parse(body.toString('utf8'));
      const etag = response.headers.get('etag');
      if (etag && etag.length < 256 && !/[\r\n]/u.test(etag)) reply.header('ETag', etag);
      const namespace = response.headers.get('x-moya-source-namespace');
      if (namespace && namespace.length <= 4096 && !/[\r\n]/u.test(namespace)) {
        reply.header('X-Moya-Source-Namespace', namespace);
      }
      return reply.type(cover ? mime! : `${mime};charset=utf-8`).send(body);
    } catch {
      return reply.code(502).send({
        error: abort.signal.aborted ? 'source_timeout' : 'source_request_failed',
        detail: '텍스트 소스 응답이 지연되었거나 올바르지 않습니다. 다시 시도해 주세요.',
      });
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => undefined);
      abort.signal.removeEventListener('abort', cancelBody);
      request.raw.off('aborted', cancel);
      reply.raw.off('close', cancel);
    }
  });
}
