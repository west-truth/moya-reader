import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAuthHook } from './auth.js';
import type { ServerConfig } from './config.js';
import { buildServer, registerCorsPolicy, registerSafeErrorHandler } from './server.js';

function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir: '.server-test-data',
    maxChunkBytes: 1024,
    maxUploadBytes: 1024 * 1024,
    staleUploadMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    corsAllowedOrigins: ['https://reader.example'],
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

async function corsApp() {
  const app = Fastify({ logger: false });
  registerCorsPolicy(app, testConfig());
  app.get('/api/books', async () => ({ books: [] }));
  return app;
}

describe('server CORS policy', () => {
  it('reflects only an exact allowlisted origin', async () => {
    const app = await corsApp();
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: { origin: 'https://reader.example' },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://reader.example');
    expect(allowed.headers.vary).toContain('Origin');
    expect(allowed.headers['access-control-allow-origin']).not.toBe('*');
    await app.close();
  });

  it('rejects non-allowlisted browser origins without reflecting them', async () => {
    const app = await corsApp();
    const denied = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: { origin: 'https://attacker.example' },
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'cors_origin_denied' });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('allows a browser request whose Origin matches the self-host Host header', async () => {
    const app = await corsApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: {
        host: 'moya.wireguard.internal',
        origin: 'https://moya.wireguard.internal',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://moya.wireguard.internal');
    await app.close();
  });

  it('answers valid preflight requests and rejects unsupported headers', async () => {
    const app = await corsApp();
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/books',
      headers: {
        origin: 'https://reader.example',
        'access-control-request-method': 'PUT',
        'access-control-request-headers':
          'Authorization, Content-Type, Range, X-Cover-Content-Type, X-Cover-Content-Hash, X-Cover-File-Name, X-Cover-Width, X-Cover-Height, X-Cover-Fit, X-Cover-Position-X, X-Cover-Position-Y, X-Cover-Provenance, X-Expected-Metadata-Revision',
      },
    });
    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/api/books',
      headers: {
        origin: 'https://reader.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'X-Internal-Token',
      },
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://reader.example');
    expect(allowed.headers['access-control-allow-headers']).toContain('Range');
    expect(allowed.headers['access-control-allow-headers']).toContain('X-Expected-Metadata-Revision');
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'cors_preflight_denied' });
    await app.close();
  });

  it('exposes asset, page, source, and byte-range response metadata', async () => {
    const app = await corsApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: { origin: 'https://reader.example' },
    });
    const exposed = response.headers['access-control-expose-headers'] ?? '';

    expect(exposed).toContain('X-Asset-Kind');
    expect(exposed).toContain('X-Asset-Provenance');
    expect(exposed).toContain('X-Asset-Content-Hash');
    expect(exposed).toContain('X-Page-Index');
    expect(exposed).toContain('X-Source-File-Name');
    expect(exposed).toContain('X-Source-Content-Hash');
    expect(exposed).toContain('Accept-Ranges');
    expect(exposed).toContain('Content-Range');
    expect(exposed).toContain('Content-Disposition');
    await app.close();
  });

  it('keeps requests without a browser Origin header usable', async () => {
    const app = await corsApp();
    const response = await app.inject({ method: 'GET', url: '/api/books' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});

describe('server startup security', () => {
  it('rejects an unauthenticated external listener before infrastructure initialization', async () => {
    const config = testConfig();

    await expect(
      buildServer({
        ...config,
        host: '0.0.0.0',
        exposure: 'external',
      }),
    ).rejects.toThrow(/READER_AUTH_TOKEN is required/);
  });

  it('requires both an allowlisted origin and bearer auth on protected external routes', async () => {
    const config: ServerConfig = {
      ...testConfig(),
      host: '0.0.0.0',
      exposure: 'external',
      authToken: 'server-token',
    };
    const app = Fastify({ logger: false });
    registerCorsPolicy(app, config);
    await registerAuthHook(app, config);
    app.get('/api/books', async () => ({ books: [] }));

    const missingAuth = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: { origin: 'https://reader.example' },
    });
    const deniedOrigin = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: {
        origin: 'https://attacker.example',
        authorization: 'Bearer server-token',
      },
    });
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/books',
      headers: {
        origin: 'https://reader.example',
        authorization: 'Bearer server-token',
      },
    });

    expect(missingAuth.statusCode).toBe(401);
    expect(deniedOrigin.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });
});

describe('server error boundary', () => {
  it('does not expose internal 500 details to a self-host client', async () => {
    const app = Fastify({ logger: false });
    registerSafeErrorHandler(app);
    app.get('/explode', async () => {
      throw new Error('database password and object internals must not escape');
    });

    const response = await app.inject({ method: 'GET', url: '/explode' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: '서버 요청을 처리하지 못했습니다.',
      code: 'internal_server_error',
    });
    expect(response.body).not.toContain('database password');
    await app.close();
  });

  it('keeps actionable client errors readable', async () => {
    const app = Fastify({ logger: false });
    registerSafeErrorHandler(app);
    app.get('/invalid', async () => {
      const error = Object.assign(new Error('invalid request value'), { statusCode: 400, code: 'bad_input' });
      throw error;
    });

    const response = await app.inject({ method: 'GET', url: '/invalid' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid request value', code: 'bad_input' });
    await app.close();
  });
});
