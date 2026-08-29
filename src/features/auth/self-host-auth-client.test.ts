import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelfHostAuthClient, SelfHostAuthClientError, selfHostAuthErrorMessage } from './self-host-auth-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SelfHostAuthClient', () => {
  it('restores a same-origin cookie session without exposing a token to JavaScript', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            setupRequired: false,
            setupCodeRequired: false,
            legacyRecoveryEnabled: true,
            authenticated: true,
            account: { username: 'owner', displayName: 'Owner' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const status = await new SelfHostAuthClient('/api').status();

    expect(status.account).toEqual({ username: 'owner', displayName: 'Owner' });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/status', {
      credentials: 'same-origin',
      signal: undefined,
    });
    expect(JSON.stringify(status)).not.toContain('token');
  });

  it('sends the one-time setup code only while registering the first account', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ authenticated: true, account: { username: 'owner', displayName: 'Owner' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new SelfHostAuthClient('/api/').register({
      username: 'owner',
      password: 'a sufficiently long password',
      setupCode: 'first-device-only',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.credentials).toBe('same-origin');
    expect(JSON.parse(String(init?.body))).toEqual({
      username: 'owner',
      password: 'a sufficiently long password',
      setupCode: 'first-device-only',
    });
  });

  it('maps safe authentication error codes to actionable Korean messages', () => {
    expect(selfHostAuthErrorMessage(new SelfHostAuthClientError('invalid_credentials', 401))).toContain(
      '아이디 또는 비밀번호',
    );
    expect(selfHostAuthErrorMessage(new SelfHostAuthClientError('invalid_setup_code', 403))).toContain(
      '초기 설정 코드',
    );
    expect(selfHostAuthErrorMessage(new SelfHostAuthClientError('missing', 404))).toContain('서버를 먼저 업데이트');
  });
});
