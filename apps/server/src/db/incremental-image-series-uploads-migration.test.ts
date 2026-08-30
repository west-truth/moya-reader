import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./migrations/0036_incremental_image_series_uploads.sql', import.meta.url);

describe('incremental image-series upload migration', () => {
  it('adds a bounded append mode and an optional optimistic base revision', async () => {
    const sql = (await readFile(migrationUrl, 'utf8')).toLowerCase();

    expect(sql).toContain("import_mode text not null default 'replace_book'");
    expect(sql).toContain('base_active_content_revision_id text');
    expect(sql).toContain("check (import_mode in ('replace_book', 'append_image_series'))");
  });
});
