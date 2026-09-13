import { describe, expect, it, vi } from 'vitest';
import { GoogleAuthClient, GoogleAuthError } from './google-auth-client';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
const session = {
  identity: { subject: 'reader', label: 'Reader', expiresAt: Date.now() + 86400000 },
  driveReady: true,
};
describe('persistent Google auth broker client', () => {
  it('restores in a new client with only an opaque app session persisted and lazily requests Drive access', async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('/login')
              ? { ...session, token: 'opaque-app-session' }
              : String(url).endsWith('/drive/token')
                ? { accessToken: 'google-access', expiresAt: Date.now() + 3600000 }
                : session,
          ),
        ),
    );
    const first = new GoogleAuthClient('http://localhost:1432', 'client', fetchImpl, storage);
    await first.login('signed-google-id', 'nonce');
    expect([...storage.data.values()]).toEqual(['opaque-app-session']);
    const reopened = new GoogleAuthClient('http://localhost:1432', 'client', fetchImpl, storage);
    expect(await reopened.restore()).toEqual(session);
    expect(await reopened.getAccessToken('reader')).toBe('google-access');
    expect(await reopened.getAccessToken('reader')).toBe('google-access');
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/drive/token'))).toHaveLength(1);
    expect([...storage.data.values()]).toEqual(['opaque-app-session']);
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'account_mismatch' }), { status: 409 }));
    await expect(reopened.getAccessToken('another-reader')).rejects.toBeInstanceOf(GoogleAuthError);
    await reopened.logout();
    expect(await first.restore()).toBeUndefined();
  });
  it('rejects late access and login responses after logout', async () => {
    const storage = memoryStorage();
    let resolve!: (value: Response) => void;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/logout')
        ? new Response('{}')
        : new Promise<Response>((done) => {
            resolve = done;
          }),
    );
    const client = new GoogleAuthClient('http://localhost:1432', 'client', fetchImpl, storage);
    const login = client.login('id', 'nonce');
    await client.logout();
    resolve(new Response(JSON.stringify({ ...session, token: 'late-app-session' })));
    await expect(login).rejects.toBeInstanceOf(GoogleAuthError);
    expect(storage.data.size).toBe(0);
    storage.setItem(client.storageKey, 'existing-session');
    const access = client.getAccessToken('reader');
    await client.logout();
    resolve(new Response(JSON.stringify({ accessToken: 'late-access', expiresAt: Date.now() + 3600000 })));
    await expect(access).rejects.toBeInstanceOf(GoogleAuthError);
  });
  it('retains the app session during an outage, and never reuses another tab account’s cached access', async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accessToken: 'first-access', expiresAt: Date.now() + 3600000 })),
    );
    const client = new GoogleAuthClient('http://localhost:1432', 'client', fetchImpl, storage);
    storage.setItem(client.storageKey, 'first-session');
    await client.getAccessToken('reader');
    storage.setItem(client.storageKey, 'second-session');
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'account_mismatch' }), { status: 409 }));
    await expect(client.getAccessToken('reader')).rejects.toBeInstanceOf(GoogleAuthError);
    fetchImpl.mockRejectedValueOnce(new Error('offline'));
    await expect(client.restore()).rejects.toThrow('offline');
    expect(storage.getItem(client.storageKey)).toBe('second-session');
  });
});
