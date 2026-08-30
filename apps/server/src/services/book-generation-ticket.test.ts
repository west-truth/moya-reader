import { describe, expect, it, vi } from 'vitest';
import {
  assertBookGenerationTicket,
  assertCreateOnlyBookTarget,
  captureBookGenerationTicket,
} from './book-generation-ticket.js';

function queryable(rowsByQuery: (sql: string) => unknown[]) {
  return {
    query: vi.fn(async (sql: string) => ({ rows: rowsByQuery(sql), rowCount: 1 })),
  };
}

describe('book generation tickets', () => {
  it('captures the persistent generation and active content revision under row locks', async () => {
    const db = queryable((sql) =>
      sql.includes('book_id_generations')
        ? [{ generation: '4' }]
        : [{ active_content_revision_id: 'revision-r2', deleted_at: null }],
    );

    await expect(captureBookGenerationTicket(db as never, 'user-1', 'book-1')).resolves.toEqual({
      generation: 4,
      activeContentRevisionId: 'revision-r2',
      deleted: false,
    });
    expect(
      db.query.mock.calls
        .filter(([sql]) => String(sql).startsWith('select'))
        .every(([sql]) => String(sql).includes('for update')),
    ).toBe(true);
  });

  it('rejects an R1 ticket after purge and same-id R2 creation', async () => {
    const db = queryable((sql) =>
      sql.includes('book_id_generations')
        ? [{ generation: '3' }]
        : [{ active_content_revision_id: 'revision-r2', deleted_at: null }],
    );

    await expect(
      assertBookGenerationTicket(db as never, {
        userId: 'user-1',
        bookId: 'book-1',
        expectedGeneration: 1,
        expectedActiveContentRevisionId: 'revision-r1',
        requireExisting: true,
      }),
    ).rejects.toThrow('book_generation_changed:generation_changed');
  });

  it('rejects queued work while its canonical target is in trash', async () => {
    const db = queryable((sql) =>
      sql.includes('book_id_generations')
        ? [{ generation: '1' }]
        : [{ active_content_revision_id: 'revision-r1', deleted_at: '2026-08-31T00:00:00.000Z' }],
    );

    await expect(
      assertBookGenerationTicket(db as never, {
        userId: 'user-1',
        bookId: 'book-1',
        expectedGeneration: 1,
        requireExisting: true,
      }),
    ).rejects.toThrow('book_target_is_trashed');
  });

  it('makes no-client-id imports create-only after their deterministic id is parsed', async () => {
    const db = queryable(() => [{ active_content_revision_id: 'revision-r2', deleted_at: null }]);
    await expect(assertCreateOnlyBookTarget(db as never, 'user-1', 'book-1')).rejects.toThrow(
      'book_generation_changed:target_exists',
    );
  });
});
