import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { requestProgress } from './request-progress.js';
import { registerAuthHook } from '../auth.js';
import type { ServerConfig } from '../config.js';

it('keeps progress authenticated, bounded, isolated and short lived after completion', async () => {
  const app = Fastify();
  await registerAuthHook(app, { host: '127.0.0.1', authToken: 'test-token' } as ServerConfig);
  const track = requestProgress(app, '/api/progress/:progressId');
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const update = track({ progressId: id });
  const value = { phase: 'downloading' as const, completed: 12, total: 28, unit: 'images' as const };
  update(value);
  track({ progressId: id })({ phase: 'saving' });
  const url = `/api/progress/${id}`;
  const headers = { authorization: 'Bearer test-token' };
  try {
    expect((await app.inject(url)).statusCode).toBe(401);
    const response = await app.inject({ url, headers });
    expect(response.json()).toEqual(value);
    expect(response.headers['cache-control']).toBe('no-store');
    for (let n = 0; n < 64; n++) track({ progressId: n.toString(16).padStart(36, '0') })({ phase: 'saving' });
    expect((await app.inject({ url: `/api/progress/${'3f'.padStart(36, '0')}`, headers })).statusCode).toBe(404);
    update({ phase: 'finalizing' });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
    expect(() => track({ progressId: '../invalid' })({ phase: 'saving' })).not.toThrow();
  } finally {
    vi.restoreAllMocks();
    await app.close();
  }
});
