import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./migrations/0024_speaker_workflow_lineage.sql', import.meta.url);

describe('speaker workflow lineage migration', () => {
  it('pins revision and reveal anchors and constrains reader-visible intervals', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql.match(/content_revision_id text not null references book_content_revisions/giu)).toHaveLength(4);
    expect(sql.match(/source_reveal_anchor_id text not null/giu)).toHaveLength(2);
    expect(sql.match(/visible_from_narrative_order >= 0/giu)).toHaveLength(2);
    expect(sql.match(/visible_to_narrative_order is null or visible_to_narrative_order >=/giu)).toHaveLength(2);
    expect(sql).toMatch(/status = 'stale' and nullif\(btrim\(stale_reason\), ''\) is not null/iu);
  });
});
