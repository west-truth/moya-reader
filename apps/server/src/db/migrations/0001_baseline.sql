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
  cover_seed integer not null default 0,
  favorite boolean not null default false,
  analysis_status text not null default 'not_analyzed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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
  client_book_id text,
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

create unique index if not exists idx_provider_jobs_unique_input_v2
  on provider_jobs(user_id, book_id, coalesce(chapter_id, ''), job_type, provider_id, coalesce(model_id, ''), input_hash);

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
create index if not exists idx_paragraph_search_paragraph_id on paragraph_search(paragraph_id);
create index if not exists idx_paragraph_search_book_order on paragraph_search(book_id, chapter_id, paragraph_index);
create index if not exists idx_paragraph_search_chapter_order on paragraph_search(chapter_id, paragraph_index);
create index if not exists idx_paragraph_search_text_trgm on paragraph_search using gin (text_lower gin_trgm_ops);
create index if not exists idx_bookmarks_active_book_created on bookmarks(book_id, user_id, created_at desc) where deleted_at is null;
create index if not exists idx_highlights_active_book_updated on highlights(book_id, user_id, updated_at desc) where deleted_at is null;
create index if not exists idx_notes_active_book_updated on notes(book_id, user_id, updated_at desc) where deleted_at is null;
create index if not exists idx_sync_events_user_sequence on sync_events(user_id, sequence);
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
