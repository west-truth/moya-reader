create table if not exists tts_render_plans_v2 (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  workflow_id text references book_ai_workflows(id) on delete set null,
  capability_snapshot_id text references provider_capability_snapshots(id) on delete restrict,
  fingerprint text not null,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (user_id, book_id, chapter_id, fingerprint)
);

create index if not exists idx_tts_render_plans_v2_current
  on tts_render_plans_v2(user_id, book_id, chapter_id, updated_at desc);

create table if not exists tts_render_items_v2 (
  id text primary key,
  plan_id text not null references tts_render_plans_v2(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  sequence integer not null,
  render_fingerprint text not null,
  lifecycle_state text not null,
  provider_job_id text references provider_jobs(id) on delete set null,
  cache_key text,
  payload jsonb not null,
  updated_at timestamptz not null,
  unique (plan_id, sequence),
  unique (plan_id, render_fingerprint)
);

create index if not exists idx_tts_render_items_v2_retry
  on tts_render_items_v2(plan_id, lifecycle_state, sequence);

alter table tts_audio_cache add column if not exists render_item_id text;
alter table tts_audio_cache add column if not exists cache_purpose text not null default 'reading';
alter table tts_audio_cache add column if not exists sample_text_id text;
alter table tts_audio_cache add column if not exists render_fingerprint text;
alter table tts_audio_cache add column if not exists voice_entry_fingerprint text;
alter table tts_audio_cache add column if not exists pronunciation_revision_id text;
alter table tts_audio_cache add column if not exists integrity_state text not null default 'verified';
alter table tts_audio_cache add column if not exists verified_at timestamptz;
alter table tts_audio_cache add column if not exists quarantine_reason text;
alter table tts_audio_cache add column if not exists stale_at timestamptz;
alter table tts_audio_cache add column if not exists gc_after timestamptz;
alter table tts_audio_cache add column if not exists last_accessed_at timestamptz;
alter table tts_audio_cache add column if not exists timing_marks jsonb;

update tts_audio_cache
set integrity_state = 'verified', verified_at = coalesce(verified_at, updated_at)
where integrity_state = 'verified' and verified_at is null;

create index if not exists idx_tts_audio_cache_playable_v2
  on tts_audio_cache(book_id, chapter_id, cache_key)
  where lifecycle_state = 'active' and integrity_state = 'verified' and stale_at is null;

create index if not exists idx_tts_audio_cache_gc_v2
  on tts_audio_cache(gc_after)
  where integrity_state = 'quarantined' or stale_at is not null;

create table if not exists tts_audio_quarantine_v2 (
  id text primary key,
  cache_id text not null references tts_audio_cache(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  quarantined_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_tts_audio_quarantine_v2_open
  on tts_audio_quarantine_v2(book_id, quarantined_at desc)
  where resolved_at is null;

create table if not exists tts_audio_gc_leases_v2 (
  cache_id text primary key references tts_audio_cache(id) on delete cascade,
  lease_owner text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_tts_audio_gc_leases_v2_expiry
  on tts_audio_gc_leases_v2(expires_at);
