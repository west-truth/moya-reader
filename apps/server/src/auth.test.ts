import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ServerConfig, type ServerExposure } from './config.js';
import { registerAuthHook } from './auth.js';
import type { SelfHostAuthService } from './services/self-host-auth-service.js';

function testConfig(authToken?: string, host = '127.0.0.1', exposure?: ServerExposure): ServerConfig {
  return {
    host,
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir: '.server-test-data',
    maxChunkBytes: 1024,
    maxUploadBytes: 1024 * 1024,
    staleUploadMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    authToken,
    exposure,
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

async function authApp(authToken?: string) {
  const app = Fastify({ logger: false });
  await registerAuthHook(app, testConfig(authToken));
  app.get('/health', async () => ({ ok: true }));
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/ready', async () => ({ ok: true }));
  app.get('/api/ready', async () => ({ ok: true }));
  app.options('/api/books', async (_request, reply) => reply.code(204).send());
  app.get('/api/books', async () => ({ books: [] }));
  return app;
}

describe('server auth hook', () => {
  it('allows API requests when no self-host token is configured', async () => {
    const app = await authApp();
    const response = await app.inject({ method: 'GET', url: '/api/books' });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('refuses to register an unauthenticated external listener', async () => {
    const app = Fastify({ logger: false });

    await expect(registerAuthHook(app, testConfig(undefined, '0.0.0.0'))).rejects.toThrow(
      /READER_AUTH_TOKEN is required/,
    );
    await app.close();
  });

  it('keeps health and preflight requests public when auth is enabled', async () => {
    const app = await authApp('secret-token');
    const health = await app.inject({ method: 'GET', url: '/health' });
    const apiHealth = await app.inject({ method: 'GET', url: '/api/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    const apiReady = await app.inject({ method: 'GET', url: '/api/ready' });
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/books' });
    expect(health.statusCode).toBe(200);
    expect(apiHealth.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(apiReady.statusCode).toBe(200);
    expect(preflight.statusCode).toBe(204);
    await app.close();
  });

  it('requires a matching bearer token for protected API requests', async () => {
    const app = await authApp('secret-token');

    const missing = await app.inject({ method: 'GET', url: '/api/books' });
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: { authorization: 'Bearer wrong-token' },
    });
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: { authorization: 'Bearer secret-token trailing-data' },
    });
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: { authorization: 'Bearer secret-token' },
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(malformed.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it('accepts an owner session cookie and blocks protected data before first-account setup', async () => {
    const app = Fastify({ logger: false });
    let setupRequired = true;
    const service = {
      setupRequired: async () => setupRequired,
      authenticateSession: async (token: string | undefined) =>
        token === 'valid-session' ? { username: 'owner', displayName: 'Owner' } : undefined,
    } as SelfHostAuthService;
    await registerAuthHook(app, testConfig(), service);
    app.get('/api/books', async () => ({ books: [] }));

    const setup = await app.inject({ method: 'GET', url: '/api/books' });
    expect(setup.statusCode).toBe(503);
    expect(setup.json()).toEqual({ error: 'account_setup_required' });

    setupRequired = false;
    const missing = await app.inject({ method: 'GET', url: '/api/books' });
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: { cookie: 'moya_session=valid-session' },
    });
    expect(missing.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });
});
