import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./migrations/0037_unique_book_content_revision_incarnations.sql', import.meta.url);

describe('unique book content revision incarnations migration', () => {
  it('gives every newly inserted book incarnation a non-reusable initial revision id', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain("new.id || ':' || gen_random_uuid()::text");
    expect(sql).not.toContain("revision_id := 'content_revision:initial:' || new.id;");
  });
});
