export interface SelfHostAccount {
  readonly username: string;
  readonly displayName: string;
}

export interface SelfHostAuthStatus {
  readonly setupRequired: boolean;
  readonly authenticated: boolean;
  readonly account?: SelfHostAccount;
  readonly legacyRecoveryEnabled: boolean;
  readonly setupCodeRequired: boolean;
}

interface AuthResponse {
  readonly authenticated: boolean;
  readonly account?: SelfHostAccount;
  readonly expiresAt?: string;
  readonly error?: string;
}

export class SelfHostAuthClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = 'SelfHostAuthClientError';
  }
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

async function responseBody(response: Response): Promise<AuthResponse> {
  try {
    return (await response.json()) as AuthResponse;
  } catch {
    return { authenticated: false };
  }
}

export class SelfHostAuthClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizedBaseUrl(baseUrl);
  }

  async status(signal?: AbortSignal): Promise<SelfHostAuthStatus> {
    const response = await fetch(`${this.baseUrl}/auth/status`, {
      credentials: 'same-origin',
      signal,
    });
    const body = await responseBody(response);
    if (!response.ok) throw new SelfHostAuthClientError(body.error ?? 'authentication_unavailable', response.status);
    return body as SelfHostAuthStatus;
  }

  register(input: {
    username: string;
    displayName?: string;
    password: string;
    setupCode?: string;
  }): Promise<SelfHostAccount> {
    return this.submit('/auth/register', input);
  }

  login(input: { username: string; password: string }): Promise<SelfHostAccount> {
    return this.submit('/auth/login', input);
  }

  async logout(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) {
      const body = await responseBody(response);
      throw new SelfHostAuthClientError(body.error ?? 'authentication_unavailable', response.status);
    }
  }

  private async submit(path: string, input: Record<string, string | undefined>): Promise<SelfHostAccount> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await responseBody(response);
    if (!response.ok || !body.authenticated || !body.account) {
      throw new SelfHostAuthClientError(body.error ?? 'authentication_unavailable', response.status);
    }
    return body.account;
  }
}

export function selfHostAuthErrorMessage(error: unknown): string {
  if (error instanceof TypeError) return '개인 서버에 연결하지 못했습니다. 서버와 HTTPS 프록시 상태를 확인하세요.';
  if (!(error instanceof SelfHostAuthClientError)) {
    return error instanceof Error ? error.message : '로그인 요청을 처리하지 못했습니다.';
  }
  switch (error.code) {
    case 'account_already_registered':
      return '이미 개인 서버 계정이 등록되어 있습니다. 로그인해 주세요.';
    case 'invalid_credentials':
      return '아이디 또는 비밀번호가 맞지 않습니다.';
    case 'invalid_username':
      return '아이디는 2~64자의 문자, 숫자, 점, 밑줄 또는 하이픈으로 입력하세요.';
    case 'invalid_display_name':
      return '표시 이름을 80자 이내로 입력하세요.';
    case 'invalid_password':
      return '비밀번호는 10자 이상 256자 이하로 입력하세요.';
    case 'login_rate_limited':
      return '로그인 시도가 너무 많습니다. 5분 뒤 다시 시도하세요.';
    case 'invalid_setup_code':
      return '초기 설정 코드가 맞지 않습니다. 서버의 READER_AUTH_TOKEN 값을 확인하세요.';
    case 'authentication_unavailable':
      return '서버 인증 기능을 사용할 수 없습니다. 서버 업데이트와 데이터베이스 상태를 확인하세요.';
    default:
      return error.status === 404
        ? '이 서버는 아직 계정 로그인을 지원하지 않습니다. 서버를 먼저 업데이트하세요.'
        : '로그인 요청을 처리하지 못했습니다.';
  }
}
