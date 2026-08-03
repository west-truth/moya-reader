alter table labeled_segments
  add column if not exists prosody_intent jsonb,
  add column if not exists mutation_operation_id text;

alter table user_corrections
  add column if not exists operation_id text,
  add column if not exists intent_kind text
    check (intent_kind is null or intent_kind in ('segment_only', 'relabel_from_window', 'reference_mapping')),
  add column if not exists intent_json jsonb,
  add column if not exists provenance_kind text not null default 'legacy'
    check (provenance_kind in ('legacy', 'user_label_mutation', 'review_approved_generated')),
  add column if not exists source_review_artifact_id text
    references analysis_review_artifacts(id) on delete set null;

create table if not exists label_mutation_operations (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  source_review_artifact_id text references analysis_review_artifacts(id) on delete set null,
  command_hash text not null,
  command_json jsonb not null,
  expected_fences jsonb not null,
  result_json jsonb not null,
  applied_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_label_mutation_operations_book
  on label_mutation_operations(user_id, book_id, applied_at desc);

create table if not exists label_mutation_invalidations (
  operation_id text primary key references label_mutation_operations(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  context_from_window_id text,
  obsolete_review_artifact_ids jsonb not null default '[]'::jsonb,
  stale_tts_render_item_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists label_reanalysis_plans (
  id text primary key,
  operation_id text not null references label_mutation_operations(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  from_window_id text,
  intent_json jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'queued', 'running', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_label_reanalysis_plans_pending
  on label_reanalysis_plans(user_id, book_id, status, created_at);

create unique index if not exists idx_user_corrections_operation_field
  on user_corrections(operation_id, segment_id, correction_type)
  where operation_id is not null;
