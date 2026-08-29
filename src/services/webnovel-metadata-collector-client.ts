import { detectCoverContentType, MAX_COVER_INPUT_BYTES } from './cover-image';

export const WEBNOVEL_METADATA_COLLECTOR_API_VERSION = 1 as const;
export const WEBNOVEL_METADATA_COLLECTOR_DEFAULT_ENDPOINT = 'http://127.0.0.1:8000';
export const WEBNOVEL_METADATA_COLLECTOR_AUTH_PLATFORMS = ['naver_series', 'kakao_page', 'novelpia', 'ridi'] as const;
export const WEBNOVEL_METADATA_COLLECTOR_PLATFORMS = [
  'munpia',
  'naver_series',
  'kakao_page',
  'novelpia',
  'ridi',
] as const;

export type WebNovelMetadataCollectorAuthPlatform = (typeof WEBNOVEL_METADATA_COLLECTOR_AUTH_PLATFORMS)[number];
export type WebNovelMetadataCollectorPlatform = (typeof WEBNOVEL_METADATA_COLLECTOR_PLATFORMS)[number];
export type WebNovelMetadataCollectorResolveStatus = 'found' | 'not_found' | 'ambiguous' | 'failed';
export type WebNovelMetadataCollectorMatchType = 'exact_title_and_author' | 'exact_title' | 'fuzzy_title' | 'ambiguous';
export type WebNovelMetadataCollectorQuality = 'full' | 'partial';
export type WebNovelMetadataCollectorBrowserPresentation = 'local_window' | 'remote_frame';

export interface WebNovelMetadataCollectorHealth {
  readonly status: 'ok';
  readonly service: 'webnovel-metadata-collector';
  readonly version: string;
  readonly apiVersion: typeof WEBNOVEL_METADATA_COLLECTOR_API_VERSION;
  readonly capabilities: {
    readonly resolve: { readonly version: 1 };
    readonly batchResolve: { readonly version: 1; readonly maxItems: number };
    readonly coverRef: {
      readonly version: 1;
      readonly path: '/api/v1/covers/{cover_ref}';
      readonly ttlSeconds: number;
      readonly maxBytes: number;
      readonly contentTypes: readonly ('image/jpeg' | 'image/png' | 'image/webp')[];
    };
    readonly adultAuth: {
      readonly version: 1;
      readonly available: boolean;
      readonly browserPresentation: WebNovelMetadataCollectorBrowserPresentation;
      readonly platforms: readonly WebNovelMetadataCollectorAuthPlatform[];
    };
  };
}

export interface WebNovelMetadataCollectorAuthStatus {
  readonly available: boolean;
  readonly browserRunning: boolean;
  readonly browserPresentation: WebNovelMetadataCollectorBrowserPresentation;
  readonly enabledPlatforms: readonly WebNovelMetadataCollectorAuthPlatform[];
  readonly lastError?: string;
}

export interface WebNovelMetadataCollectorNovelMetadata {
  readonly title: string;
  readonly author?: string;
  readonly platform: WebNovelMetadataCollectorPlatform;
  readonly platformWorkId: string;
  readonly sourceUrl: string;
  readonly coverUrl?: string;
  readonly description?: string;
  readonly genres: readonly string[];
  readonly tags: readonly string[];
  readonly status?: 'ongoing' | 'completed' | 'hiatus' | 'unknown';
  readonly matchScore: number;
  readonly fetchedAt: string;
}

export interface WebNovelMetadataCollectorResolveResult {
  readonly query: string;
  readonly author?: string;
  readonly status: WebNovelMetadataCollectorResolveStatus;
  readonly confidence: number;
  readonly matchType?: WebNovelMetadataCollectorMatchType;
  readonly metadataQuality?: WebNovelMetadataCollectorQuality;
  readonly metadata?: WebNovelMetadataCollectorNovelMetadata;
  readonly coverRef?: string;
  readonly searchedPlatforms: number;
  readonly failedPlatforms: readonly string[];
  readonly platformErrors: Readonly<Record<string, string>>;
  readonly skippedPlatforms: readonly string[];
  readonly authenticatedSearch: boolean;
  readonly autoApplyEligible: boolean;
  readonly autoApplyReasons: readonly WebNovelMetadataCollectorAutoApplyReason[];
  readonly fetchedAt: string;
}

export type WebNovelMetadataCollectorAutoApplyReason =
  | 'no_result'
  | 'ambiguous_result'
  | 'collector_failed'
  | 'non_exact_match'
  | 'author_not_exact'
  | 'partial_metadata'
  | 'adult_auth_unconfirmed';

export interface WebNovelMetadataCollectorAutomationEvidence {
  readonly autoApplyEligible: boolean;
  readonly matchType?: WebNovelMetadataCollectorMatchType;
  readonly metadataQuality?: WebNovelMetadataCollectorQuality;
  readonly reasons: readonly WebNovelMetadataCollectorAutoApplyReason[];
  readonly authenticatedSearch: boolean;
}

export interface WebNovelMetadataCollectorBatchResolveResult {
  readonly results: readonly WebNovelMetadataCollectorResolveResult[];
  readonly fetchedAt: string;
}

export interface WebNovelMetadataCollectorCover {
  readonly blob: Blob;
  readonly contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly byteLength: number;
}

export interface WebNovelMetadataCollectorBrowserFrame {
  readonly blob: Blob;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
}

export type WebNovelMetadataCollectorBrowserAction =
  | { readonly action: 'click'; readonly x: number; readonly y: number }
  | { readonly action: 'text'; readonly text: string }
  | { readonly action: 'key'; readonly key: string }
  | { readonly action: 'scroll'; readonly deltaY: number }
  | { readonly action: 'back' | 'forward' | 'reload' };

export interface WebNovelMetadataCollectorResolveInput {
  readonly query: string;
  readonly author?: string;
  readonly includeAdult?: boolean;
}

export type WebNovelMetadataCollectorErrorCode =
  | 'invalid_endpoint'
  | 'timeout'
  | 'unavailable'
  | 'incompatible_service'
  | 'invalid_response'
  | 'request_rejected'
  | 'cover_unavailable'
  | 'cover_too_large'
  | 'invalid_cover'
  | 'upstream_unavailable';

export class WebNovelMetadataCollectorError extends Error {
  constructor(
    public readonly code: WebNovelMetadataCollectorErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'WebNovelMetadataCollectorError';
  }
}

const AUTH_PLATFORM_SET = new Set<string>(WEBNOVEL_METADATA_COLLECTOR_AUTH_PLATFORMS);
const PLATFORM_SET = new Set<string>(WEBNOVEL_METADATA_COLLECTOR_PLATFORMS);
const COVER_CONTENT_TYPE_SET = new Set(['image/jpeg', 'image/png', 'image/webp']);
const COVER_REF_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const BROWSER_PRESENTATION_SET = new Set(['local_window', 'remote_frame']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_RESOLVE_RESPONSE_BYTES = 256 * 1024;
const MAX_BATCH_RESOLVE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const MAX_AUTH_BROWSER_FRAME_BYTES = 2 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 5_000;
const AUTH_TIMEOUT_MS = 15_000;
const AUTH_BROWSER_TIMEOUT_MS = 20_000;
const RESOLVE_TIMEOUT_MS = 20_000;
const COVER_TIMEOUT_MS = 20_000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: JsonRecord, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw invalidResponse(`${key} is invalid.`);
  }
  return value.trim();
}

function optionalString(record: JsonRecord, key: string, maxLength: number): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maxLength) throw invalidResponse(`${key} is invalid.`);
  return value.trim() || undefined;
}

function requiredBoolean(record: JsonRecord, key: string): boolean {
  if (typeof record[key] !== 'boolean') throw invalidResponse(`${key} is invalid.`);
  return record[key];
}

function finiteNumber(record: JsonRecord, key: string, minimum: number, maximum: number): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidResponse(`${key} is invalid.`);
  }
  return value;
}

function integer(record: JsonRecord, key: string, minimum: number, maximum: number): number {
  const value = finiteNumber(record, key, minimum, maximum);
  if (!Number.isInteger(value)) throw invalidResponse(`${key} is invalid.`);
  return value;
}

function isoDate(record: JsonRecord, key: string): string {
  const value = requiredString(record, key, 64);
  if (!Number.isFinite(Date.parse(value))) throw invalidResponse(`${key} is invalid.`);
  return value;
}

function stringArray(value: unknown, field: string, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw invalidResponse(`${field} is invalid.`);
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.length > maximumLength) {
      throw invalidResponse(`${field} is invalid.`);
    }
    return item.trim();
  });
}

function optionalEnum<T extends string>(record: JsonRecord, key: string, allowed: ReadonlySet<string>): T | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.has(value)) throw invalidResponse(`${key} is invalid.`);
  return value as T;
}

function invalidResponse(detail: string): WebNovelMetadataCollectorError {
  return new WebNovelMetadataCollectorError(
    'invalid_response',
    `웹소설 정보 수집기가 올바르지 않은 응답을 반환했습니다. (${detail})`,
  );
}

function safeHttpsUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidResponse(`${field} is invalid.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw invalidResponse(`${field} is invalid.`);
  return parsed.toString();
}

function responseContentType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
  tooLargeCode: WebNovelMetadataCollectorErrorCode = 'invalid_response',
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new WebNovelMetadataCollectorError(tooLargeCode, '수집기 응답이 허용 크기를 초과했습니다.');
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw new WebNovelMetadataCollectorError(tooLargeCode, '수집기 응답이 허용 크기를 초과했습니다.');
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new WebNovelMetadataCollectorError(tooLargeCode, '수집기 응답이 허용 크기를 초과했습니다.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const bytes = await readBoundedBytes(response, maximumBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw invalidResponse('response body is not JSON.');
  }
}

async function errorMessage(response: Response): Promise<string | undefined> {
  if (!responseContentType(response).includes('json')) return undefined;
  try {
    const body = await readBoundedJson(response, MAX_ERROR_RESPONSE_BYTES);
    return isRecord(body) ? optionalString(body, 'detail', 500) : undefined;
  } catch {
    return undefined;
  }
}

function httpErrorCode(status: number, cover: boolean): WebNovelMetadataCollectorErrorCode {
  if (cover && status === 404) return 'cover_unavailable';
  if (cover && status === 413) return 'cover_too_large';
  if (cover && status === 415) return 'invalid_cover';
  if (cover && (status === 502 || status === 504)) return 'upstream_unavailable';
  return status >= 500 ? 'unavailable' : 'request_rejected';
}

function httpErrorText(status: number, cover: boolean): string {
  if (cover && status === 404) return '추천 표지가 만료되었거나 더 이상 존재하지 않습니다. 다시 검색해 주세요.';
  if (cover && status === 413) return '추천 표지가 허용 크기를 초과했습니다.';
  if (cover && status === 415) return '추천 표지 형식 또는 이미지 내용이 올바르지 않습니다.';
  if (cover && (status === 502 || status === 504)) return '원본 플랫폼에서 추천 표지를 가져오지 못했습니다.';
  if (status >= 500) return '웹소설 정보 수집기에 연결할 수 없습니다.';
  return '웹소설 정보 수집기가 요청을 처리하지 못했습니다.';
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
  credentials: RequestCredentials = 'omit',
): Promise<Response> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(input, { ...init, credentials, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut) {
      throw new WebNovelMetadataCollectorError('timeout', '웹소설 정보 수집기 응답 시간이 초과되었습니다.');
    }
    if (error instanceof WebNovelMetadataCollectorError) throw error;
    throw new WebNovelMetadataCollectorError('unavailable', '웹소설 정보 수집기에 연결할 수 없습니다.');
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function validateHealth(input: unknown): WebNovelMetadataCollectorHealth {
  if (!isRecord(input)) throw invalidResponse('health response is not an object.');
  if (input.status !== 'ok' || input.service !== 'webnovel-metadata-collector') {
    throw new WebNovelMetadataCollectorError(
      'incompatible_service',
      '설정한 주소가 Moya용 웹소설 정보 수집기가 아닙니다.',
    );
  }
  if (input.api_version !== WEBNOVEL_METADATA_COLLECTOR_API_VERSION) {
    throw new WebNovelMetadataCollectorError('incompatible_service', '지원하지 않는 웹소설 정보 수집기 API입니다.');
  }
  const version = requiredString(input, 'version', 64);
  if (!isRecord(input.capabilities)) throw invalidResponse('capabilities is invalid.');
  const capabilities = input.capabilities;
  const resolve = capabilities.resolve;
  const batchResolve = capabilities.batch_resolve;
  const coverRef = capabilities.cover_ref;
  const adultAuth = capabilities.adult_auth;
  if (!isRecord(resolve) || resolve.version !== 1) throw invalidResponse('resolve capability is invalid.');
  if (!isRecord(batchResolve) || batchResolve.version !== 1)
    throw invalidResponse('batch resolve capability is invalid.');
  if (!isRecord(coverRef) || coverRef.version !== 1) throw invalidResponse('cover ref capability is invalid.');
  if (!isRecord(adultAuth) || adultAuth.version !== 1) throw invalidResponse('adult auth capability is invalid.');
  const path = requiredString(coverRef, 'path', 160);
  if (path !== '/api/v1/covers/{cover_ref}') throw invalidResponse('cover ref path is invalid.');
  const contentTypes = stringArray(coverRef.content_types, 'cover content types', 3, 32);
  if (contentTypes.length === 0 || contentTypes.some((value) => !COVER_CONTENT_TYPE_SET.has(value))) {
    throw invalidResponse('cover content types are invalid.');
  }
  const platforms = stringArray(adultAuth.platforms, 'adult auth platforms', 8, 64);
  if (platforms.some((value) => !AUTH_PLATFORM_SET.has(value))) {
    throw invalidResponse('adult auth platforms are invalid.');
  }
  const maxBytes = integer(coverRef, 'max_bytes', 1, MAX_COVER_INPUT_BYTES);
  const browserPresentation =
    optionalEnum<WebNovelMetadataCollectorBrowserPresentation>(
      adultAuth,
      'browser_presentation',
      BROWSER_PRESENTATION_SET,
    ) ?? 'local_window';
  return {
    status: 'ok',
    service: 'webnovel-metadata-collector',
    version,
    apiVersion: WEBNOVEL_METADATA_COLLECTOR_API_VERSION,
    capabilities: {
      resolve: { version: 1 },
      batchResolve: { version: 1, maxItems: integer(batchResolve, 'max_items', 1, 50) },
      coverRef: {
        version: 1,
        path: '/api/v1/covers/{cover_ref}',
        ttlSeconds: integer(coverRef, 'ttl_seconds', 1, 86_400),
        maxBytes,
        contentTypes: contentTypes as ('image/jpeg' | 'image/png' | 'image/webp')[],
      },
      adultAuth: {
        version: 1,
        available: requiredBoolean(adultAuth, 'available'),
        browserPresentation,
        platforms: platforms as WebNovelMetadataCollectorAuthPlatform[],
      },
    },
  };
}

function validateAuthStatus(input: unknown): WebNovelMetadataCollectorAuthStatus {
  if (!isRecord(input)) throw invalidResponse('auth response is not an object.');
  const enabledPlatforms = stringArray(input.enabled_platforms, 'enabled platforms', 8, 64);
  if (enabledPlatforms.some((value) => !AUTH_PLATFORM_SET.has(value))) {
    throw invalidResponse('enabled platforms are invalid.');
  }
  return {
    available: requiredBoolean(input, 'available'),
    browserRunning: requiredBoolean(input, 'browser_running'),
    browserPresentation:
      optionalEnum<WebNovelMetadataCollectorBrowserPresentation>(
        input,
        'browser_presentation',
        BROWSER_PRESENTATION_SET,
      ) ?? 'local_window',
    enabledPlatforms: enabledPlatforms as WebNovelMetadataCollectorAuthPlatform[],
    lastError: optionalString(input, 'last_error', 500),
  };
}

const NOVEL_STATUS_SET = new Set(['ongoing', 'completed', 'hiatus', 'unknown']);
const MATCH_TYPE_SET = new Set(['exact_title_and_author', 'exact_title', 'fuzzy_title', 'ambiguous']);
const QUALITY_SET = new Set(['full', 'partial']);
const RESOLVE_STATUS_SET = new Set(['found', 'not_found', 'ambiguous', 'failed']);

function validateNovelMetadata(input: unknown): WebNovelMetadataCollectorNovelMetadata {
  if (!isRecord(input)) throw invalidResponse('metadata is invalid.');
  const platform = requiredString(input, 'platform', 64);
  if (!PLATFORM_SET.has(platform)) throw invalidResponse('platform is invalid.');
  return {
    title: requiredString(input, 'title', 300),
    author: optionalString(input, 'author', 300),
    platform: platform as WebNovelMetadataCollectorPlatform,
    platformWorkId: requiredString(input, 'platform_work_id', 200),
    sourceUrl: safeHttpsUrl(requiredString(input, 'source_url', 2_048), 'source_url'),
    coverUrl: optionalString(input, 'cover_url', 2_048)
      ? safeHttpsUrl(requiredString(input, 'cover_url', 2_048), 'cover_url')
      : undefined,
    description: optionalString(input, 'description', 20_000),
    genres: stringArray(input.genres, 'genres', 100, 200),
    tags: stringArray(input.tags, 'tags', 100, 200),
    status: optionalEnum(input, 'status', NOVEL_STATUS_SET),
    matchScore: finiteNumber(input, 'match_score', 0, 1),
    fetchedAt: isoDate(input, 'fetched_at'),
  };
}

function validatePlatformErrors(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.keys(value).length > 16) throw invalidResponse('platform errors are invalid.');
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim() || key.length > 64 || typeof item !== 'string' || item.length > 1_000) {
      throw invalidResponse('platform errors are invalid.');
    }
    result[key] = item;
  }
  return result;
}

function validateResolveResult(
  input: unknown,
  request: Pick<WebNovelMetadataCollectorResolveInput, 'author' | 'includeAdult'> = {},
): WebNovelMetadataCollectorResolveResult {
  if (!isRecord(input)) throw invalidResponse('resolve response is not an object.');
  const status = optionalEnum<WebNovelMetadataCollectorResolveStatus>(input, 'status', RESOLVE_STATUS_SET);
  if (!status) throw invalidResponse('status is invalid.');
  const metadata =
    input.metadata === undefined || input.metadata === null ? undefined : validateNovelMetadata(input.metadata);
  if (status === 'found' && !metadata) throw invalidResponse('found result has no metadata.');
  const coverRefValue = input.cover_ref;
  let coverRef: string | undefined;
  if (coverRefValue !== undefined && coverRefValue !== null) {
    if (typeof coverRefValue !== 'string' || !COVER_REF_PATTERN.test(coverRefValue)) {
      throw invalidResponse('cover_ref is invalid.');
    }
    coverRef = coverRefValue;
  }
  const matchType = optionalEnum<WebNovelMetadataCollectorMatchType>(input, 'match_type', MATCH_TYPE_SET);
  const metadataQuality = optionalEnum<WebNovelMetadataCollectorQuality>(input, 'metadata_quality', QUALITY_SET);
  const authenticatedSearch = requiredBoolean(input, 'authenticated_search');
  const autoApplyReasons: WebNovelMetadataCollectorAutoApplyReason[] = [];
  if (status === 'not_found') autoApplyReasons.push('no_result');
  if (status === 'ambiguous') autoApplyReasons.push('ambiguous_result');
  if (status === 'failed') autoApplyReasons.push('collector_failed');
  if (status === 'found' && matchType !== 'exact_title' && matchType !== 'exact_title_and_author') {
    autoApplyReasons.push('non_exact_match');
  }
  if (status === 'found' && request.author?.trim() && matchType !== 'exact_title_and_author') {
    autoApplyReasons.push('author_not_exact');
  }
  if (status === 'found' && metadataQuality !== 'full') autoApplyReasons.push('partial_metadata');
  if ((request.includeAdult || metadata?.tags.includes('19금')) && !authenticatedSearch) {
    autoApplyReasons.push('adult_auth_unconfirmed');
  }
  return {
    query: requiredString(input, 'query', 100),
    author: optionalString(input, 'author', 100),
    status,
    confidence: finiteNumber(input, 'confidence', 0, 1),
    matchType,
    metadataQuality,
    metadata,
    coverRef,
    searchedPlatforms: integer(input, 'searched_platforms', 0, 32),
    failedPlatforms: stringArray(input.failed_platforms, 'failed platforms', 16, 64),
    platformErrors: validatePlatformErrors(input.platform_errors),
    skippedPlatforms: stringArray(input.skipped_platforms, 'skipped platforms', 16, 64),
    authenticatedSearch,
    autoApplyEligible: status === 'found' && autoApplyReasons.length === 0,
    autoApplyReasons,
    fetchedAt: isoDate(input, 'fetched_at'),
  };
}

function validateBatchResolveResult(
  input: unknown,
  requests: readonly WebNovelMetadataCollectorResolveInput[],
): WebNovelMetadataCollectorBatchResolveResult {
  if (!isRecord(input) || !Array.isArray(input.results) || input.results.length !== requests.length) {
    throw invalidResponse('batch resolve response is invalid.');
  }
  return {
    results: input.results.map((result, index) => validateResolveResult(result, requests[index])),
    fetchedAt: isoDate(input, 'fetched_at'),
  };
}

export function webNovelMetadataCollectorAutomationEvidence(
  result: WebNovelMetadataCollectorResolveResult,
): WebNovelMetadataCollectorAutomationEvidence {
  return {
    autoApplyEligible: result.autoApplyEligible,
    matchType: result.matchType,
    metadataQuality: result.metadataQuality,
    reasons: [...result.autoApplyReasons],
    authenticatedSearch: result.authenticatedSearch,
  };
}

export function normalizeWebNovelMetadataCollectorEndpoint(
  value: string,
  options: { readonly allowHttp?: boolean } = {},
): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new WebNovelMetadataCollectorError('invalid_endpoint', '웹소설 정보 수집기 주소가 올바르지 않습니다.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol === 'http:' && !options.allowHttp && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()))
  ) {
    throw new WebNovelMetadataCollectorError(
      'invalid_endpoint',
      '수집기 주소는 로컬 HTTP 또는 자격 정보가 없는 HTTPS 주소여야 합니다.',
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
  return parsed.toString().replace(/\/$/u, '');
}

function serviceUrl(endpoint: string, relativePath: string): URL {
  return new URL(relativePath.replace(/^\/+/, ''), `${endpoint}/`);
}

export class WebNovelMetadataCollectorClient {
  readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly options: {
      readonly credentials?: RequestCredentials;
      readonly allowHttp?: boolean;
    } = {},
  ) {
    this.endpoint = normalizeWebNovelMetadataCollectorEndpoint(endpoint, { allowHttp: options.allowHttp });
  }

  private async requestJson(
    relativePath: string,
    init: RequestInit,
    maximumBytes: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      serviceUrl(this.endpoint, relativePath),
      {
        ...init,
        cache: 'no-store',
        redirect: 'error',
        headers: { Accept: 'application/json', ...init.headers },
      },
      timeoutMs,
      signal,
      this.options.credentials,
    );
    if (!response.ok) {
      const detail = await errorMessage(response);
      throw new WebNovelMetadataCollectorError(
        httpErrorCode(response.status, false),
        detail ?? httpErrorText(response.status, false),
        response.status,
      );
    }
    if (!responseContentType(response).includes('json')) throw invalidResponse('content type is not JSON.');
    return readBoundedJson(response, maximumBytes);
  }

  async health(signal?: AbortSignal): Promise<WebNovelMetadataCollectorHealth> {
    return validateHealth(
      await this.requestJson('health', { method: 'GET' }, MAX_HEALTH_RESPONSE_BYTES, HEALTH_TIMEOUT_MS, signal),
    );
  }

  async resolve(
    input: WebNovelMetadataCollectorResolveInput,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorResolveResult> {
    const query = input.query.trim();
    const author = input.author?.trim();
    if (query.length < 2 || query.length > 100 || (author && author.length > 100)) {
      throw new WebNovelMetadataCollectorError('request_rejected', '검색할 작품명 또는 작가명이 올바르지 않습니다.');
    }
    const parameters = new URLSearchParams({ q: query, include_adult: input.includeAdult ? 'true' : 'false' });
    if (author) parameters.set('author', author);
    return validateResolveResult(
      await this.requestJson(
        `api/v1/resolve?${parameters.toString()}`,
        { method: 'GET' },
        MAX_RESOLVE_RESPONSE_BYTES,
        RESOLVE_TIMEOUT_MS,
        signal,
      ),
      input,
    );
  }

  async resolveBatch(
    inputs: readonly WebNovelMetadataCollectorResolveInput[],
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorBatchResolveResult> {
    if (inputs.length === 0 || inputs.length > 50) {
      throw new WebNovelMetadataCollectorError('request_rejected', '일괄 검색은 1권부터 50권까지 요청할 수 있습니다.');
    }
    const items = inputs.map((input) => {
      const query = input.query.trim();
      const author = input.author?.trim();
      if (query.length < 2 || query.length > 100 || (author && author.length > 100)) {
        throw new WebNovelMetadataCollectorError('request_rejected', '검색할 작품명 또는 작가명이 올바르지 않습니다.');
      }
      return {
        query,
        ...(author ? { author } : undefined),
        include_adult: input.includeAdult ?? false,
      };
    });
    return validateBatchResolveResult(
      await this.requestJson(
        'api/v1/resolve/batch',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        },
        MAX_BATCH_RESOLVE_RESPONSE_BYTES,
        RESOLVE_TIMEOUT_MS,
        signal,
      ),
      inputs,
    );
  }

  async downloadCover(coverRef: string, signal?: AbortSignal): Promise<WebNovelMetadataCollectorCover> {
    if (!COVER_REF_PATTERN.test(coverRef)) {
      throw new WebNovelMetadataCollectorError('request_rejected', '추천 표지 참조가 올바르지 않습니다.');
    }
    const response = await fetchWithTimeout(
      this.fetchImpl,
      serviceUrl(this.endpoint, `api/v1/covers/${encodeURIComponent(coverRef)}`),
      {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        headers: { Accept: 'image/jpeg,image/png,image/webp' },
      },
      COVER_TIMEOUT_MS,
      signal,
      this.options.credentials,
    );
    if (!response.ok) {
      const detail = await errorMessage(response);
      throw new WebNovelMetadataCollectorError(
        httpErrorCode(response.status, true),
        detail ?? httpErrorText(response.status, true),
        response.status,
      );
    }
    const declaredContentType = responseContentType(response);
    if (!COVER_CONTENT_TYPE_SET.has(declaredContentType)) {
      throw new WebNovelMetadataCollectorError('invalid_cover', '추천 표지 응답 형식을 지원하지 않습니다.');
    }
    const bytes = await readBoundedBytes(response, MAX_COVER_INPUT_BYTES, 'cover_too_large');
    if (bytes.byteLength === 0) {
      throw new WebNovelMetadataCollectorError('invalid_cover', '추천 표지 응답이 비어 있습니다.');
    }
    const detectedContentType = detectCoverContentType(bytes.subarray(0, 16));
    if (!detectedContentType || detectedContentType !== declaredContentType) {
      throw new WebNovelMetadataCollectorError('invalid_cover', '추천 표지 형식과 실제 이미지가 일치하지 않습니다.');
    }
    const binary = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(binary).set(bytes);
    return {
      blob: new Blob([binary], { type: detectedContentType }),
      contentType: detectedContentType,
      byteLength: bytes.byteLength,
    };
  }

  async authStatus(signal?: AbortSignal): Promise<WebNovelMetadataCollectorAuthStatus> {
    return validateAuthStatus(
      await this.requestJson('api/v1/auth/status', { method: 'GET' }, MAX_AUTH_RESPONSE_BYTES, AUTH_TIMEOUT_MS, signal),
    );
  }

  async openAuthBrowser(
    platform: WebNovelMetadataCollectorAuthPlatform,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorAuthStatus> {
    const viewportWidth = Math.max(360, Math.min(1_280, Math.floor(globalThis.innerWidth || 1_280)));
    const viewportHeight = Math.max(480, Math.min(900, Math.floor(globalThis.innerHeight || 800)));
    return this.authMutation(
      `api/v1/auth/${platform}/open`,
      'POST',
      { requested: true, viewport_width: viewportWidth, viewport_height: viewportHeight },
      signal,
    );
  }

  async setAuthPlatformEnabled(
    platform: WebNovelMetadataCollectorAuthPlatform,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorAuthStatus> {
    return this.authMutation(`api/v1/auth/${platform}`, 'PUT', { enabled }, signal);
  }

  async closeAuthBrowser(signal?: AbortSignal): Promise<WebNovelMetadataCollectorAuthStatus> {
    return this.authMutation('api/v1/auth/browser/close', 'POST', { requested: true }, signal);
  }

  async clearAuthSession(signal?: AbortSignal): Promise<WebNovelMetadataCollectorAuthStatus> {
    return validateAuthStatus(
      await this.requestJson(
        'api/v1/auth/session',
        { method: 'DELETE' },
        MAX_AUTH_RESPONSE_BYTES,
        AUTH_TIMEOUT_MS,
        signal,
      ),
    );
  }

  async authBrowserFrame(
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorBrowserFrame | undefined> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new WebNovelMetadataCollectorError('request_rejected', '원격 로그인 화면 버전이 올바르지 않습니다.');
    }
    const response = await fetchWithTimeout(
      this.fetchImpl,
      serviceUrl(this.endpoint, `api/v1/auth/browser/frame?after_revision=${afterRevision}`),
      {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        headers: { Accept: 'image/jpeg' },
      },
      AUTH_BROWSER_TIMEOUT_MS,
      signal,
      this.options.credentials,
    );
    if (response.status === 204) return undefined;
    if (!response.ok) {
      const detail = await errorMessage(response);
      throw new WebNovelMetadataCollectorError(
        httpErrorCode(response.status, false),
        detail ?? httpErrorText(response.status, false),
        response.status,
      );
    }
    if (responseContentType(response) !== 'image/jpeg') throw invalidResponse('auth browser frame is not JPEG.');
    const revision = Number(response.headers.get('x-moya-frame-revision'));
    const width = Number(response.headers.get('x-moya-frame-width'));
    const height = Number(response.headers.get('x-moya-frame-height'));
    if (
      !Number.isSafeInteger(revision) ||
      revision <= afterRevision ||
      !Number.isSafeInteger(width) ||
      width < 320 ||
      width > 1920 ||
      !Number.isSafeInteger(height) ||
      height < 240 ||
      height > 1200
    ) {
      throw invalidResponse('auth browser frame metadata is invalid.');
    }
    const bytes = await readBoundedBytes(response, MAX_AUTH_BROWSER_FRAME_BYTES);
    if (bytes.byteLength === 0 || detectCoverContentType(bytes.subarray(0, 16)) !== 'image/jpeg') {
      throw invalidResponse('auth browser frame bytes are invalid.');
    }
    const binary = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(binary).set(bytes);
    return { blob: new Blob([binary], { type: 'image/jpeg' }), revision, width, height };
  }

  async authBrowserAction(action: WebNovelMetadataCollectorBrowserAction, signal?: AbortSignal): Promise<void> {
    const payload = action.action === 'scroll' ? { action: action.action, delta_y: action.deltaY } : action;
    const response = await fetchWithTimeout(
      this.fetchImpl,
      serviceUrl(this.endpoint, 'api/v1/auth/browser/action'),
      {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      AUTH_BROWSER_TIMEOUT_MS,
      signal,
      this.options.credentials,
    );
    if (!response.ok) {
      const detail = await errorMessage(response);
      throw new WebNovelMetadataCollectorError(
        httpErrorCode(response.status, false),
        detail ?? httpErrorText(response.status, false),
        response.status,
      );
    }
  }

  private async authMutation(
    path: string,
    method: 'POST' | 'PUT',
    body: Readonly<Record<string, boolean | number>>,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorAuthStatus> {
    return validateAuthStatus(
      await this.requestJson(
        path,
        { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        MAX_AUTH_RESPONSE_BYTES,
        AUTH_TIMEOUT_MS,
        signal,
      ),
    );
  }
}
