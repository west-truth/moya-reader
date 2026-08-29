import { DropboxAccessTokenManager, type DropboxCredentialStore } from '../cloud-vault/dropbox-provider';
import type {
  DownloadedExternalSource,
  ExternalItemPage,
  ExternalItemSummary,
  ExternalSourceBroker,
  ExternalSourceDownloadRef,
  ExternalSourceListInput,
} from './contracts';

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT_API = 'https://content.dropboxapi.com/2';
const CURSOR_PREFIX = 'dropbox:v1:';
const MAX_PAGE_ITEMS = 1_000;
const MAX_METADATA_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CURSOR_LENGTH = 16 * 1024;
const MAX_WRAPPED_CURSOR_LENGTH = 32 * 1024;
const MAX_REMOTE_ID_LENGTH = 512;
const MAX_ACCOUNT_ID_LENGTH = 512;
const MAX_FILE_NAME_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;
const MAX_QUERY_LENGTH = 256;
const SUPPORTED_IMPORT_FILE = /\.(txt|md|markdown|epub|pdf|zip|cbz|rar|cbr|7z|cb7)$/i;
const HIDDEN_APP_ENTRY_NAMES = new Set(['noveldesk-vault-v1.enc.json', 'content']);

export const DROPBOX_EXTERNAL_SOURCE_SCOPES = ['files.metadata.read', 'files.content.read'] as const;
export const DROPBOX_EXTERNAL_SOURCE_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

type DropboxCursorKind = 'list' | 'search';

interface DropboxCursor {
  readonly kind: DropboxCursorKind;
  readonly value: string;
  readonly accountConnectionId?: string;
  readonly parentRef: string;
  readonly query?: string;
}

type DropboxCursorContext = Omit<DropboxCursor, 'kind' | 'value'>;

interface DropboxPagePayload {
  readonly entries?: unknown;
  readonly matches?: unknown;
  readonly has_more?: unknown;
  readonly cursor?: unknown;
}

function abortError(): DOMException {
  return new DOMException('The Dropbox request was aborted.', 'AbortError');
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function safeDropboxError(operation: 'list' | 'download', status: number): Error {
  const subject = operation === 'list' ? 'Dropbox 목록' : 'Dropbox 파일';
  if (status === 401) return new Error('Dropbox 연결이 만료되었습니다. 다시 연결해 주세요.');
  if (status === 403) return new Error(`${subject} 읽기 권한이 없습니다. Dropbox 연결 권한을 확인해 주세요.`);
  if (status === 409) return new Error(`${subject}이(가) 이동되었거나 변경되어 찾을 수 없습니다.`);
  if (status === 429) return new Error('Dropbox 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  if (status >= 500) return new Error('Dropbox 서비스가 일시적으로 응답하지 않습니다.');
  return new Error(`${subject} 요청을 완료하지 못했습니다. (${status})`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Dropbox ${label} 응답 형식이 올바르지 않습니다.`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new Error(`Dropbox ${label} 응답 형식이 올바르지 않습니다.`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedString(value, label, maxLength);
}

function fileSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Dropbox 파일 크기 응답 형식이 올바르지 않습니다.');
  }
  return value as number;
}

function validateFileName(value: unknown): string {
  const name = boundedString(value, '파일 이름', MAX_FILE_NAME_LENGTH);
  if (/[\\/\0]/.test(name) || name === '.' || name === '..') {
    throw new Error('Dropbox 파일 이름 응답 형식이 올바르지 않습니다.');
  }
  return name;
}

function validateRemoteId(value: unknown): string {
  const id = boundedString(value, '파일 ID', MAX_REMOTE_ID_LENGTH);
  if (!id.startsWith('id:')) throw new Error('Dropbox 파일 ID 응답 형식이 올바르지 않습니다.');
  return id;
}

function extension(name: string): string | undefined {
  const match = /\.([^.]+)$/.exec(name);
  return match?.[1]?.toLowerCase();
}

function mimeTypeFor(name: string): string | undefined {
  switch (extension(name)) {
    case 'txt':
      return 'text/plain';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'epub':
      return 'application/epub+zip';
    case 'pdf':
      return 'application/pdf';
    case 'zip':
    case 'cbz':
      return 'application/zip';
    case 'rar':
    case 'cbr':
      return 'application/vnd.comicbook-rar';
    case '7z':
    case 'cb7':
      return 'application/x-7z-compressed';
    default:
      return undefined;
  }
}

function normalizeUpdatedAt(value: unknown): string | undefined {
  const updatedAt = optionalString(value, '수정 시각', 64);
  if (!updatedAt) return undefined;
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('Dropbox 수정 시각 응답 형식이 올바르지 않습니다.');
  return updatedAt;
}

function subtitleFor(value: unknown, name: string): string | undefined {
  const path = optionalString(value, '경로', MAX_PATH_LENGTH);
  if (!path || path === `/${name}`) return undefined;
  return path;
}

function normalizeMetadata(
  value: unknown,
  connectorId: string,
  accountConnectionId?: string,
  implicitFile = false,
): ExternalItemSummary {
  const metadata = record(value, '항목');
  const tag =
    metadata['.tag'] === undefined && implicitFile ? 'file' : boundedString(metadata['.tag'], '항목 종류', 32);
  const remoteId = validateRemoteId(metadata.id);
  const title = validateFileName(metadata.name);
  const key = { connectorId, accountConnectionId, remoteId } as const;
  if (tag === 'folder') {
    const navigationRef = boundedString(metadata.path_lower, '폴더 경로', MAX_PATH_LENGTH);
    if (!navigationRef.startsWith('/')) throw new Error('Dropbox 폴더 경로 응답 형식이 올바르지 않습니다.');
    return {
      key,
      kind: 'folder',
      title,
      subtitle: subtitleFor(metadata.path_display, title),
      navigationRef,
      importability: 'unsupported',
    };
  }
  if (tag !== 'file') throw new Error('Dropbox 항목 종류를 지원하지 않습니다.');
  const byteLength = fileSize(metadata.size);
  const remoteRevision = boundedString(metadata.rev, '파일 revision', 512);
  const downloadable = metadata.is_downloadable !== false;
  const supported = SUPPORTED_IMPORT_FILE.test(title) && downloadable;
  return {
    key,
    kind: 'file',
    title,
    subtitle: subtitleFor(metadata.path_display, title),
    mimeType: mimeTypeFor(title),
    formatHint: extension(title),
    byteLength,
    remoteRevision,
    updatedAt: normalizeUpdatedAt(metadata.server_modified ?? metadata.client_modified),
    importability: supported && byteLength <= DROPBOX_EXTERNAL_SOURCE_MAX_DOWNLOAD_BYTES ? 'supported' : 'unsupported',
  };
}

function unwrapSearchMetadata(value: unknown): unknown {
  const match = record(value, '검색 항목');
  const metadata = record(match.metadata, '검색 metadata');
  return metadata['.tag'] === 'metadata' ? metadata.metadata : metadata;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeCursor(kind: DropboxCursorKind, value: unknown, context: DropboxCursorContext): string | undefined {
  const cursor = optionalString(value, 'cursor', MAX_CURSOR_LENGTH);
  if (!cursor) return undefined;
  const encoded = `${CURSOR_PREFIX}${bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ kind, value: cursor, ...context } satisfies DropboxCursor)),
  )}`;
  if (encoded.length > MAX_WRAPPED_CURSOR_LENGTH) throw new Error('Dropbox cursor 형식이 올바르지 않습니다.');
  return encoded;
}

function decodeCursor(value: string): DropboxCursor {
  if (!value.startsWith(CURSOR_PREFIX) || value.length > MAX_WRAPPED_CURSOR_LENGTH) {
    throw new Error('Dropbox cursor 형식이 올바르지 않습니다.');
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value.slice(CURSOR_PREFIX.length)))) as Record<
      string,
      unknown
    >;
    if (decoded.kind !== 'list' && decoded.kind !== 'search') throw new Error('invalid kind');
    return {
      kind: decoded.kind,
      value: boundedString(decoded.value, 'cursor', MAX_CURSOR_LENGTH),
      accountConnectionId: optionalString(decoded.accountConnectionId, '계정 ID', MAX_ACCOUNT_ID_LENGTH),
      parentRef: validateParentRef(optionalString(decoded.parentRef, '폴더 경로', MAX_PATH_LENGTH)),
      query: validateQuery(optionalString(decoded.query, '검색어', MAX_QUERY_LENGTH)),
    };
  } catch {
    throw new Error('Dropbox cursor 형식이 올바르지 않습니다.');
  }
}

async function readBoundedBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const contentLength = response.headers.get('Content-Length');
  if (contentLength) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new Error('Dropbox 응답이 허용된 크기를 넘었습니다.');
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('Dropbox 응답이 허용된 크기를 넘었습니다.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      assertNotAborted(signal);
      const chunk = await readChunk(reader, signal);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Dropbox 응답이 허용된 크기를 넘었습니다.');
      }
      chunks.push(chunk.value);
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

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      finish(() => reject(abortError()));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const bytes = await readBoundedBytes(response, MAX_METADATA_RESPONSE_BYTES, signal);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error('Dropbox 목록 응답이 올바른 JSON이 아닙니다.');
  }
}

function parsePage(
  payload: unknown,
  kind: DropboxCursorKind,
  connectorId: string,
  accountConnectionId?: string,
  cursorContext?: DropboxCursorContext,
): ExternalItemPage {
  const page = record(payload, '목록') as DropboxPagePayload;
  const rawItems = kind === 'list' ? page.entries : page.matches;
  if (!Array.isArray(rawItems) || rawItems.length > MAX_PAGE_ITEMS) {
    throw new Error('Dropbox 목록 항목 수가 허용 범위를 벗어났습니다.');
  }
  if (typeof page.has_more !== 'boolean') throw new Error('Dropbox 목록 pagination 응답이 올바르지 않습니다.');
  const items = rawItems
    .map((item) =>
      normalizeMetadata(kind === 'search' ? unwrapSearchMetadata(item) : item, connectorId, accountConnectionId),
    )
    .filter((item) => !HIDDEN_APP_ENTRY_NAMES.has(item.title));
  const nextCursor = page.has_more
    ? encodeCursor(kind, page.cursor, cursorContext ?? { accountConnectionId, parentRef: '' })
    : undefined;
  if (page.has_more && !nextCursor) throw new Error('Dropbox 목록 cursor가 누락되었습니다.');
  return { items, nextCursor };
}

function validateParentRef(value: string | undefined): string {
  if (!value) return '';
  const path = boundedString(value, '폴더 경로', MAX_PATH_LENGTH);
  if (!path.startsWith('/') || path.includes('\0')) throw new Error('Dropbox 폴더 경로 형식이 올바르지 않습니다.');
  return path;
}

function validateQuery(value: string | undefined): string | undefined {
  const query = value?.trim();
  if (!query) return undefined;
  if (query.length > MAX_QUERY_LENGTH) throw new Error('Dropbox 검색어가 너무 깁니다.');
  return query;
}

/** Read-only, host-owned Dropbox API boundary. Connection lifecycle stays in the controller adapter. */
export class DropboxCloudFileBroker implements Pick<ExternalSourceBroker, 'list' | 'download'> {
  private readonly accessTokens: DropboxAccessTokenManager;

  constructor(
    private readonly connectorId: string,
    appKey: string,
    private readonly credentials: DropboxCredentialStore,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    if (!connectorId.trim()) throw new Error('Dropbox connector ID가 필요합니다.');
    this.accessTokens = new DropboxAccessTokenManager(appKey, credentials, fetchImpl);
  }

  async list(input: ExternalSourceListInput, signal: AbortSignal): Promise<ExternalItemPage> {
    assertNotAborted(signal);
    const accountConnectionId = await this.accountConnectionId(input.accountConnectionId);
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const query = validateQuery(input.query);
    const parentRef = validateParentRef(input.parentRef);
    const cursorContext: DropboxCursorContext = { accountConnectionId, parentRef, query };
    if (
      cursor &&
      (cursor.kind !== (query ? 'search' : 'list') ||
        cursor.accountConnectionId !== accountConnectionId ||
        cursor.parentRef !== parentRef ||
        cursor.query !== query)
    ) {
      throw new Error('Dropbox 목록 cursor와 현재 탐색 조건이 일치하지 않습니다.');
    }
    const kind: DropboxCursorKind = cursor?.kind ?? (query ? 'search' : 'list');
    const endpoint = cursor
      ? cursor.kind === 'list'
        ? '/files/list_folder/continue'
        : '/files/search/continue_v2'
      : query
        ? '/files/search_v2'
        : '/files/list_folder';
    const body = cursor
      ? { cursor: cursor.value }
      : query
        ? {
            query,
            options: {
              path: parentRef,
              filename_only: true,
              file_status: 'active',
              max_results: 100,
            },
          }
        : {
            path: parentRef,
            recursive: false,
            include_deleted: false,
            include_non_downloadable_files: false,
            limit: 100,
          };
    const response = await this.fetchWithTokenRetry(
      (token) =>
        this.fetchImpl(`${DROPBOX_API}${endpoint}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        }),
      signal,
    );
    if (!response.ok) throw safeDropboxError('list', response.status);
    const page = parsePage(
      await readJson(response, signal),
      kind,
      this.connectorId,
      accountConnectionId,
      cursorContext,
    );
    if (input.cursor && page.nextCursor === input.cursor) {
      throw new Error('Dropbox 목록 cursor가 진행되지 않았습니다. 목록을 새로고침해 주세요.');
    }
    return page;
  }

  async download(ref: ExternalSourceDownloadRef, signal: AbortSignal): Promise<DownloadedExternalSource> {
    assertNotAborted(signal);
    if (ref.key.connectorId !== this.connectorId) throw new Error('Dropbox 항목 식별자가 올바르지 않습니다.');
    const accountConnectionId = await this.accountConnectionId(ref.key.accountConnectionId);
    const remoteId = validateRemoteId(ref.key.remoteId);
    const expectedName = validateFileName(ref.fileName);
    if (!SUPPORTED_IMPORT_FILE.test(expectedName)) throw new Error('이 파일 형식은 가져올 수 없습니다.');
    if (ref.byteLength !== undefined) {
      const expectedBytes = fileSize(ref.byteLength);
      if (expectedBytes > DROPBOX_EXTERNAL_SOURCE_MAX_DOWNLOAD_BYTES) {
        throw new Error('Dropbox 파일이 허용된 다운로드 크기를 넘었습니다.');
      }
    }
    const expectedRevision = optionalString(ref.remoteRevision, '파일 revision', 512);
    const response = await this.fetchWithTokenRetry(
      (token) =>
        this.fetchImpl(`${DROPBOX_CONTENT_API}/files/download`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Dropbox-API-Arg': JSON.stringify({ path: remoteId }),
          },
          signal,
        }),
      signal,
    );
    if (!response.ok) throw safeDropboxError('download', response.status);
    const metadataHeader = response.headers.get('Dropbox-API-Result');
    if (!metadataHeader || metadataHeader.length > MAX_METADATA_RESPONSE_BYTES) {
      throw new Error('Dropbox 다운로드 metadata가 누락되었습니다.');
    }
    let rawMetadata: unknown;
    try {
      rawMetadata = JSON.parse(metadataHeader) as unknown;
    } catch {
      throw new Error('Dropbox 다운로드 metadata 형식이 올바르지 않습니다.');
    }
    const item = normalizeMetadata(rawMetadata, this.connectorId, accountConnectionId, true);
    if (item.kind !== 'file' || item.key.remoteId !== remoteId) {
      throw new Error('Dropbox 다운로드 항목 identity가 선택한 파일과 일치하지 않습니다.');
    }
    if (expectedRevision && item.remoteRevision !== expectedRevision) {
      throw new Error('Dropbox 파일이 목록을 연 뒤 변경되었습니다. 목록을 새로고침해 주세요.');
    }
    if (ref.byteLength !== undefined && item.byteLength !== ref.byteLength) {
      throw new Error('Dropbox 파일 크기가 목록을 연 뒤 변경되었습니다. 목록을 새로고침해 주세요.');
    }
    if ((item.byteLength ?? 0) > DROPBOX_EXTERNAL_SOURCE_MAX_DOWNLOAD_BYTES) {
      throw new Error('Dropbox 파일이 허용된 다운로드 크기를 넘었습니다.');
    }
    const bytes = await readBoundedBytes(response, DROPBOX_EXTERNAL_SOURCE_MAX_DOWNLOAD_BYTES, signal);
    if (item.byteLength !== bytes.byteLength) {
      throw new Error('Dropbox 다운로드 크기가 metadata와 일치하지 않습니다.');
    }
    const file = new File([bytes.buffer as ArrayBuffer], item.title, {
      type: item.mimeType ?? ref.mimeType ?? 'application/octet-stream',
      lastModified: item.updatedAt ? Date.parse(item.updatedAt) : Date.now(),
    });
    return { file, remoteRevision: item.remoteRevision };
  }

  private async accountConnectionId(requested?: string): Promise<string | undefined> {
    const credential = await this.credentials.get();
    if (!credential) throw new Error('Dropbox is not connected.');
    const requestedId = optionalString(requested, '계정 ID', MAX_ACCOUNT_ID_LENGTH);
    const credentialId = optionalString(credential.accountId, '계정 ID', MAX_ACCOUNT_ID_LENGTH);
    if (requestedId && credentialId && requestedId !== credentialId) {
      throw new Error('Dropbox 연결 계정과 요청한 목록 계정이 일치하지 않습니다.');
    }
    return requestedId ?? credentialId;
  }

  private async accessToken(): Promise<string> {
    try {
      return await this.accessTokens.getAccessToken();
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'Dropbox is not connected.' || error.message.startsWith('Dropbox session expired'))
      ) {
        throw error;
      }
      throw Object.assign(new Error('Dropbox 연결을 갱신하지 못했습니다. 다시 연결해 주세요.'), { cause: error });
    }
  }

  private async fetchWithTokenRetry(
    request: (token: string) => Promise<Response>,
    signal: AbortSignal,
  ): Promise<Response> {
    let token = await this.accessToken();
    assertNotAborted(signal);
    const response = await request(token);
    if (response.status !== 401) return response;
    if (response.body) await response.body.cancel().catch(() => undefined);
    assertNotAborted(signal);
    try {
      token = await this.accessTokens.refreshAccessToken(token);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'Dropbox is not connected.' || error.message.startsWith('Dropbox session expired'))
      ) {
        throw error;
      }
      throw Object.assign(new Error('Dropbox 연결을 갱신하지 못했습니다. 다시 연결해 주세요.'), { cause: error });
    }
    assertNotAborted(signal);
    return request(token);
  }
}
