import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./migrations/0035_fixed_document_section_read_states.sql', import.meta.url);

describe('fixed-document section read-state migration', () => {
  it('stores per-user section activity without inferring skipped sections', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain('create table if not exists fixed_document_section_read_states');
    expect(sql).toContain('primary key (book_id, user_id, document_section_id)');
    expect(sql).toContain('join chapters c on c.id = rp.chapter_id');
    expect(sql).toContain('where c.document_section_id is not null');
    expect(sql).not.toContain('document_section_index <');
  });
});
