import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./migrations/0034_fixed_document_sections.sql', import.meta.url);

describe('fixed-document section migration', () => {
  it('adds the hosted series identity columns used by the reader', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain('document_section_count integer');
    expect(sql).toContain('document_section_id text');
    expect(sql).toContain('document_section_title text');
    expect(sql).toContain('document_section_index integer');
    expect(sql).toContain('document_page_index_in_section integer');
  });

  it('recovers deterministic legacy series titles and page indexes without inventing remote ids', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain('regexp_match');
    expect(sql).toContain('페이지');
    expect(sql).toContain('set document_section_title = recovered.section_title');
    expect(sql).toContain('document_page_index_in_section = recovered.page_index');
    expect(sql).toContain('set document_section_count = recovered.section_count');
    expect(sql).not.toMatch(/set\s+document_section_id\s*=/u);
  });
});
