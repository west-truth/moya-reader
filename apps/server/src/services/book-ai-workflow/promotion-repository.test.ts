import { aggregateSyncEntityId } from '@noveldesk/text-core/identity/sync';
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { insertPromotionSyncEvent } from './promotion-repository.js';

describe('promotion sync event identity', () => {
  it('canonicalizes graph and chapter aggregate ids before persistence', async () => {
    const calls: unknown[][] = [];
    const query = vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return { rows: [], rowCount: 1 };
    });
    const client = { query } as unknown as pg.PoolClient;
    const common = {
      job: { id: 'job-1', user_id: 'user-1', book_id: 'book-1' },
      artifact: { id: 'artifact-1', createdAt: '2026-08-23T00:00:00.000Z' },
    } as unknown as Pick<Parameters<typeof insertPromotionSyncEvent>[1], 'job' | 'artifact'>;

    await insertPromotionSyncEvent(client, {
      ...common,
      type: 'character_graph_updated',
      entityType: 'character_graph',
      entityId: 'character_graph_book-1',
      payload: { characters: [] },
    });
    await insertPromotionSyncEvent(client, {
      ...common,
      type: 'chapter_segments_updated',
      entityType: 'chapter_segments',
      entityId: 'chapter_segments_chapter-1',
      payload: { chapterId: 'chapter-1', segments: [] },
    });

    const graphArgs = calls[0][1] as unknown[];
    const chapterArgs = calls[1][1] as unknown[];
    expect(graphArgs[4]).toBe(aggregateSyncEntityId({ entityType: 'character_graph', novelId: 'book-1' }));
    expect(chapterArgs[4]).toBe(
      aggregateSyncEntityId({ entityType: 'chapter_segments', novelId: 'book-1', chapterId: 'chapter-1' }),
    );
    expect(JSON.parse(String(graphArgs[6])).entityId).toBe(graphArgs[4]);
    expect(JSON.parse(String(chapterArgs[6])).entityId).toBe(chapterArgs[4]);
  });
});
