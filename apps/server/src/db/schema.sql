-- Consolidated schema snapshot for review and fresh-schema inspection.
-- Runtime upgrades are applied only from db/migrations by migrate.ts.

create table if not exists users (
  id text primary key,
  email text unique not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists devices (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  label text not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists book_objects (
  id text primary key,
  raw_text_hash text not null unique,
  storage_key text not null,
  file_name text not null,
  content_type text not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now()
);

create table if not exists library_books (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  object_id text references book_objects(id) on delete set null,
  title text not null,
  source_file_name text not null,
  source_encoding text,
  normalized_text_hash text not null,
  total_chapters integer not null,
  total_characters integer not null,
  total_paragraphs integer not null,
  document_section_count integer,
  cover_seed integer not null default 0,
  favorite boolean not null default false,
  analysis_status text not null default 'not_analyzed',
  metadata_revision bigint not null default 0,
  deleted_at timestamptz,
  deleted_by_device_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_library_books_active_catalog
  on library_books(user_id, updated_at desc)
  where deleted_at is null;

create index if not exists idx_library_books_trash_catalog
  on library_books(user_id, deleted_at desc)
  where deleted_at is not null;

create table if not exists chapters (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  chapter_index integer not null,
  title text not null,
  text_hash text not null,
  raw_start_offset integer not null,
  raw_end_offset integer not null,
  character_count integer not null,
  paragraph_count integer not null,
  document_section_id text,
  document_section_title text,
  document_section_index integer,
  document_page_index_in_section integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, chapter_index)
);

create table if not exists paragraph_pages (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  page_index integer not null,
  start_paragraph_index integer not null,
  end_paragraph_index integer not null,
  paragraphs jsonb not null,
  text_hash text not null,
  created_at timestamptz not null default now(),
  unique (chapter_id, page_index)
);

create table if not exists paragraph_search (
  id text primary key,
  paragraph_id text not null,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  page_index integer not null,
  paragraph_index integer not null,
  text text not null,
  text_lower text not null,
  paragraph jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists reading_positions (
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  chapter_id text not null,
  paragraph_id text,
  paragraph_index integer not null default 0,
  offset_in_paragraph integer not null default 0,
  chapter_progress numeric not null default 0,
  scroll_top integer not null default 0,
  device_id text,
  updated_at timestamptz not null default now(),
  primary key (book_id, user_id)
);

create table if not exists fixed_document_section_read_states (
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  document_section_id text not null,
  last_read_at timestamptz not null,
  primary key (book_id, user_id, document_section_id)
);

create index if not exists idx_fixed_document_section_read_states_user
  on fixed_document_section_read_states(user_id, last_read_at desc);

create table if not exists bookmarks (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  chapter_id text not null,
  paragraph_id text,
  label text not null,
  progress numeric not null default 0,
  scroll_top integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists highlights (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  chapter_id text not null,
  paragraph_id text not null,
  quote text not null,
  color text not null,
  progress numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists notes (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  chapter_id text not null,
  paragraph_id text,
  quote text,
  body text not null,
  progress numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists reader_settings (
  user_id text primary key references users(id) on delete cascade,
  settings jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists sync_events (
  sequence bigserial primary key,
  id text unique not null,
  user_id text not null references users(id) on delete cascade,
  device_id text,
  type text not null,
  book_id text,
  entity_id text,
  payload jsonb not null,
  revision jsonb,
  created_at timestamptz not null default now()
);

alter table sync_events add column if not exists revision jsonb;

create table if not exists upload_sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  file_name text not null,
  size_bytes bigint not null,
  content_type text not null,
  encoding text not null default 'auto',
  chapter_split_mode text not null default 'auto',
  client_hash_hint text,
  source_content_hash text,
  client_book_id text,
  import_mode text not null default 'replace_book'
    check (import_mode in ('replace_book', 'append_image_series')),
  base_active_content_revision_id text,
  status text not null default 'uploading',
  total_chunks integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists upload_chunks (
  upload_id text not null references upload_sessions(id) on delete cascade,
  chunk_index integer not null,
  size_bytes integer not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  primary key (upload_id, chunk_index)
);

create table if not exists import_jobs (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  upload_id text not null references upload_sessions(id) on delete cascade,
  status text not null default 'queued',
  stage text not null default 'queued',
  bytes_read bigint not null default 0,
  total_bytes bigint not null default 0,
  chapters_detected integer not null default 0,
  paragraphs_written integer not null default 0,
  message text,
  book_id text,
  error_message text,
  cancel_requested_at timestamptz,
  queue_generation bigint not null default 0,
  active_queue_job_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table import_jobs add column if not exists stage text not null default 'queued';
alter table import_jobs add column if not exists bytes_read bigint not null default 0;
alter table import_jobs add column if not exists total_bytes bigint not null default 0;
alter table import_jobs add column if not exists chapters_detected integer not null default 0;
alter table import_jobs add column if not exists paragraphs_written integer not null default 0;
alter table import_jobs add column if not exists message text;
alter table upload_sessions add column if not exists client_book_id text;
alter table upload_sessions add column if not exists chapter_split_mode text not null default 'auto';
alter table upload_sessions add column if not exists source_content_hash text;
alter table upload_sessions add column if not exists import_mode text not null default 'replace_book';
alter table upload_sessions add column if not exists base_active_content_revision_id text;
alter table import_jobs add column if not exists cancel_requested_at timestamptz;
alter table import_jobs add column if not exists queue_generation bigint not null default 0;
alter table import_jobs add column if not exists active_queue_job_id text;

create table if not exists object_delete_outbox (
  id bigserial primary key,
  storage_key text not null unique,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'retry')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_object_delete_outbox_ready
  on object_delete_outbox(next_attempt_at, id)
  where status in ('pending', 'retry');
alter table library_books add column if not exists analysis_status text not null default 'not_analyzed';
alter table bookmarks add column if not exists updated_at timestamptz not null default now();
alter table bookmarks add column if not exists deleted_at timestamptz;
alter table highlights add column if not exists deleted_at timestamptz;
alter table notes add column if not exists deleted_at timestamptz;

create table if not exists characters (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  canonical_name text not null,
  aliases jsonb not null default '[]'::jsonb,
  color text not null,
  description text,
  confidence numeric not null default 0,
  is_user_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists character_aliases (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  character_id text not null references characters(id) on delete cascade,
  alias text not null,
  alias_type text not null default 'name',
  confidence numeric not null default 0,
  evidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists character_relations (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  source_character_id text not null references characters(id) on delete cascade,
  target_character_id text not null references characters(id) on delete cascade,
  relation_label text not null,
  terms_used_by_source jsonb not null default '[]'::jsonb,
  terms_used_by_target jsonb not null default '[]'::jsonb,
  confidence numeric not null default 0,
  evidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists analysis_runs (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text references chapters(id) on delete cascade,
  run_type text not null,
  provider_id text not null,
  model_id text,
  prompt_version text,
  input_hash text not null,
  output_hash text,
  status text not null,
  error_message text,
  metadata jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists chapter_contexts (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  analysis_run_id text references analysis_runs(id) on delete set null,
  summary text not null,
  active_character_ids jsonb not null default '[]'::jsonb,
  unresolved jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chapter_id)
);

create table if not exists voice_profiles (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  character_id text references characters(id) on delete set null,
  role text not null,
  provider_id text not null,
  provider_voice_id text not null,
  provider_model text,
  label text not null,
  language text,
  tone text,
  speed numeric not null default 1,
  pitch numeric,
  emotion_policy text,
  provider_options jsonb not null default '{}'::jsonb,
  is_user_selected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Voice discovery, sample approval, and pronunciation lifecycle (migration 0015).
create table if not exists voice_catalog_snapshots (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  provider_id text not null,
  model_id text,
  fingerprint text not null,
  payload jsonb not null,
  captured_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists voice_catalog_entries (
  id text not null,
  snapshot_id text not null references voice_catalog_snapshots(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  provider_id text not null,
  voice_id text not null,
  fingerprint text not null,
  available boolean not null,
  payload jsonb not null,
  primary key (snapshot_id, id)
);
create table if not exists voice_suggestions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  voice_profile_id text not null,
  character_id text,
  major boolean not null default false,
  payload jsonb not null,
  created_at timestamptz not null
);
create table if not exists voice_sample_requests (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  voice_profile_id text not null,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null
);
create table if not exists voice_sample_approvals (
  approval_id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  voice_profile_id text not null,
  decision text not null,
  stale_reason text,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists pronunciation_profiles (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  revision integer not null,
  revision_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null
);
create table if not exists voice_product_preferences (
  book_id text primary key references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  minor_fallback_enabled boolean not null default false,
  major_character_limit integer not null default 5,
  updated_at timestamptz not null default now()
);

-- Authoritative voice-casting aggregate (migration 0026). Legacy voice-product
-- replacement routes intentionally do not write this table.
create table if not exists voice_casting_states (
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  version text not null check (version = 'voice-casting-v1'),
  revision integer not null check (revision > 0),
  state_payload jsonb not null check (jsonb_typeof(state_payload) = 'object'),
  user_authored_payload jsonb not null check (jsonb_typeof(user_authored_payload) = 'object'),
  derived_payload jsonb not null check (jsonb_typeof(derived_payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

create index if not exists idx_voice_casting_states_book_revision
  on voice_casting_states(user_id, book_id, revision);

create index if not exists idx_voice_casting_states_updated
  on voice_casting_states(user_id, updated_at desc);

create table if not exists labeled_segments (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  paragraph_id text not null,
  segment_index integer not null,
  start_offset integer not null,
  end_offset integer not null,
  segment_text_hash text not null,
  segment_type text not null,
  speaker_id text not null,
  candidate_speakers jsonb not null default '[]'::jsonb,
  listener_ids jsonb not null default '[]'::jsonb,
  emotion text not null default 'neutral',
  confidence numeric not null default 0,
  evidence text,
  voice_profile_id text,
  is_user_corrected boolean not null default false,
  analysis_run_id text references analysis_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_corrections (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text references chapters(id) on delete set null,
  paragraph_id text,
  segment_id text references labeled_segments(id) on delete set null,
  correction_type text not null,
  before_json jsonb,
  after_json jsonb not null,
  apply_scope text not null,
  created_at timestamptz not null default now()
);

create table if not exists provider_settings (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  scope text not null,
  default_provider_id text,
  enabled_provider_ids jsonb not null default '[]'::jsonb,
  model_overrides jsonb not null default '{}'::jsonb,
  provider_options jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, scope)
);

create table if not exists provider_secrets (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  scope text not null,
  provider_id text not null,
  secret_name text not null,
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  key_version text not null,
  fingerprint text not null,
  last4 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, scope, provider_id, secret_name)
);

create table if not exists book_ai_workflows (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  workflow_type text not null default 'book_ai_tts',
  workflow_definition_id text not null default 'moya.ai.tts.book-preparation',
  workflow_version text not null default '1.0.0',
  provider_id text not null,
  model_id text,
  plan_hash text not null,
  plan jsonb not null,
  status text not null,
  stage text not null,
  progress jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists provider_jobs (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text references chapters(id) on delete cascade,
  job_type text not null,
  provider_id text not null,
  model_id text,
  input_hash text not null,
  status text not null,
  stage text not null default 'queued',
  progress jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (book_id, chapter_id, job_type, provider_id, model_id, input_hash)
);

alter table provider_jobs add column if not exists current_attempt_id text;
alter table provider_jobs add column if not exists attempt_count integer not null default 0;

create unique index if not exists idx_provider_jobs_unique_input_v2
  on provider_jobs(user_id, book_id, coalesce(chapter_id, ''), job_type, provider_id, coalesce(model_id, ''), input_hash);

create table if not exists provider_job_attempts (
  id text primary key,
  provider_job_id text not null references provider_jobs(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  bullmq_job_id text not null unique,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  stage text not null default 'queued',
  progress jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (provider_job_id, attempt_number)
);

create index if not exists idx_provider_job_attempts_job_status
  on provider_job_attempts(provider_job_id, status, attempt_number desc);

create index if not exists idx_provider_job_attempts_job_created
  on provider_job_attempts(provider_job_id, created_at desc);

create table if not exists provider_job_outbox (
  id text primary key,
  provider_job_id text not null references provider_jobs(id) on delete cascade,
  attempt_id text not null unique references provider_job_attempts(id) on delete cascade,
  bullmq_job_id text not null unique,
  status text not null default 'pending' check (status in ('pending', 'published')),
  publish_attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

create index if not exists idx_provider_job_outbox_pending
  on provider_job_outbox(status, created_at);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'provider_jobs_current_attempt_fk'
  ) then
    alter table provider_jobs
      add constraint provider_jobs_current_attempt_fk
      foreign key (current_attempt_id)
      references provider_job_attempts(id)
      on delete set null
      deferrable initially deferred;
  end if;
end $$;

create or replace function guard_provider_job_status_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if new.status = 'queued' then
    if old.status not in ('succeeded', 'failed', 'cancelled') then
      raise exception 'invalid provider job status transition: % -> %', old.status, new.status
        using errcode = '23514';
    end if;
    new.current_attempt_id := null;
  elsif new.status = 'running' then
    if old.status <> 'queued' or new.current_attempt_id is null then
      raise exception 'invalid provider job status transition: % -> %', old.status, new.status
        using errcode = '23514';
    end if;
  elsif new.status = 'failed' and old.status = 'queued' then
    if new.error_code <> 'provider_job_admission_rejected' or new.current_attempt_id is not null then
      raise exception 'invalid provider job status transition: % -> %', old.status, new.status
        using errcode = '23514';
    end if;
  elsif new.status in ('succeeded', 'failed') then
    if old.status <> 'running' then
      raise exception 'invalid provider job status transition: % -> %', old.status, new.status
        using errcode = '23514';
    end if;
  elsif new.status = 'cancelled' then
    if old.status not in ('queued', 'running') then
      raise exception 'invalid provider job status transition: % -> %', old.status, new.status
        using errcode = '23514';
    end if;
  else
    raise exception 'invalid provider job status transition: % -> %', old.status, new.status
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function guard_provider_job_status_transition() is
  'Secondary invariant guard. Queued jobs may fail without an attempt only for persisted provider admission rejection.';

drop trigger if exists provider_jobs_status_transition_guard on provider_jobs;
create trigger provider_jobs_status_transition_guard
before update of status on provider_jobs
for each row
execute function guard_provider_job_status_transition();

create table if not exists book_ai_workflow_jobs (
  id text primary key,
  workflow_id text not null references book_ai_workflows(id) on delete cascade,
  provider_job_id text not null references provider_jobs(id) on delete cascade,
  stage text not null,
  plan_item_id text not null,
  sequence integer not null,
  created_at timestamptz not null default now(),
  unique (workflow_id, provider_job_id),
  unique (workflow_id, stage, plan_item_id)
);

-- Declared here because the monolithic bootstrap creates TTS render plans before
-- the versioned capability migration is adopted.
create table if not exists provider_capability_snapshots (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  capability_kind text not null check (capability_kind in ('llm', 'tts')),
  provider_id text not null,
  requested_model_id text not null,
  resolved_model_version text,
  source text not null,
  freshness text not null,
  fingerprint text not null,
  payload jsonb not null,
  verified_at timestamptz not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, fingerprint)
);

create table if not exists tts_audio_cache (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  cache_key text not null unique,
  provider_id text not null,
  provider_model text,
  provider_version text,
  voice_profile_id text not null,
  speaker_id text,
  segment_ids jsonb not null default '[]'::jsonb,
  segment_text_hashes jsonb not null default '{}'::jsonb,
  input_text_hash text not null,
  options_hash text not null,
  render_spec_hash text,
  audio_object_key text not null,
  content_type text,
  byte_size integer,
  audio_hash text,
  duration_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tts_audio_cache add column if not exists provider_version text;
alter table tts_audio_cache add column if not exists speaker_id text;
alter table tts_audio_cache add column if not exists segment_text_hashes jsonb not null default '{}'::jsonb;
alter table tts_audio_cache add column if not exists render_spec_hash text;
alter table tts_audio_cache add column if not exists content_type text;
alter table tts_audio_cache add column if not exists byte_size integer;
alter table tts_audio_cache add column if not exists audio_hash text;
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
  updated_at timestamptz not null
);
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
  updated_at timestamptz not null
);
create table if not exists tts_audio_quarantine_v2 (
  id text primary key,
  cache_id text not null references tts_audio_cache(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  quarantined_at timestamptz not null default now(),
  resolved_at timestamptz
);
create table if not exists tts_audio_gc_leases_v2 (
  cache_id text primary key references tts_audio_cache(id) on delete cascade,
  lease_owner text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create extension if not exists pg_trgm;

do $$
begin
  if not exists (select 1 from paragraph_search limit 1) then
    insert into paragraph_search (
      id, paragraph_id, book_id, chapter_id, page_index, paragraph_index, text, text_lower, paragraph, updated_at
    )
    select
      pp.id || ':' || case
        when (paragraph->>'index') ~ '^[0-9]+$' then paragraph->>'index'
        else pp.start_paragraph_index::text
      end,
      paragraph->>'id',
      pp.book_id,
      pp.chapter_id,
      pp.page_index,
      case
        when (paragraph->>'index') ~ '^[0-9]+$' then (paragraph->>'index')::integer
        else pp.start_paragraph_index
      end,
      coalesce(paragraph->>'text', ''),
      lower(coalesce(paragraph->>'text', '')),
      paragraph,
      now()
    from paragraph_pages pp
    cross join lateral jsonb_array_elements(pp.paragraphs) paragraph
    where paragraph->>'id' is not null
    on conflict (id) do nothing;
  end if;
end $$;

create index if not exists idx_library_books_user_updated on library_books(user_id, updated_at desc);
create index if not exists idx_chapters_book_index on chapters(book_id, chapter_index);
create index if not exists idx_paragraph_pages_chapter_page on paragraph_pages(chapter_id, page_index);
create index if not exists idx_paragraph_pages_book_chapter_page on paragraph_pages(book_id, chapter_id, page_index);
create index if not exists idx_paragraph_search_paragraph_id on paragraph_search(paragraph_id);
create index if not exists idx_paragraph_search_book_order on paragraph_search(book_id, chapter_id, paragraph_index);
create index if not exists idx_paragraph_search_chapter_order on paragraph_search(chapter_id, paragraph_index);
create index if not exists idx_bookmarks_active_book_created on bookmarks(book_id, user_id, created_at desc) where deleted_at is null;
create index if not exists idx_highlights_active_book_updated on highlights(book_id, user_id, updated_at desc) where deleted_at is null;
create index if not exists idx_notes_active_book_updated on notes(book_id, user_id, updated_at desc) where deleted_at is null;
create index if not exists idx_sync_events_user_sequence on sync_events(user_id, sequence);
create index if not exists idx_sync_events_conflict_lookup
  on sync_events(user_id, book_id, type, entity_id, sequence desc);
create index if not exists idx_import_jobs_user_created on import_jobs(user_id, created_at desc);
create index if not exists idx_characters_book on characters(book_id, canonical_name);
create index if not exists idx_character_aliases_book_alias on character_aliases(book_id, alias);
create index if not exists idx_character_relations_book_source on character_relations(book_id, source_character_id);
create index if not exists idx_analysis_runs_book_created on analysis_runs(book_id, created_at desc);
create index if not exists idx_chapter_contexts_book_chapter on chapter_contexts(book_id, chapter_id);
create index if not exists idx_voice_profiles_book_role on voice_profiles(book_id, role);
create index if not exists idx_labeled_segments_chapter_order on labeled_segments(chapter_id, segment_index);
create index if not exists idx_labeled_segments_book_speaker on labeled_segments(book_id, speaker_id);
create index if not exists idx_user_corrections_book_created on user_corrections(book_id, created_at desc);
create index if not exists idx_provider_settings_user_scope on provider_settings(user_id, scope);
create index if not exists idx_provider_secrets_user_scope on provider_secrets(user_id, scope);
create index if not exists idx_book_ai_workflows_book_status on book_ai_workflows(book_id, status, created_at desc);
create unique index if not exists idx_book_ai_workflows_active_plan
  on book_ai_workflows(user_id, book_id, workflow_type, provider_id, coalesce(model_id, ''), plan_hash)
  where status = 'running';
create index if not exists idx_book_ai_workflow_jobs_workflow_stage on book_ai_workflow_jobs(workflow_id, stage, sequence);
create index if not exists idx_provider_jobs_book_status on provider_jobs(book_id, status, created_at desc);
create index if not exists idx_tts_audio_cache_book_chapter on tts_audio_cache(book_id, chapter_id);

-- Phase 0C ID/hash v2 expand schema. Keep this consolidated review snapshot
-- aligned with db/migrations/0004_id_hash_v2_expand.sql.
-- Phase 0C expand migration. Long-running identity backfills are deliberately
-- executed by the id-v2 migration command, never by schema startup.

create table if not exists identity_contract_metadata (
  contract_name text primary key,
  id_contract text not null,
  hash_contract text not null,
  compatibility_release text not null,
  activated_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into identity_contract_metadata (
  contract_name, id_contract, hash_contract, compatibility_release
) values (
  'persistent_identity', 'v2-sha256-128', 'v2-sha256-tagged', 'id-v2-compat-1'
)
on conflict (contract_name) do update
set id_contract = excluded.id_contract,
    hash_contract = excluded.hash_contract,
    compatibility_release = excluded.compatibility_release,
    updated_at = now();

create table if not exists id_v2_migration_runs (
  id text primary key,
  migration_kind text not null check (migration_kind in ('book', 'global_provider')),
  user_id text not null references users(id) on delete cascade,
  source_book_id text,
  canonical_book_id text,
  status text not null check (
    status in ('pending', 'running', 'deferred', 'staged', 'activated', 'quarantined', 'failed', 'rolled_back')
  ),
  generation integer not null default 1 check (generation > 0),
  source_fingerprint jsonb not null default '{}'::jsonb,
  report jsonb not null default '{}'::jsonb,
  error_code text,
  started_at timestamptz,
  activated_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (migration_kind = 'book' and source_book_id is not null)
    or (migration_kind = 'global_provider' and source_book_id is null)
  )
);

create unique index if not exists idx_id_v2_runs_active_book
  on id_v2_migration_runs(user_id, source_book_id)
  where migration_kind = 'book' and status in ('pending', 'running', 'deferred', 'staged');

create unique index if not exists idx_id_v2_runs_active_global
  on id_v2_migration_runs(user_id, migration_kind)
  where migration_kind = 'global_provider' and status in ('pending', 'running', 'deferred', 'staged');

create index if not exists idx_id_v2_runs_status_updated
  on id_v2_migration_runs(status, updated_at);

create table if not exists id_v2_migration_checkpoints (
  run_id text not null references id_v2_migration_runs(id) on delete cascade,
  stage text not null,
  cursor jsonb not null default '{}'::jsonb,
  completed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (run_id, stage)
);

create table if not exists id_v2_migration_quarantine (
  id bigserial primary key,
  run_id text not null references id_v2_migration_runs(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  source_book_id text,
  entity_type text not null,
  source_id text,
  reason_code text not null,
  safe_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_id_v2_quarantine_run
  on id_v2_migration_quarantine(run_id, id);

create table if not exists id_v2_migration_backups (
  run_id text not null references id_v2_migration_runs(id) on delete cascade,
  table_name text not null,
  source_key text not null,
  restore_order integer not null,
  row_data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, table_name, source_key)
);

create index if not exists idx_id_v2_backups_restore
  on id_v2_migration_backups(run_id, restore_order, table_name, source_key);

create table if not exists id_v2_book_aliases (
  user_id text not null references users(id) on delete cascade,
  source_book_id text not null,
  canonical_book_id text not null,
  source_file_name text not null,
  source_normalized_text_hash text not null,
  canonical_normalized_text_hash text not null,
  source_object_id text,
  canonical_object_id text,
  run_id text not null references id_v2_migration_runs(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'quarantined', 'rolled_back')),
  alias_complete boolean not null default false,
  retain_until_release text not null default 'id-v2-compat-1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, source_book_id)
);

create index if not exists idx_id_v2_book_aliases_canonical
  on id_v2_book_aliases(user_id, canonical_book_id);

create unique index if not exists idx_id_v2_book_aliases_identity
  on id_v2_book_aliases(user_id, source_file_name, canonical_normalized_text_hash)
  where status = 'active' and alias_complete;

create table if not exists id_v2_entity_aliases (
  user_id text not null references users(id) on delete cascade,
  source_book_id text not null,
  canonical_book_id text not null,
  entity_type text not null,
  source_id text not null,
  canonical_id text not null,
  run_id text not null references id_v2_migration_runs(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'quarantined', 'rolled_back')),
  alias_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, source_book_id, entity_type, source_id)
);

create unique index if not exists idx_id_v2_entity_aliases_reverse
  on id_v2_entity_aliases(user_id, source_book_id, entity_type, canonical_id)
  where status = 'active' and alias_complete;

create index if not exists idx_id_v2_entity_aliases_canonical_book
  on id_v2_entity_aliases(user_id, canonical_book_id, entity_type, canonical_id);

create table if not exists id_v2_global_aliases (
  user_id text not null references users(id) on delete cascade,
  entity_type text not null,
  source_id text not null,
  canonical_id text not null,
  run_id text not null references id_v2_migration_runs(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'quarantined', 'rolled_back')),
  alias_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entity_type, source_id)
);

create unique index if not exists idx_id_v2_global_aliases_reverse
  on id_v2_global_aliases(user_id, entity_type, canonical_id)
  where status = 'active' and alias_complete;

create table if not exists id_v2_tts_cache_quarantine (
  run_id text not null references id_v2_migration_runs(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  source_book_id text not null,
  canonical_book_id text not null,
  cache_id text not null,
  reason_code text not null default 'mixed_identity_contract',
  row_data jsonb not null,
  quarantined_at timestamptz not null default now(),
  restored_at timestamptz,
  primary key (run_id, cache_id)
);

create index if not exists idx_id_v2_tts_cache_quarantine_book
  on id_v2_tts_cache_quarantine(user_id, canonical_book_id, quarantined_at);

alter table library_books add column if not exists id_contract text;
alter table library_books add column if not exists hash_contract text;
alter table library_books add column if not exists identity_migration_run_id text;

update library_books
set id_contract = case
      when id ~ '^[a-z][a-z0-9_]*_[0-9a-f]{32}$' then 'v2-sha256-128'
      else 'v1-legacy'
    end,
    hash_contract = case
      when normalized_text_hash ~ '^sha256:[0-9a-f]{64}$' then 'v2-sha256-tagged'
      else 'v1-legacy'
    end
where id_contract is null or hash_contract is null;

alter table library_books alter column id_contract set default 'v2-sha256-128';
alter table library_books alter column hash_contract set default 'v2-sha256-tagged';
alter table library_books alter column id_contract set not null;
alter table library_books alter column hash_contract set not null;

create index if not exists idx_library_books_identity_contract
  on library_books(user_id, id_contract, hash_contract);

create index if not exists idx_library_books_source_identity
  on library_books(user_id, source_file_name, normalized_text_hash);

alter table book_objects add column if not exists id_contract text;
alter table book_objects add column if not exists hash_contract text;

update book_objects
set id_contract = case
      when id ~ '^[a-z][a-z0-9_]*_[0-9a-f]{32}$' then 'v2-sha256-128'
      else 'v1-legacy'
    end,
    hash_contract = case
      when raw_text_hash ~ '^sha256:[0-9a-f]{64}$' then 'v2-sha256-tagged'
      else 'v1-legacy'
    end
where id_contract is null or hash_contract is null;

alter table book_objects alter column id_contract set default 'v2-sha256-128';
alter table book_objects alter column hash_contract set default 'v2-sha256-tagged';
alter table book_objects alter column id_contract set not null;
alter table book_objects alter column hash_contract set not null;

-- Object IDs are global by raw content hash. ON UPDATE CASCADE lets a per-book
-- migration canonicalize a shared legacy object without breaking sibling books.
alter table library_books drop constraint if exists library_books_object_id_fkey;
alter table library_books
  add constraint library_books_object_id_fkey
  foreign key (object_id) references book_objects(id) on update cascade on delete set null;

alter table provider_settings add column if not exists id_contract text;
update provider_settings
set id_contract = case
  when id ~ '^[a-z][a-z0-9_]*_[0-9a-f]{32}$' then 'v2-sha256-128'
  else 'v1-legacy'
end
where id_contract is null;
alter table provider_settings alter column id_contract set default 'v2-sha256-128';
alter table provider_settings alter column id_contract set not null;

alter table provider_secrets add column if not exists id_contract text;
update provider_secrets
set id_contract = case
  when id ~ '^[a-z][a-z0-9_]*_[0-9a-f]{32}$' then 'v2-sha256-128'
  else 'v1-legacy'
end
where id_contract is null;
alter table provider_secrets alter column id_contract set default 'v2-sha256-128';
alter table provider_secrets alter column id_contract set not null;

alter table sync_events add column if not exists id_contract text;
alter table sync_events add column if not exists hash_contract text;
update sync_events
set id_contract = case
      when id ~ '^[a-z][a-z0-9_]*_[0-9a-f]{32}$' then 'v2-sha256-128'
      else 'v1-legacy'
    end,
    hash_contract = case
      when coalesce(revision->>'payloadHash', '') ~ '^sha256:[0-9a-f]{64}$' then 'v2-sha256-tagged'
      else 'v1-legacy'
    end
where id_contract is null or hash_contract is null;
alter table sync_events alter column id_contract set default 'v2-sha256-128';
alter table sync_events alter column hash_contract set default 'v2-sha256-tagged';
alter table sync_events alter column id_contract set not null;
alter table sync_events alter column hash_contract set not null;

comment on table id_v2_migration_runs is
  'Resumable Phase 0C backfill state. Schema migration 0004 never performs the long-running data rewrite.';
comment on table id_v2_migration_backups is
  'One compatibility-release rollback material. Removal requires a later explicit contract migration.';
comment on table id_v2_entity_aliases is
  'Book-scoped v1-to-v2 aliases for strict later sync translation; unmapped child IDs are never implied.';

-- Versioned sync transport source correlation (migration 0005).
alter table sync_events add column if not exists source_contract_version smallint;
alter table sync_events add column if not exists source_event_id text;

update sync_events
set source_contract_version = case
      when id_contract = 'v2-sha256-128' and hash_contract = 'v2-sha256-tagged' then 2
      else 1
    end,
    source_event_id = case
      when id_contract = 'v2-sha256-128' and hash_contract = 'v2-sha256-tagged' then source_event_id
      else coalesce(source_event_id, id)
    end
where source_contract_version is null;

alter table sync_events alter column source_contract_version set default 2;
alter table sync_events alter column source_contract_version set not null;

create unique index if not exists idx_sync_events_source_identity
  on sync_events(user_id, source_contract_version, source_event_id)
  where source_event_id is not null;

comment on column sync_events.source_event_id is
  'Caller event ID retained when a v1 transport event is canonicalized to a different v2 sync_events.id.';

-- Single-owner self-host login. This attaches credentials to the existing
-- DEFAULT_USER_ID instead of creating a second library owner.
create table if not exists self_host_accounts (
  singleton_key smallint primary key default 1 check (singleton_key = 1),
  user_id text not null unique references users(id) on delete cascade,
  username text not null,
  normalized_username text not null unique,
  display_name text not null,
  password_scheme text not null check (password_scheme = 'scrypt-v1'),
  password_salt text not null,
  password_digest text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists self_host_sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists self_host_sessions_user_expiry_idx
  on self_host_sessions (user_id, expires_at desc);
create index if not exists self_host_sessions_expiry_idx
  on self_host_sessions (expires_at);
