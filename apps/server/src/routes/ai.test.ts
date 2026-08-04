import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { appWithAIRoutes } from './ai/ai-route-test-harness.js';

describe('AI route composition', () => {
  it('registers every responsibility registrar through the public facade', async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    expect(app.hasRoute({ method: 'GET', url: '/api/providers' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/books/:bookId/analysis-workflow-plan' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/provider-jobs/:jobId' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/api/chapters/:chapterId/tts-cache/resolve' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/books/:bookId/character-graph' })).toBe(true);

    await app.close();
  });
});
