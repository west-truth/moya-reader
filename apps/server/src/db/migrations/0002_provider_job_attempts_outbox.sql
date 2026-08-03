alter table provider_jobs add column if not exists current_attempt_id text;
alter table provider_jobs add column if not exists attempt_count integer not null default 0;

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
  'Secondary invariant guard. Application writes must use status and current_attempt_id CAS predicates and check affected rows.';

drop trigger if exists provider_jobs_status_transition_guard on provider_jobs;
create trigger provider_jobs_status_transition_guard
before update of status on provider_jobs
for each row
execute function guard_provider_job_status_transition();
