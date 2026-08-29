import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerConfig } from '../config.js';

const GATEWAY_PREFIX = '/api/integrations/webnovel-metadata';
const HEALTH_RESPONSE_LIMIT = 64 * 1024;
const RESOLVE_RESPONSE_LIMIT = 256 * 1024;
const BATCH_RESPONSE_LIMIT = 2 * 1024 * 1024;
const COVER_RESPONSE_LIMIT = 10 * 1024 * 1024;
const AUTH_RESPONSE_LIMIT = 64 * 1024;
const AUTH_FRAME_RESPONSE_LIMIT = 2 * 1024 * 1024;
const AUTH_ACTION_BODY_LIMIT = 16 * 1024;
const GATEWAY_REQUEST_BODY_LIMIT = 2 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 6_000;
const RESOLVE_TIMEOUT_MS = 25_000;
const COVER_TIMEOUT_MS = 25_000;
const AUTH_TIMEOUT_MS = 40_000;
const AUTH_FRAME_TIMEOUT_MS = 12_000;
const COVER_REF_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const AUTH_PLATFORMS = new Set(['naver_series', 'kakao_page', 'novelpia', 'ridi']);
const AUTH_FRAME_HEADERS = ['x-moya-frame-revision', 'x-moya-frame-width', 'x-moya-frame-height'] as const;

export interface WebNovelMetadataCollectorGatewayOptions {
  readonly fetchImpl?: typeof fetch;
}

class CollectorResponseTooLargeError extends Error {}

function gatewayError(reply: FastifyReply, status: number, detail: string) {
  return reply
    .code(status)
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send({ detail });
}

function querySuffix(requestUrl: string): string {
  const index = requestUrl.indexOf('?');
  return index >= 0 ? requestUrl.slice(index) : '';
}

function safeResponseContentType(value: string | null): string {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    normalized === 'application/json' ||
    normalized === 'image/jpeg' ||
    normalized === 'image/png' ||
    normalized === 'image/webp'
  ) {
    return normalized;
  }
  return 'application/octet-stream';
}

function projectRemoteAdultAuth(body: Buffer, enabled: boolean): Buffer {
  let document: unknown;
  try {
    document = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('collector_health_invalid');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('collector_health_invalid');
  }
  const record = document as Record<string, unknown>;
  const capabilities = record.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new Error('collector_health_invalid');
  }
  const adultAuth = (capabilities as Record<string, unknown>).adult_auth;
  if (!adultAuth || typeof adultAuth !== 'object' || Array.isArray(adultAuth)) {
    throw new Error('collector_health_invalid');
  }
  const adultAuthRecord = adultAuth as Record<string, unknown>;
  const presentation = adultAuthRecord.browser_presentation;
  const available = enabled && adultAuthRecord.available === true && presentation === 'remote_frame';
  return Buffer.from(
    JSON.stringify({
      ...record,
      capabilities: {
        ...(capabilities as Record<string, unknown>),
        adult_auth: { ...adultAuthRecord, available },
      },
    }),
  );
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new CollectorResponseTooLargeError();
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks, total);
}

async function proxyCollectorRequest(input: {
  readonly reply: FastifyReply;
  readonly baseUrl: string | undefined;
  readonly path: string;
  readonly init: RequestInit;
  readonly timeoutMs: number;
  readonly maximumBytes: number;
  readonly fetchImpl: typeof fetch;
  readonly transformHealth?: boolean;
  readonly remoteAuthEnabled?: boolean;
  readonly passthroughHeaders?: readonly string[];
}) {
  if (!input.baseUrl) {
    return gatewayError(input.reply, 503, '웹소설 정보 수집기가 이 서버에서 사용 설정되지 않았습니다.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: Response;
  try {
    response = await input.fetchImpl(new URL(input.path.replace(/^\/+/, ''), `${input.baseUrl}/`), {
      ...input.init,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: input.transformHealth ? 'application/json' : '*/*',
        ...input.init.headers,
      },
    });
  } catch {
    clearTimeout(timer);
    return gatewayError(input.reply, 503, '웹소설 정보 수집기에 연결할 수 없습니다.');
  }

  if (response.status >= 300 && response.status < 400) {
    clearTimeout(timer);
    return gatewayError(input.reply, 502, '웹소설 정보 수집기가 예상하지 못한 응답을 반환했습니다.');
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > input.maximumBytes) {
    clearTimeout(timer);
    return gatewayError(input.reply, 502, '웹소설 정보 수집기 응답이 허용 크기를 초과했습니다.');
  }

  let body: Buffer;
  try {
    body = await readBoundedResponse(response, input.maximumBytes);
  } catch (error) {
    return gatewayError(
      input.reply,
      502,
      error instanceof CollectorResponseTooLargeError
        ? '웹소설 정보 수집기 응답이 허용 크기를 초과했습니다.'
        : '웹소설 정보 수집기 응답을 읽지 못했습니다.',
    );
  } finally {
    clearTimeout(timer);
  }
  if (input.transformHealth && response.ok) {
    try {
      body = projectRemoteAdultAuth(body, input.remoteAuthEnabled === true);
    } catch {
      return gatewayError(input.reply, 502, '웹소설 정보 수집기가 올바르지 않은 상태를 반환했습니다.');
    }
  }

  input.reply
    .code(response.status)
    .type(safeResponseContentType(response.headers.get('content-type')))
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff');
  for (const name of input.passthroughHeaders ?? []) {
    const value = response.headers.get(name);
    if (value) input.reply.header(name, value);
  }
  return input.reply.send(body);
}

export async function registerWebNovelMetadataCollectorGateway(
  app: FastifyInstance,
  config: ServerConfig,
  options: WebNovelMetadataCollectorGatewayOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = config.webNovelMetadataCollectorUrl;
  const remoteAuthEnabled = config.webNovelMetadataCollectorRemoteAuthEnabled === true;

  const requireRemoteAuth = (reply: FastifyReply) => {
    if (remoteAuthEnabled) return true;
    gatewayError(reply, 503, '이 서버에서는 19세 검색용 로그인 브라우저를 사용 설정하지 않았습니다.');
    return false;
  };

  app.get(`${GATEWAY_PREFIX}/health`, async (_request, reply) =>
    proxyCollectorRequest({
      reply,
      baseUrl,
      path: '/health',
      init: { method: 'GET' },
      timeoutMs: HEALTH_TIMEOUT_MS,
      maximumBytes: HEALTH_RESPONSE_LIMIT,
      fetchImpl,
      transformHealth: true,
      remoteAuthEnabled,
    }),
  );

  app.get(`${GATEWAY_PREFIX}/api/v1/resolve`, async (request, reply) =>
    proxyCollectorRequest({
      reply,
      baseUrl,
      path: `/api/v1/resolve${querySuffix(request.url)}`,
      init: { method: 'GET' },
      timeoutMs: RESOLVE_TIMEOUT_MS,
      maximumBytes: RESOLVE_RESPONSE_LIMIT,
      fetchImpl,
    }),
  );

  app.post(
    `${GATEWAY_PREFIX}/api/v1/resolve/batch`,
    { bodyLimit: GATEWAY_REQUEST_BODY_LIMIT },
    async (request, reply) =>
      proxyCollectorRequest({
        reply,
        baseUrl,
        path: '/api/v1/resolve/batch',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        },
        timeoutMs: RESOLVE_TIMEOUT_MS,
        maximumBytes: BATCH_RESPONSE_LIMIT,
        fetchImpl,
      }),
  );

  app.get<{ Params: { coverRef: string } }>(`${GATEWAY_PREFIX}/api/v1/covers/:coverRef`, async (request, reply) => {
    if (!COVER_REF_PATTERN.test(request.params.coverRef)) {
      return gatewayError(reply, 400, '표지 참조가 올바르지 않습니다.');
    }
    return proxyCollectorRequest({
      reply,
      baseUrl,
      path: `/api/v1/covers/${encodeURIComponent(request.params.coverRef)}`,
      init: { method: 'GET' },
      timeoutMs: COVER_TIMEOUT_MS,
      maximumBytes: COVER_RESPONSE_LIMIT,
      fetchImpl,
    });
  });

  app.get(`${GATEWAY_PREFIX}/api/v1/auth/status`, async (_request, reply) => {
    if (!requireRemoteAuth(reply)) return reply;
    return proxyCollectorRequest({
      reply,
      baseUrl,
      path: '/api/v1/auth/status',
      init: { method: 'GET' },
      timeoutMs: AUTH_TIMEOUT_MS,
      maximumBytes: AUTH_RESPONSE_LIMIT,
      fetchImpl,
    });
  });

  app.post<{ Params: { platform: string } }>(
    `${GATEWAY_PREFIX}/api/v1/auth/:platform/open`,
    { bodyLimit: AUTH_ACTION_BODY_LIMIT },
    async (request, reply) => {
      if (!requireRemoteAuth(reply)) return reply;
      if (!AUTH_PLATFORMS.has(request.params.platform)) {
        return gatewayError(reply, 404, '지원하지 않는 인증 플랫폼입니다.');
      }
      return proxyCollectorRequest({
        reply,
        baseUrl,
        path: `/api/v1/auth/${encodeURIComponent(request.params.platform)}/open`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        },
        timeoutMs: AUTH_TIMEOUT_MS,
        maximumBytes: AUTH_RESPONSE_LIMIT,
        fetchImpl,
      });
    },
  );

  app.put<{ Params: { platform: string } }>(
    `${GATEWAY_PREFIX}/api/v1/auth/:platform`,
    { bodyLimit: AUTH_ACTION_BODY_LIMIT },
    async (request, reply) => {
      if (!requireRemoteAuth(reply)) return reply;
      if (!AUTH_PLATFORMS.has(request.params.platform)) {
        return gatewayError(reply, 404, '지원하지 않는 인증 플랫폼입니다.');
      }
      return proxyCollectorRequest({
        reply,
        baseUrl,
        path: `/api/v1/auth/${encodeURIComponent(request.params.platform)}`,
        init: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        },
        timeoutMs: AUTH_TIMEOUT_MS,
        maximumBytes: AUTH_RESPONSE_LIMIT,
        fetchImpl,
      });
    },
  );

  app.post(
    `${GATEWAY_PREFIX}/api/v1/auth/browser/close`,
    { bodyLimit: AUTH_ACTION_BODY_LIMIT },
    async (request, reply) => {
      if (!requireRemoteAuth(reply)) return reply;
      return proxyCollectorRequest({
        reply,
        baseUrl,
        path: '/api/v1/auth/browser/close',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        },
        timeoutMs: AUTH_TIMEOUT_MS,
        maximumBytes: AUTH_RESPONSE_LIMIT,
        fetchImpl,
      });
    },
  );

  app.delete(`${GATEWAY_PREFIX}/api/v1/auth/session`, async (_request, reply) => {
    if (!requireRemoteAuth(reply)) return reply;
    return proxyCollectorRequest({
      reply,
      baseUrl,
      path: '/api/v1/auth/session',
      init: { method: 'DELETE' },
      timeoutMs: AUTH_TIMEOUT_MS,
      maximumBytes: AUTH_RESPONSE_LIMIT,
      fetchImpl,
    });
  });

  app.get(`${GATEWAY_PREFIX}/api/v1/auth/browser/frame`, async (request, reply) => {
    if (!requireRemoteAuth(reply)) return reply;
    return proxyCollectorRequest({
      reply,
      baseUrl,
      path: `/api/v1/auth/browser/frame${querySuffix(request.url)}`,
      init: { method: 'GET' },
      timeoutMs: AUTH_FRAME_TIMEOUT_MS,
      maximumBytes: AUTH_FRAME_RESPONSE_LIMIT,
      fetchImpl,
      passthroughHeaders: AUTH_FRAME_HEADERS,
    });
  });

  app.post(
    `${GATEWAY_PREFIX}/api/v1/auth/browser/action`,
    { bodyLimit: AUTH_ACTION_BODY_LIMIT },
    async (request, reply) => {
      if (!requireRemoteAuth(reply)) return reply;
      return proxyCollectorRequest({
        reply,
        baseUrl,
        path: '/api/v1/auth/browser/action',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        },
        timeoutMs: AUTH_TIMEOUT_MS,
        maximumBytes: AUTH_RESPONSE_LIMIT,
        fetchImpl,
      });
    },
  );
}
