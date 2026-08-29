import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config.js';
import { registerAuthHook } from '../auth.js';
import { SelfHostAuthService, type SelfHostAuthStore } from '../services/self-host-auth-service.js';
import { registerSelfHostAuthRoutes } from './auth.js';

type StoredAccount = NonNullable<Awaited<ReturnType<SelfHostAuthStore['loadAccount']>>>;

class RouteAuthStore implements SelfHostAuthStore {
  account?: StoredAccount;
  sessions = new Map<string, { userId: string; expiresAt: string }>();
  async loadAccount() {
    return this.account;
  }
  async createAccount(account: StoredAccount) {
    if (this.account) return false;
    this.account = account;
    return true;
  }
  async updateUserDisplayName() {}
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
  async deleteExpiredSessions() {}
}

function config(exposure: 'loopback' | 'external', authToken?: string): ServerConfig {
  return {
    host: exposure === 'external' ? '0.0.0.0' : '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1/test',
    redisUrl: 'redis://127.0.0.1',
    dataDir: '.server-test-data',
    maxChunkBytes: 1024,
    maxUploadBytes: 1024,
    staleUploadMaxAgeMs: 1000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    exposure,
    authToken,
    s3: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
    },
  };
}

function cookieValue(setCookie: string | string[] | undefined): string {
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0] ?? '';
}

describe('self-host account routes', () => {
  it('requires the deployment setup code once and issues a secure persistent owner session', async () => {
    const app = Fastify({ logger: false });
    const store = new RouteAuthStore();
    const service = new SelfHostAuthService(store, 'user_test');
    await registerSelfHostAuthRoutes(app, service, config('external', 'first-device-code'));

    const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(status.json()).toMatchObject({ setupRequired: true, setupCodeRequired: true, authenticated: false });
    expect(status.headers['cache-control']).toBe('no-store');

    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'wrong' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'invalid_setup_code' });

    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'first-device-code' },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.headers['set-cookie']).toContain('HttpOnly');
    expect(registered.headers['set-cookie']).toContain('SameSite=Strict');
    expect(registered.headers['set-cookie']).toContain('Secure');
    expect(registered.headers['set-cookie']).toContain('Max-Age=2592000');

    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: cookieValue(registered.headers['set-cookie']) },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true, account: { username: 'owner' } });
    await app.close();
  });

  it('logs in a second device and clears only that cookie on logout', async () => {
    const app = Fastify({ logger: false });
    const store = new RouteAuthStore();
    const service = new SelfHostAuthService(store, 'user_test');
    await registerSelfHostAuthRoutes(app, service, config('loopback'));
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password' },
    });

    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner', password: 'a sufficiently long password' },
    });
    const cookie = cookieValue(loggedIn.headers['set-cookie']);
    expect(loggedIn.statusCode).toBe(200);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    const expired = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(expired.statusCode).toBe(401);
    await app.close();
  });

  it('bounds auth request bodies and throttles an IP even when submitted usernames rotate', async () => {
    const app = Fastify({ logger: false });
    const store = new RouteAuthStore();
    const service = new SelfHostAuthService(store, 'user_test');
    await registerSelfHostAuthRoutes(app, service, config('loopback'));
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password' },
    });

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner', password: 'x'.repeat(5_000) },
    });
    expect(oversized.statusCode).toBe(413);

    for (let index = 0; index < 8; index += 1) {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: `rotated-${index}`, password: 'a sufficiently long password' },
      });
      expect(denied.statusCode).toBe(401);
    }
    const throttled = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'owner', password: 'a sufficiently long password' },
    });
    expect(throttled.statusCode).toBe(429);
    await app.close();
  });

  it('uses the durable owner cookie on protected routes while preserving bearer recovery access', async () => {
    const app = Fastify({ logger: false });
    const store = new RouteAuthStore();
    const service = new SelfHostAuthService(store, 'user_test');
    const serverConfig = config('external', 'recovery-code');
    await registerAuthHook(app, serverConfig, service);
    await registerSelfHostAuthRoutes(app, service, serverConfig);
    app.get('/api/books', async () => ({ books: [] }));

    const beforeSetup = await app.inject({ method: 'GET', url: '/api/books' });
    expect(beforeSetup.statusCode).toBe(503);

    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'owner', password: 'a sufficiently long password', setupCode: 'recovery-code' },
    });
    const cookie = cookieValue(registered.headers['set-cookie']);
    const cookieAccess = await app.inject({ method: 'GET', url: '/api/books', headers: { cookie } });
    const recoveryAccess = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: { authorization: 'Bearer recovery-code' },
    });

    expect(cookieAccess.statusCode).toBe(200);
    expect(recoveryAccess.statusCode).toBe(200);
    await app.close();
  });
});
