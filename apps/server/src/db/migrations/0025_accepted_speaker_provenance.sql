create table if not exists accepted_speaker_provenance (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  paragraph_id text not null check (btrim(paragraph_id) <> ''),
  segment_id text not null,
  source_span_id text not null check (btrim(source_span_id) <> ''),
  scene_id text not null check (btrim(scene_id) <> ''),
  dialogue_burst_id text,
  narrative_order bigint not null check (narrative_order >= 0),
  speaker_entity_id text,
  canonical_speaker_id text not null check (btrim(canonical_speaker_id) <> ''),
  resolution_kind text not null check (
    resolution_kind in (
      'deterministic',
      'provider_candidate',
      'provider_new_mention',
      'unresolved',
      'manual_review'
    )
  ),
  source_manifest_fingerprint text not null,
  packet_fingerprint text,
  temporal_snapshot_id text,
  sequence_decision_id text,
  artifact_id text not null references analysis_staging_artifacts(id) on delete cascade,
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  status text not null check (status in ('active', 'superseded', 'stale')),
  stale_reason text,
  fingerprint text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'stale' and nullif(btrim(stale_reason), '') is not null) or
    (status in ('active', 'superseded') and stale_reason is null)
  )
);

create unique index if not exists idx_accepted_speaker_provenance_active_segment
  on accepted_speaker_provenance(user_id, content_revision_id, segment_id)
  where status = 'active';

create index if not exists idx_accepted_speaker_provenance_book_chapter_order
  on accepted_speaker_provenance(user_id, book_id, content_revision_id, chapter_id, narrative_order);

create index if not exists idx_accepted_speaker_provenance_active_speaker_entity
  on accepted_speaker_provenance(user_id, book_id, content_revision_id, speaker_entity_id, narrative_order)
  where status = 'active';
