import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('./migrations/0025_accepted_speaker_provenance.sql', import.meta.url);

describe('accepted speaker provenance migration', () => {
  it('defines the idempotent table and cascade ownership boundaries', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toMatch(/create table if not exists accepted_speaker_provenance/iu);
    expect(sql).toMatch(/user_id text not null references users\(id\) on delete cascade/iu);
    expect(sql).toMatch(/book_id text not null references library_books\(id\) on delete cascade/iu);
    expect(sql).toMatch(
      /content_revision_id text not null references book_content_revisions\(id\) on delete cascade/iu,
    );
    expect(sql).toMatch(/chapter_id text not null references chapters\(id\) on delete cascade/iu);
    expect(sql).toMatch(/paragraph_id text not null check \(btrim\(paragraph_id\) <> ''\)/iu);
    expect(sql).not.toMatch(/references paragraphs/iu);
    expect(sql).toMatch(/source_span_id text not null check \(btrim\(source_span_id\) <> ''\)/iu);
    expect(sql).toMatch(/scene_id text not null check \(btrim\(scene_id\) <> ''\)/iu);
    expect(sql).toMatch(/artifact_id text not null references analysis_staging_artifacts\(id\) on delete cascade/iu);
  });

  it('constrains accepted resolution, lifecycle, and payload values', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toMatch(/narrative_order bigint not null check \(narrative_order >= 0\)/iu);
    expect(sql).toMatch(/canonical_speaker_id text not null check \(btrim\(canonical_speaker_id\) <> ''\)/iu);
    expect(sql).toMatch(
      /resolution_kind in \(\s*'deterministic',\s*'provider_candidate',\s*'provider_new_mention',\s*'unresolved',\s*'manual_review'\s*\)/iu,
    );
    expect(sql).toMatch(/confidence double precision not null check \(confidence >= 0 and confidence <= 1\)/iu);
    expect(sql).toMatch(/status text not null check \(status in \('active', 'superseded', 'stale'\)\)/iu);
    expect(sql).toMatch(/status = 'stale' and nullif\(btrim\(stale_reason\), ''\) is not null/iu);
    expect(sql).toMatch(/status in \('active', 'superseded'\) and stale_reason is null/iu);
    expect(sql).toMatch(/payload jsonb not null check \(jsonb_typeof\(payload\) = 'object'\)/iu);
  });

  it('defines the active uniqueness and lookup indexes idempotently', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toMatch(
      /create unique index if not exists idx_accepted_speaker_provenance_active_segment\s+on accepted_speaker_provenance\(user_id, content_revision_id, segment_id\)\s+where status = 'active'/iu,
    );
    expect(sql).toMatch(
      /create index if not exists idx_accepted_speaker_provenance_book_chapter_order\s+on accepted_speaker_provenance\(user_id, book_id, content_revision_id, chapter_id, narrative_order\)/iu,
    );
    expect(sql).toMatch(
      /create index if not exists idx_accepted_speaker_provenance_active_speaker_entity\s+on accepted_speaker_provenance\(user_id, book_id, content_revision_id, speaker_entity_id, narrative_order\)\s+where status = 'active'/iu,
    );
  });
});
