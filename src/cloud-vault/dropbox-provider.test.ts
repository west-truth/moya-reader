import { describe, expect, it, vi } from 'vitest';
import {
  DropboxAccessTokenManager,
  DropboxCloudVaultProvider,
  exchangeDropboxAuthorizationCode,
  type DropboxCredential,
} from './dropbox-provider';

describe('Dropbox cloud vault provider', () => {
  it('requires a stable Dropbox account identity during authorization', async () => {
    await expect(
      exchangeDropboxAuthorizationCode({
        appKey: 'app-key',
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: 'https://reader.example/',
        fetchImpl: vi.fn(
          async () => new Response(JSON.stringify({ access_token: 'token', expires_in: 14_400 }), { status: 200 }),
        ),
      }),
    ).rejects.toThrow('account identity');
  });

  it('reads the app-folder vault and carries the Dropbox revision', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Dropbox-API-Result': JSON.stringify({ rev: 'rev-1' }) },
        }),
    );
    const provider = new DropboxCloudVaultProvider(
      'app-key',
      { get: async () => ({ accessToken: 'token' }), save: async () => undefined },
      fetchImpl as typeof fetch,
    );
    await expect(provider.read()).resolves.toEqual({ bytes: new Uint8Array([1, 2, 3]), revision: 'rev-1' });
  });

  it('refreshes an expired access token before uploading with revision CAS', async () => {
    let saved: DropboxCredential | undefined;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'fresh', expires_in: 14_400 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rev: 'rev-2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const provider = new DropboxCloudVaultProvider(
      'app-key',
      {
        get: async () => ({
          accessToken: 'expired',
          refreshToken: 'refresh',
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
        save: async (credential) => {
          saved = credential;
        },
      },
      fetchImpl,
    );

    await expect(provider.write(new Uint8Array([4]), 'rev-1')).resolves.toEqual({ revision: 'rev-2' });
    expect(saved?.accessToken).toBe('fresh');
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer fresh' });
  });

  it('shares one token refresh across concurrent Dropbox callers', async () => {
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await refreshStarted;
      return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 14_400 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const save = vi.fn(async () => undefined);
    const manager = new DropboxAccessTokenManager(
      'app-key',
      {
        get: async () => ({
          accessToken: 'expired',
          refreshToken: 'refresh',
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
        save,
      },
      fetchImpl,
    );

    const first = manager.getAccessToken();
    const second = manager.getAccessToken();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual(['fresh', 'fresh']);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('shares one forced refresh after concurrent early unauthorized responses', async () => {
    let credential: DropboxCredential = {
      accessToken: 'stale',
      refreshToken: 'refresh',
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await refreshGate;
      return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 14_400 }), { status: 200 });
    });
    const manager = new DropboxAccessTokenManager(
      'app-key',
      {
        get: async () => credential,
        save: async (next) => {
          credential = next;
        },
      },
      fetchImpl,
    );

    const first = manager.refreshAccessToken('stale');
    const second = manager.refreshAccessToken('stale');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual(['fresh', 'fresh']);
    expect(credential.accessToken).toBe('fresh');
  });

  it('does not include Dropbox response bodies in vault errors', async () => {
    const provider = new DropboxCloudVaultProvider(
      'app-key',
      { get: async () => ({ accessToken: 'token' }), save: async () => undefined },
      vi.fn(async () => new Response('private/path secret-provider-detail', { status: 403 })),
    );

    let message = '';
    try {
      await provider.read();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Dropbox vault read failed (403).');
    expect(message).not.toContain('private/path');
  });
});
