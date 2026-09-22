import Fastify from 'fastify';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { registerAuthHook } from '../../auth.js';
import { registerStorageRoutes } from './storage-routes.js';
import { testConfig } from './books-route-test-harness.js';

it('requires authentication, scopes the query to this account, and never caches private usage', async () => {
  const usage = { books: [], totalBytes: 0, libraryBytes: 0, trashBytes: 0 };
  const query = vi.fn(async () => ({ rows: [{ usage }] }));
  const app = Fastify();
  const config = { ...testConfig(), authToken: 'storage-secret' };
  await registerAuthHook(app, config);
  await registerStorageRoutes(app, { query } as unknown as pg.Pool, config);
  try {
    expect((await app.inject('/api/storage/usage')).statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
    const response = await app.inject({
      url: '/api/storage/usage',
      headers: { authorization: 'Bearer storage-secret' },
    });
    expect(response.statusCode).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('user_id=$1'), ['user_test']);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ ...usage, capacity: { status: 'unavailable', reason: 'not_configured' } });
  } finally {
    await app.close();
  }
});
