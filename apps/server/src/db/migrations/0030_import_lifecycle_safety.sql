alter table upload_sessions add column if not exists source_content_hash text;

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
