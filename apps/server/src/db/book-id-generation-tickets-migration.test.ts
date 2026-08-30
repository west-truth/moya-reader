import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./migrations/0039_book_id_generation_tickets.sql', import.meta.url);

describe('book id generation ticket migration', () => {
  it('persists generations across canonical deletes and snapshots them on uploads', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain('create table if not exists book_id_generations');
    expect(sql).toContain('after insert or delete on library_books');
    expect(sql).toContain('book_id_generations.generation + 1');
    expect(sql).toContain('target_book_generation bigint');
    expect(sql).toContain('target_active_content_revision_id text');
    expect(sql).not.toContain('references library_books');
  });
});
