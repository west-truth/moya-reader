import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRIVE_SCOPE, GoogleSession, type GoogleIdentityServices } from './google-session';

afterEach(() => {
  vi.useRealTimers();
});
async function sessionFixture() {
  vi.useFakeTimers();
  let login!: (value: { credential: string }) => void;
  let authorize!: (value: { access_token?: string; scope?: string; expires_in?: number; error?: string }) => void;
  const prompt = vi.fn();
  const sdk: GoogleIdentityServices = {
    accounts: {
      id: {
        initialize: (options) => {
          login = options.callback;
        },
        renderButton: vi.fn(),
        disableAutoSelect: vi.fn(),
      },
      oauth2: {
        initTokenClient: (options) => {
          authorize = options.callback;
          return { requestAccessToken: prompt };
        },
      },
    },
  };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sub: 'reader' })));
  const session = new GoogleSession(
    'client',
    fetchImpl,
    async () => ({ subject: 'reader', label: 'Reader', expiresAt: Date.now() + 3600000 }),
    async () => sdk,
  );
  await session.mountButton({ replaceChildren: vi.fn() } as unknown as HTMLElement, vi.fn());
  login({ credential: 'synthetic' });
  await Promise.resolve();
  return {
    session,
    fetchImpl,
    prompt,
    authorize: (response = { access_token: 'secret', scope: DRIVE_SCOPE, expires_in: 3600 }) => authorize(response),
  };
}

describe('Google session and Drive consent', () => {
  it('keeps the current button when an earlier mount is cancelled while the SDK loads', async () => {
    let resolveSdk!: (sdk: GoogleIdentityServices) => void;
    const loading = new Promise<GoogleIdentityServices>((resolve) => {
      resolveSdk = resolve;
    });
    const initialize = vi.fn();
    const renderButton = vi.fn();
    const sdk = {
      accounts: { id: { initialize, renderButton, disableAutoSelect: vi.fn() } },
    } as unknown as GoogleIdentityServices;
    const session = new GoogleSession('client', vi.fn(), vi.fn(), () => loading);
    const target = { replaceChildren: vi.fn() } as unknown as HTMLElement;
    const abort = new AbortController();
    const stale = session.mountButton(target, vi.fn(), abort.signal);
    abort.abort();
    const current = session.mountButton(target, vi.fn());
    resolveSdk(sdk);
    const [releaseStale, releaseCurrent] = await Promise.all([stale, current]);
    releaseStale();
    expect(initialize).toHaveBeenCalledOnce();
    expect(renderButton).toHaveBeenCalledOnce();
    expect(target.replaceChildren).not.toHaveBeenCalled();
    releaseCurrent();
    expect(target.replaceChildren).toHaveBeenCalledOnce();
  });

  it('keeps login independent of Drive denial and does not request access before the user chooses sync', async () => {
    const { session, prompt, authorize } = await sessionFixture();
    expect(session.getSnapshot().identity?.subject).toBe('reader');
    expect(prompt).not.toHaveBeenCalled();
    const result = session.authorizeDrive();
    authorize({ access_token: 'secret', scope: 'openid', expires_in: 3600 });
    await expect(result).rejects.toThrow('허용되지');
    expect(session.getSnapshot().identity?.subject).toBe('reader');
    expect(session.ready('reader')).toBe(false);
    session.signOut();
  });
  it('pins the grant to the signed-in subject and expires it without opening another popup', async () => {
    const { session, authorize, prompt } = await sessionFixture();
    const result = session.authorizeDrive();
    authorize();
    await result;
    expect(await session.getAccessToken('reader')).toBe('secret');
    await expect(session.getAccessToken('different-reader')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(3540001);
    expect(session.getSnapshot().driveReady).toBe(false);
    await expect(session.getAccessToken('reader')).rejects.toThrow('만료');
    expect(prompt).toHaveBeenCalledOnce();
    session.signOut();
  });
  it('rejects another Drive account and a response arriving after logout', async () => {
    const { session, authorize, fetchImpl } = await sessionFixture();
    await expect(session.authorizeDrive('other')).rejects.toThrow('기존 동기화');
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'other' })));
    const wrong = session.authorizeDrive();
    authorize();
    await expect(wrong).rejects.toThrow('다릅니다');
    const late = session.authorizeDrive();
    session.signOut();
    authorize();
    await expect(late).rejects.toThrow();
    expect(session.getSnapshot()).toEqual({ driveReady: false });
  });
});
