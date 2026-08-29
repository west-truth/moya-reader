export type SuwayomiAuthMode = 'none' | 'ui_login' | 'basic_auth';

export interface SuwayomiClientAuth {
  readonly mode: SuwayomiAuthMode;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  /** Session-only. The Basic password is never persisted by the account broker. */
  readonly basicAuthorization?: string;
}

interface GraphqlErrorShape {
  readonly message?: unknown;
}

interface GraphqlEnvelope<T> {
  readonly data?: T | null;
  readonly errors?: readonly GraphqlErrorShape[];
}

export interface SuwayomiTokenPair {
  readonly accessToken: string;
  readonly refreshToken?: string;
}

export class SuwayomiAuthenticationError extends Error {
  constructor() {
    super('Suwayomi 서버 인증이 필요하거나 연결 정보가 만료되었습니다.');
    this.name = 'SuwayomiAuthenticationError';
  }
}

export class SuwayomiHttpError extends Error {
  constructor(readonly status: number) {
    super(`Suwayomi 서버 요청에 실패했습니다. (HTTP ${status})`);
    this.name = 'SuwayomiHttpError';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isAuthenticationEnvelope(errors: readonly GraphqlErrorShape[] | undefined): boolean {
  return Boolean(
    errors?.some(({ message }) =>
      typeof message === 'string' ? /unauthori[sz]ed|forbidden|authentication|로그인/i.test(message) : false,
    ),
  );
}

function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `Basic ${btoa(binary)}`;
}

/** Small fetch-only client for the current Suwayomi GraphQL and page-image boundaries. */
export class SuwayomiGraphqlClient {
  private refreshTask?: Promise<string>;

  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
    private readonly getAuth: () => SuwayomiClientAuth,
    private readonly saveRefreshedAccessToken: (accessToken: string) => Promise<void>,
  ) {}

  static createBasicAuthorization(username: string, password: string): string {
    return basicAuthorization(username, password);
  }

  async login(username: string, password: string, signal?: AbortSignal): Promise<SuwayomiTokenPair> {
    const data = await this.rawGraphql<{ login?: SuwayomiTokenPair | null }>(
      `mutation MoyaSuwayomiLogin($input: LoginInput!) {
        login(input: $input) { accessToken refreshToken }
      }`,
      { input: { username, password } },
      signal,
      undefined,
    );
    const pair = data.login;
    if (!pair?.accessToken?.trim()) throw new SuwayomiAuthenticationError();
    return { accessToken: pair.accessToken, refreshToken: pair.refreshToken?.trim() || undefined };
  }

  async graphql<T>(document: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    try {
      return await this.rawGraphql<T>(document, variables, signal, this.authorizationHeader());
    } catch (error) {
      if (!(error instanceof SuwayomiAuthenticationError) || !this.getAuth().refreshToken) throw error;
      const accessToken = await this.refreshAccessToken(signal);
      return this.rawGraphql<T>(document, variables, signal, `Bearer ${accessToken}`);
    }
  }

  async fetchAsset(pathOrUrl: string, signal: AbortSignal): Promise<Response> {
    const targetUrl = new URL(pathOrUrl, `${this.baseUrl}/`);
    const sameOrigin = targetUrl.origin === new URL(this.baseUrl).origin;
    const request = (authorization: string | undefined) =>
      this.fetchImpl(targetUrl.toString(), {
        method: 'GET',
        headers: sameOrigin && authorization ? { Authorization: authorization } : undefined,
        signal,
      });
    let response: Response;
    try {
      response = await request(this.authorizationHeader());
      if (sameOrigin && response.status === 401 && this.getAuth().refreshToken) {
        const accessToken = await this.refreshAccessToken(signal);
        response = await request(`Bearer ${accessToken}`);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw Object.assign(new Error('Suwayomi 서버에서 회차 이미지를 가져오지 못했습니다.'), { cause: error });
    }
    if (sameOrigin && (response.status === 401 || response.status === 403)) throw new SuwayomiAuthenticationError();
    if (!response.ok) throw new SuwayomiHttpError(response.status);
    return response;
  }

  absoluteUrl(pathOrUrl: string | undefined): string | undefined {
    if (!pathOrUrl) return undefined;
    try {
      return new URL(pathOrUrl, `${this.baseUrl}/`).toString();
    } catch {
      return undefined;
    }
  }

  private authorizationHeader(): string | undefined {
    const auth = this.getAuth();
    if (auth.mode === 'basic_auth') return auth.basicAuthorization;
    if (auth.mode === 'ui_login' && auth.accessToken) return `Bearer ${auth.accessToken}`;
    return undefined;
  }

  private async refreshAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.refreshTask) return this.refreshTask;
    const refreshToken = this.getAuth().refreshToken;
    if (!refreshToken) throw new SuwayomiAuthenticationError();
    const task = this.rawGraphql<{ refreshToken?: { accessToken?: string } | null }>(
      `mutation MoyaSuwayomiRefresh($input: RefreshTokenInput!) {
        refreshToken(input: $input) { accessToken }
      }`,
      { input: { refreshToken } },
      signal,
      undefined,
    )
      .then(async ({ refreshToken: payload }) => {
        const accessToken = payload?.accessToken?.trim();
        if (!accessToken) throw new SuwayomiAuthenticationError();
        await this.saveRefreshedAccessToken(accessToken);
        return accessToken;
      })
      .finally(() => {
        if (this.refreshTask === task) this.refreshTask = undefined;
      });
    this.refreshTask = task;
    return task;
  }

  private async rawGraphql<T>(
    document: string,
    variables: Record<string, unknown>,
    signal: AbortSignal | undefined,
    authorization: string | undefined,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify({ query: document, variables }),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw Object.assign(new Error('Suwayomi 서버에 연결할 수 없습니다. 주소와 실행 상태를 확인해 주세요.'), {
        cause: error,
      });
    }
    if (response.status === 401 || response.status === 403) throw new SuwayomiAuthenticationError();
    if (!response.ok) throw new SuwayomiHttpError(response.status);

    let envelope: GraphqlEnvelope<T>;
    try {
      envelope = (await response.json()) as GraphqlEnvelope<T>;
    } catch {
      throw new Error('Suwayomi 서버 응답 형식을 읽을 수 없습니다.');
    }
    if (isAuthenticationEnvelope(envelope.errors)) throw new SuwayomiAuthenticationError();
    if (envelope.data != null) return envelope.data;
    throw new Error('Suwayomi 서버가 요청을 처리하지 못했습니다. 서버와 소스 상태를 확인해 주세요.');
  }
}
