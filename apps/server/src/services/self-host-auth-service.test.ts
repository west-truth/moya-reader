import { describe, expect, it } from 'vitest';
import {
  SelfHostAuthError,
  SelfHostAuthService,
  selfHostSessionTokenHash,
  type SelfHostAuthStore,
} from './self-host-auth-service.js';

type StoredAccount = NonNullable<Awaited<ReturnType<SelfHostAuthStore['loadAccount']>>>;

class MemoryAuthStore implements SelfHostAuthStore {
  account?: StoredAccount;
  readonly sessions = new Map<string, { userId: string; expiresAt: string }>();

  async loadAccount() {
    return this.account;
  }

  async createAccount(account: StoredAccount) {
    if (this.account) return false;
    this.account = account;
    return true;
  }

  async updateUserDisplayName(_userId: string, _displayName: string) {}

  async createSession(userId: string, tokenHash: string, expiresAt: string) {
    this.sessions.set(tokenHash, { userId, expiresAt });
  }

  async resolveSession(tokenHash: string, now: string) {
    const session = this.sessions.get(tokenHash);
    return session && session.expiresAt > now && session.userId === this.account?.userId ? this.account : undefined;
  }

  async revokeSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }

  async deleteExpiredSessions(now: string) {
    for (const [hash, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(hash);
  }
}

describe('SelfHostAuthService', () => {
  it('attaches the first owner account to the existing default user and stores only derived secrets', async () => {
    const store = new MemoryAuthStore();
    const service = new SelfHostAuthService(store, 'user_existing', () => new Date('2026-08-27T00:00:00.000Z'));

    const session = await service.register({
      username: 'Koho_51',
      displayName: '코호',
      password: 'correct horse battery staple',
    });

    expect(store.account).toMatchObject({
      userId: 'user_existing',
      username: 'Koho_51',
      normalizedUsername: 'koho_51',
      displayName: '코호',
    });
    expect(store.account?.passwordDigest).not.toContain('correct horse');
    expect(store.account?.passwordSalt).not.toContain('correct horse');
    expect([...store.sessions.keys()]).toEqual([selfHostSessionTokenHash(session.token)]);
    expect([...store.sessions.keys()][0]).not.toBe(session.token);
    expect(await service.authenticateSession(session.token)).toEqual({ username: 'Koho_51', displayName: '코호' });
    const restartedService = new SelfHostAuthService(
      store,
      'user_existing',
      () => new Date('2026-08-28T00:00:00.000Z'),
    );
    expect(await restartedService.authenticateSession(session.token)).toEqual({
      username: 'Koho_51',
      displayName: '코호',
    });
  });

  it('allows later login with normalized username and revokes only the current session on logout', async () => {
    const store = new MemoryAuthStore();
    const service = new SelfHostAuthService(store, 'user_existing');
    const first = await service.register({ username: 'Reader.Owner', password: 'long personal password' });

    await expect(
      service.login({ username: 'Reader.Owner', password: 'wrong password value', throttleKey: 'test' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials', status: 401 });

    const second = await service.login({
      username: 'reader.owner',
      password: 'long personal password',
      throttleKey: 'test',
    });
    expect(await service.authenticateSession(first.token)).toBeDefined();
    expect(await service.authenticateSession(second.token)).toBeDefined();

    await service.logout(second.token);
    expect(await service.authenticateSession(second.token)).toBeUndefined();
    expect(await service.authenticateSession(first.token)).toBeDefined();
  });

  it('rejects a second registration and malformed owner credentials', async () => {
    const store = new MemoryAuthStore();
    const service = new SelfHostAuthService(store, 'user_existing');

    await expect(service.register({ username: 'x', password: 'short' })).rejects.toBeInstanceOf(SelfHostAuthError);
    await service.register({ username: 'owner', password: 'a sufficiently long password' });
    await expect(
      service.register({ username: 'other', password: 'another sufficiently long password' }),
    ).rejects.toMatchObject({ code: 'account_already_registered', status: 409 });
  });

  it('fails closed if DEFAULT_USER_ID no longer owns the configured account', async () => {
    const store = new MemoryAuthStore();
    const original = new SelfHostAuthService(store, 'user_original');
    const session = await original.register({ username: 'owner', password: 'a sufficiently long password' });
    const changed = new SelfHostAuthService(store, 'user_changed');

    await expect(changed.status(session.token)).rejects.toThrow('self_host_account_owner_mismatch');
    await expect(changed.authenticateSession(session.token)).rejects.toThrow('self_host_account_owner_mismatch');
  });

  it('keeps rotating failed-client admission keys bounded', async () => {
    const service = new SelfHostAuthService(new MemoryAuthStore(), 'user_existing');

    for (let index = 0; index < 1_005; index += 1) {
      await expect(
        service.login({ username: 'unknown', password: '', throttleKey: `client-${index}` }),
      ).rejects.toMatchObject({ code: 'invalid_credentials' });
    }

    const failures = (
      service as unknown as { readonly loginFailures: ReadonlyMap<string, { count: number; startedAt: number }> }
    ).loginFailures;
    expect(failures.size).toBeLessThanOrEqual(1_000);
  });
});
