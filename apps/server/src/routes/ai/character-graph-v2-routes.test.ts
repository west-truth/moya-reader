import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { appWithAIRoutes } from './ai-route-test-harness.js';

describe('Character Graph v2 routes', () => {
  it('dual-reads a legacy graph while quarantining generic aliases', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('select id from library_books')) return { rows: [{ id: 'book_1' }] };
        if (sql.includes('from characters')) {
          return {
            rows: [
              {
                id: 'character-1',
                book_id: 'book_1',
                canonical_name: '한서윤',
                aliases: ['서윤', '그녀'],
                color: '#123456',
                confidence: 1,
                is_user_confirmed: true,
              },
            ],
          };
        }
        if (sql.includes('from character_relations')) return { rows: [] };
        if (sql.includes('select payload from character_')) return { rows: [] };
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({ method: 'GET', url: '/api/books/book_1/character-graph-v2' });

    expect(response.statusCode).toBe(200);
    expect(response.json().knowledge.facts).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'typed_alias', value: '서윤' })]),
    );
    expect(response.json().knowledge.mentions).toEqual([
      expect.objectContaining({ surface: '그녀', kind: 'generic_reference', status: 'candidate' }),
    ]);
    await app.close();
  });

  it('rejects malformed or path-mismatched identity commands before opening a transaction', async () => {
    const pool = {
      query: vi.fn(async (sql: string) =>
        sql.includes('select id from library_books') ? { rows: [{ id: 'book_1' }] } : { rows: [] },
      ),
      connect: vi.fn(),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/character-identity-operations',
      payload: {
        command: {
          kind: 'merge_characters_v2',
          operationId: 'operation-1',
          novelId: 'another-book',
          sourceCharacterId: 'source',
          targetCharacterId: 'target',
          expectedGraphRevision: 'revision',
          selectedFactIds: [],
          voiceConflictPolicy: 'require_review',
          createdAt: '2026-07-11T00:00:00.000Z',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
    await app.close();
  });
});
