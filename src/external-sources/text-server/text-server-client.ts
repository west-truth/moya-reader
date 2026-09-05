import { TextServerRequestError, textServerErrorMessage } from './text-server-errors';

export const TEXT_SERVER_MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

export type ManagedTextSourceFetch = (path: string, signal: AbortSignal) => Promise<Response>;
export function textServerNamespace(identity: {
  instanceId: string;
  dataNamespace: string;
  accountId?: string;
}): string {
  return encodeURIComponent(
    JSON.stringify([identity.instanceId, identity.dataNamespace, identity.accountId ?? 'single']),
  );
}

export function normalizeTextServerEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('텍스트 서버 주소를 확인해 주세요.');
  }
  const privateHost =
    /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/iu.test(
      url.hostname,
    );
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHost)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('HTTPS 또는 로컬·사설망 HTTP 서버 주소를 입력해 주세요.');
  }
  return url.toString().replace(/\/+$/u, '');
}

export class TextServerClient {
  constructor(
    private readonly options: {
      readonly endpoint: string;
      readonly token?: string;
      readonly fetchImpl?: typeof fetch;
      readonly managedFetch?: ManagedTextSourceFetch;
      readonly expectedNamespace?: string;
      readonly requestTimeoutMs?: number;
      readonly readTimeoutMs?: number;
    },
  ) {}

  async json(path: string, signal: AbortSignal): Promise<unknown> {
    const { bytes } = await this.read(path, signal, MAX_CATALOG_BYTES, 'application/json');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new TextServerRequestError(
        '텍스트 서버 목록 형식을 읽을 수 없습니다. 서버의 소스 연결 상태를 확인해 주세요.',
      );
    }
  }

  async content(path: string, signal: AbortSignal): Promise<{ bytes: Uint8Array<ArrayBuffer>; revision?: string }> {
    const { bytes, headers } = await this.read(path, signal, TEXT_SERVER_MAX_CONTENT_BYTES, 'text/plain');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new TextServerRequestError(textServerErrorMessage(422, 'invalid_utf8_content'));
    }
    if (!text.trim())
      throw new TextServerRequestError(
        '회차 본문이 비어 있습니다. 본문 제공자의 로그인 상태와 해당 회차 제공 여부를 확인해 주세요.',
      );
    const revision = headers.get('ETag') ?? undefined;
    return { bytes, revision: revision && revision.length <= 512 ? revision : undefined };
  }

  async cover(path: string, signal: AbortSignal): Promise<Blob> {
    const { bytes, headers } = await this.read(path, signal, 8 * 1024 * 1024, 'image');
    if (!bytes.length) throw new TextServerRequestError('표지 이미지가 비어 있습니다.');
    return new Blob([bytes], { type: headers.get('Content-Type')!.split(';')[0]!.trim().toLowerCase() });
  }

  private async read(path: string, signal: AbortSignal, maxBytes: number, expectedMime: string) {
    if (!path.startsWith('/v1/') || path.includes('://') || path.includes('#'))
      throw new Error('지원하지 않는 텍스트 서버 요청입니다.');
    signal.throwIfAborted();
    const abort = new AbortController();
    const cancel = () => abort.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timeout = () => {
      timedOut = true;
      abort.abort();
    };
    const timer = setTimeout(
      timeout,
      this.options.requestTimeoutMs ??
        (expectedMime === 'image' ? 5_000 : expectedMime === 'application/json' ? 15_000 : 120_000),
    );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => {
      void reader?.cancel().catch(() => undefined);
    };
    abort.signal.addEventListener('abort', cancelReader);
    const readBytes = async (body: ReadableStream<Uint8Array>, maximum: number) => {
      reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        abort.signal.throwIfAborted();
        idleTimer = setTimeout(timeout, this.options.readTimeoutMs ?? 15_000);
        const { done, value } = await reader.read();
        clearTimeout(idleTimer);
        abort.signal.throwIfAborted();
        if (done) break;
        length += value.byteLength;
        if (length > maximum) throw new TextServerRequestError('텍스트 서버 응답의 크기 한도를 초과했습니다.');
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    };
    try {
      const response = this.options.managedFetch
        ? await this.options.managedFetch(path, abort.signal)
        : await (this.options.fetchImpl ?? globalThis.fetch)(`${this.options.endpoint}${path}`, {
            method: 'GET',
            redirect: 'error',
            credentials: 'omit',
            signal: abort.signal,
            headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : undefined,
          });
      if (response.redirected || !response.ok) {
        let code: unknown;
        if (
          !response.redirected &&
          response.body &&
          response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() === 'application/json' &&
          !(Number(response.headers.get('Content-Length')) > MAX_ERROR_BYTES)
        ) {
          try {
            const bytes = await readBytes(response.body, MAX_ERROR_BYTES);
            code = (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { error?: unknown })?.error;
          } catch {
            abort.signal.throwIfAborted();
          } finally {
            cancelReader();
          }
        } else void response.body?.cancel().catch(() => undefined);
        throw new TextServerRequestError(
          textServerErrorMessage(response.status, code, Boolean(this.options.managedFetch)),
        );
      }
      if (
        this.options.expectedNamespace &&
        response.headers.get('X-Moya-Source-Namespace') !== this.options.expectedNamespace
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new TextServerRequestError(
          '텍스트 서버의 데이터 범위가 변경되었거나 응답에 범위 정보가 없습니다. 다시 연결해 주세요.',
        );
      }
      const mime = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
      const declaredSize = Number(response.headers.get('Content-Length'));
      if (!response.body)
        throw new TextServerRequestError(
          expectedMime === 'text/plain'
            ? '회차 본문이 없습니다. 본문 제공자의 로그인 상태와 해당 회차 제공 여부를 확인해 주세요.'
            : '텍스트 서버가 목록을 반환하지 않았습니다. 서버의 소스 연결 상태를 확인해 주세요.',
        );
      if (
        !(expectedMime === 'image' ? ['image/jpeg', 'image/png', 'image/webp'] : [expectedMime]).includes(mime ?? '') ||
        (Number.isFinite(declaredSize) && declaredSize > maxBytes)
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new TextServerRequestError(
          '텍스트 서버 응답의 형식 또는 크기가 올바르지 않습니다. 서버의 소스·본문 제공자 설정을 확인해 주세요.',
        );
      }
      const bytes = await readBytes(response.body, maxBytes);
      return { bytes, headers: response.headers };
    } catch (error) {
      cancelReader();
      if (signal.aborted) throw signal.reason ?? new DOMException('취소되었습니다.', 'AbortError');
      // Network causes can contain credential-bearing URLs; diagnostics are intentionally bounded.
      if (timedOut) throw new TextServerRequestError(textServerErrorMessage(504));
      if (error instanceof TextServerRequestError) throw error;
      // Do not propagate provider exception bodies or URL credentials into diagnostics.
      throw new TextServerRequestError(
        '텍스트 서버에 연결할 수 없습니다. 서버 주소와 실행 상태, 네트워크·허용 앱 주소 설정을 확인해 주세요.',
      );
    } finally {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      signal.removeEventListener('abort', cancel);
      abort.signal.removeEventListener('abort', cancelReader);
      reader?.releaseLock();
    }
  }
}
