import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { ReadinessChecks, registerHealthRoutes } from './health.js';

async function appWithHealth(pool: pg.Pool, checks?: ReadinessChecks) {
  const app = Fastify({ logger: false });
  await registerHealthRoutes(app, pool, checks);
  return app;
}

describe('health routes', () => {
  it('serves health checks from root and API-prefixed paths', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as pg.Pool;
    const app = await appWithHealth(pool);

    const root = await app.inject({ method: 'GET', url: '/health' });
    const api = await app.inject({ method: 'GET', url: '/api/health' });

    expect(root.statusCode).toBe(200);
    expect(api.statusCode).toBe(200);
    expect(root.json()).toMatchObject({ ok: true, service: 'noveldesk-server' });
    expect(api.json()).toMatchObject({ ok: true, service: 'noveldesk-server' });
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenCalledWith('select 1');
    await app.close();
  });

  it('reports readiness for database, queue, and object storage dependencies', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as pg.Pool;
    const queue = {
      getJobCounts: vi.fn(async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0 })),
    };
    const checkObjectStorage = vi.fn(async () => undefined);
    const app = await appWithHealth(pool, { queue, checkObjectStorage });

    const response = await app.inject({ method: 'GET', url: '/api/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      service: 'noveldesk-server',
      components: {
        database: { ok: true },
        queue: { ok: true },
        objectStorage: { ok: true },
      },
    });
    expect(pool.query).toHaveBeenCalledWith('select 1');
    expect(queue.getJobCounts).toHaveBeenCalledWith('waiting', 'active', 'delayed', 'failed');
    expect(checkObjectStorage).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('returns 503 readiness when a dependency is unavailable', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as pg.Pool;
    const app = await appWithHealth(pool, {
      queue: {
        getJobCounts: vi.fn(async () => {
          throw new Error('redis unavailable');
        }),
      },
    });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      components: {
        database: { ok: true },
        queue: { ok: false, error: 'redis unavailable' },
      },
    });
    await app.close();
  });
});
