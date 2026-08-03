-- Phase 0C expand migration. Long-running identity backfills are deliberately
-- executed by the id-v2 migration command, never by schema startup.

create table if not exists identity_contract_metadata (
  contract_name text primary key,
  id_contract text not null,
  hash_contract text not null,
  compatibility_release text not null,
  status text not null default 'expanded' check (status in ('expanded', 'active')),
  activated_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table identity_contract_metadata add column if not exists status text;
alter table identity_contract_metadata alter column activated_at drop not null;
update identity_contract_metadata
set status = coalesce(status, 'expanded'),
    activated_at = case when status = 'active' then activated_at else null end;
alter table identity_contract_metadata alter column status set default 'expanded';
alter table identity_contract_metadata alter column status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'identity_contract_metadata_status_check'
      and conrelid = 'identity_contract_metadata'::regclass
  ) then
    alter table identity_contract_metadata
      add constraint identity_contract_metadata_status_check
      check (status in ('expanded', 'active'));
  end if;
end $$;

insert into identity_contract_metadata (
  contract_name, id_contract, hash_contract, compatibility_release, status, activated_at
) values (
  'persistent_identity', 'v2-sha256-128', 'v2-sha256-tagged', 'id-v2-compat-1', 'expanded', null
)
on conflict (contract_name) do update
set id_contract = excluded.id_contract,
    hash_contract = excluded.hash_contract,
    compatibility_release = excluded.compatibility_release,
    status = case
      when identity_contract_metadata.status = 'active' then 'active'
      else 'expanded'
    end,
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
  'Book and provider/global-sync rollback material for one compatibility release. Removal requires a later explicit contract migration.';
comment on table id_v2_entity_aliases is
  'Book-scoped v1-to-v2 aliases for strict later sync translation; unmapped child IDs are never implied.';
