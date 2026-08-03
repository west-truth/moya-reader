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

create index if not exists idx_provider_capability_snapshots_lookup
  on provider_capability_snapshots(user_id, capability_kind, provider_id, requested_model_id, created_at desc);
create index if not exists idx_provider_capability_snapshots_expiry
  on provider_capability_snapshots(expires_at)
  where expires_at is not null;

create table if not exists provider_confidence_calibrations (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  provider_id text not null,
  requested_model_id text not null,
  resolved_model_version text,
  task_profile_id text not null,
  corpus_fingerprint text not null,
  fingerprint text not null,
  payload jsonb not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, fingerprint)
);

create unique index if not exists idx_provider_confidence_calibrations_active
  on provider_confidence_calibrations(
    user_id, provider_id, requested_model_id, coalesce(resolved_model_version, ''), task_profile_id
  )
  where is_active;

alter table analysis_input_revisions add column if not exists capability_snapshot_id text;
alter table analysis_input_revisions add column if not exists capability_snapshot jsonb;
alter table analysis_input_revisions add column if not exists task_profile_snapshot jsonb;
alter table analysis_input_revisions add column if not exists admission_snapshot jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'analysis_input_capability_snapshot_fk') then
    alter table analysis_input_revisions
      add constraint analysis_input_capability_snapshot_fk
      foreign key (capability_snapshot_id)
      references provider_capability_snapshots(id)
      on delete restrict;
  end if;
end $$;

alter table provider_jobs add column if not exists capability_snapshot_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'provider_jobs_capability_snapshot_fk') then
    alter table provider_jobs
      add constraint provider_jobs_capability_snapshot_fk
      foreign key (capability_snapshot_id)
      references provider_capability_snapshots(id)
      on delete restrict;
  end if;
end $$;

create index if not exists idx_analysis_input_revisions_capability
  on analysis_input_revisions(capability_snapshot_id);
create index if not exists idx_provider_jobs_capability
  on provider_jobs(capability_snapshot_id)
  where capability_snapshot_id is not null;
