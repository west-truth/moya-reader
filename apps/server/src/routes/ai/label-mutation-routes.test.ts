import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  labelMutationCommandHash,
  type ApplyLabelCorrectionsCommandV2,
  type ApplyLabelCorrectionsResultV2,
} from '../../../../../src/providers/label-mutation-contract';
import { appWithAIRoutes } from './ai-route-test-harness.js';

function command(): ApplyLabelCorrectionsCommandV2 {
  return {
    operationId: 'mutation_1',
    bookId: 'book_1',
    chapterId: 'chapter_1',
    createdAt: '2026-07-11T00:00:00.000Z',
    expected: {
      contentRevisionId: 'content_1',
      correctionRevisionId: 'corrections_1',
      segmentCollectionRevision: 'segments_1',
    },
    edits: [
      {
        segmentId: 'segment_1',
        expectedSegmentHash: 'segment_hash_1',
        patch: { emotion: 'sadness' },
        intent: { kind: 'segment_only' },
      },
    ],
  };
}

describe('label mutation routes', () => {
  it('rejects a path and command book mismatch before opening a transaction', async () => {
    const pool = { connect: vi.fn() } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_2/label-mutations',
      payload: command(),
    });

    expect(response.statusCode).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the stored receipt for an idempotent retry without mutation queries', async () => {
    const input = command();
    const stored: ApplyLabelCorrectionsResultV2 = {
      operationId: input.operationId,
      revisions: { segmentCollectionRevision: 'segments_2', correctionRevisionId: 'corrections_2' },
      updatedSegmentIds: ['segment_1'],
      createdCorrectionIds: ['correction_1'],
      invalidation: { obsoleteReviewArtifactIds: [], staleTTSRenderItemIds: [] },
      syncEventIds: ['sync_1'],
    };
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('from label_mutation_operations')) {
          return { rows: [{ command_hash: labelMutationCommandHash(input), result_json: stored }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/label-mutations',
      payload: input,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(stored);
    expect(queries).toEqual(['begin', expect.stringContaining('from label_mutation_operations'), 'commit']);
    expect(client.release).toHaveBeenCalledOnce();
    await app.close();
  });

  it('maps malformed commands to a client error', async () => {
    const pool = { connect: vi.fn() } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/label-mutations',
      payload: { bookId: 'book_1' },
    });

    expect(response.statusCode).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
    await app.close();
  });
});
