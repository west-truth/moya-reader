import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginDropboxAuthorizationRedirect,
  completeDropboxAuthorizationRedirect,
  connectDropboxWithDesktopBrowser,
  connectDropboxWithPopup,
  DESKTOP_DROPBOX_REDIRECT_URI,
  relayDropboxOAuthPopup,
  type DropboxOAuthCallbackMessage,
} from './dropbox-oauth';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('Dropbox OAuth popup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    invoke.mockReset();
  });

  it('requests optional read scopes and accepts callbacks only from its popup', async () => {
    const popup = { closed: false, close: vi.fn() } as unknown as WindowProxy;
    const open = vi.fn((..._arguments: Parameters<typeof window.open>) => popup);
    let messageListener: ((event: MessageEvent) => void) | undefined;
    const addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'message') messageListener = listener as (event: MessageEvent) => void;
    });
    const removeEventListener = vi.fn();
    vi.stubGlobal('location', {
      origin: 'https://reader.example',
      pathname: '/',
      protocol: 'https:',
    });
    vi.stubGlobal('window', { open });
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('addEventListener', addEventListener);
    vi.stubGlobal('removeEventListener', removeEventListener);
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'token', account_id: 'account-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const connection = connectDropboxWithPopup({
      appKey: 'app-key',
      scopes: ['files.metadata.read', ' files.content.read ', 'files.metadata.read'],
      fetchImpl,
    });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const authorizeUrl = new URL(open.mock.calls[0]![0]!);
    expect(authorizeUrl.searchParams.get('scope')).toBe('files.metadata.read files.content.read');
    const callback = {
      type: 'noveldesk-dropbox-oauth-callback',
      code: 'authorization-code',
      state: authorizeUrl.searchParams.get('state'),
    };
    messageListener?.({
      source: {} as WindowProxy,
      origin: 'https://reader.example',
      data: callback,
    } as MessageEvent);
    expect(fetchImpl).not.toHaveBeenCalled();
    messageListener?.({
      source: popup,
      origin: 'https://reader.example',
      data: callback,
    } as MessageEvent);

    await expect(connection).resolves.toMatchObject({ accessToken: 'token', accountId: 'account-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('accepts a same-origin callback channel when the OAuth provider severs the popup opener', async () => {
    const popup = { closed: false, close: vi.fn() } as unknown as WindowProxy;
    const open = vi.fn((..._arguments: Parameters<typeof window.open>) => popup);
    const callbackChannels: Array<{
      onmessage: ((event: MessageEvent<DropboxOAuthCallbackMessage>) => void) | null;
    }> = [];
    class MockBroadcastChannel {
      onmessage: ((event: MessageEvent<DropboxOAuthCallbackMessage>) => void) | null = null;
      constructor(_name: string) {
        callbackChannels.push(this);
      }
      close() {}
    }
    vi.stubGlobal('location', {
      origin: 'https://reader.example',
      pathname: '/',
      protocol: 'https:',
    });
    vi.stubGlobal('window', { open });
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.stubGlobal('addEventListener', vi.fn());
    vi.stubGlobal('removeEventListener', vi.fn());
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'token', account_id: 'account-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const connection = connectDropboxWithPopup({ appKey: 'app-key', fetchImpl });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const authorizeUrl = new URL(open.mock.calls[0]![0]!);
    callbackChannels[0]?.onmessage?.({
      data: {
        type: 'noveldesk-dropbox-oauth-callback',
        code: 'authorization-code',
        state: authorizeUrl.searchParams.get('state') ?? undefined,
      },
    } as MessageEvent<DropboxOAuthCallbackMessage>);

    await expect(connection).resolves.toMatchObject({ accessToken: 'token', accountId: 'account-1' });
  });

  it('round-trips PKCE state through a visible current-tab redirect', async () => {
    const values = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => values.set(key, value));
    const removeItem = vi.fn((key: string) => values.delete(key));
    const assign = vi.fn();
    const location = {
      origin: 'https://reader.example',
      pathname: '/',
      protocol: 'https:',
      href: 'https://reader.example/',
      search: '',
      hash: '',
      assign,
    };
    vi.stubGlobal('location', location);
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem,
      removeItem,
    });
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });

    await beginDropboxAuthorizationRedirect({
      appKey: 'app-key',
      scopes: ['files.metadata.read', 'files.content.read'],
    });
    const authorizeUrl = new URL(assign.mock.calls[0]![0]);
    expect(authorizeUrl.searchParams.get('scope')).toBe('files.metadata.read files.content.read');
    const state = authorizeUrl.searchParams.get('state');
    location.search = `?code=authorization-code&state=${state}`;
    location.href = `https://reader.example/${location.search}`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'token', account_id: 'account-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    await expect(completeDropboxAuthorizationRedirect({ appKey: 'app-key', fetchImpl })).resolves.toMatchObject({
      accessToken: 'token',
      accountId: 'account-1',
    });
    expect(removeItem).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('relays an OAuth popup callback through the channel even when opener is unavailable', () => {
    const postMessage = vi.fn();
    const closeChannel = vi.fn();
    class MockBroadcastChannel {
      constructor(_name: string) {}
      postMessage = postMessage;
      close = closeChannel;
    }
    const closeWindow = vi.fn();
    vi.stubGlobal('location', {
      origin: 'https://reader.example',
      pathname: '/',
      protocol: 'https:',
      search: '?code=authorization-code&state=oauth-state',
    });
    vi.stubGlobal('window', { name: 'noveldesk-dropbox-oauth', opener: null, close: closeWindow });
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

    expect(relayDropboxOAuthPopup()).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'noveldesk-dropbox-oauth-callback',
      code: 'authorization-code',
      state: 'oauth-state',
      error: undefined,
    });
    expect(closeChannel).toHaveBeenCalledOnce();
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('rejects cross-origin redirects and malformed scopes before opening a popup', async () => {
    const open = vi.fn();
    vi.stubGlobal('location', {
      origin: 'https://reader.example',
      pathname: '/',
      protocol: 'https:',
    });
    vi.stubGlobal('window', { open });

    await expect(
      connectDropboxWithPopup({ appKey: 'app-key', redirectUri: 'https://attacker.example/callback' }),
    ).rejects.toThrow('current web origin');
    await expect(
      connectDropboxWithPopup({ appKey: 'app-key', scopes: ['files.metadata.read files.content.write'] }),
    ).rejects.toThrow('scope is invalid');
    expect(open).not.toHaveBeenCalled();
  });

  it('uses the fixed loopback callback and native token exchange through the desktop command', async () => {
    invoke.mockImplementation(
      async (_command: string, args: { authorizeUrl: string; expectedState: string; codeVerifier: string }) => {
        const authorizeUrl = new URL(args.authorizeUrl);
        expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(DESKTOP_DROPBOX_REDIRECT_URI);
        expect(args.expectedState).toBe(authorizeUrl.searchParams.get('state'));
        expect(args.codeVerifier.length).toBeGreaterThanOrEqual(43);
        return {
          accessToken: 'desktop-token',
          refreshToken: 'desktop-refresh-token',
          expiresIn: 14_400,
          accountId: 'desktop-account',
        };
      },
    );
    const fetchImpl = vi.fn();

    await expect(connectDropboxWithDesktopBrowser({ appKey: 'app-key', fetchImpl })).resolves.toMatchObject({
      accessToken: 'desktop-token',
      refreshToken: 'desktop-refresh-token',
      accountId: 'desktop-account',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      'desktop_dropbox_oauth_authorize',
      expect.objectContaining({
        expectedState: expect.any(String),
        authorizeUrl: expect.any(String),
        codeVerifier: expect.any(String),
      }),
    );
  });
});
