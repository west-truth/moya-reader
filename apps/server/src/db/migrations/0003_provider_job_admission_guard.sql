create index if not exists idx_provider_job_attempts_job_created
  on provider_job_attempts(provider_job_id, created_at desc);

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
