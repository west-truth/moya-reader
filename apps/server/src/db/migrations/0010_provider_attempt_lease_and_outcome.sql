alter table provider_job_attempts
  add column if not exists attempt_generation integer not null default 0
    check (attempt_generation >= 0),
  add column if not exists lease_owner text,
  add column if not exists lease_token_hash text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists dispatch_started_at timestamptz,
  add column if not exists provider_request_id text,
  add column if not exists provider_idempotency_key_hash text,
  add column if not exists outcome_state text not null default 'not_dispatched'
    check (outcome_state in (
      'not_dispatched', 'claimed', 'dispatching', 'in_flight', 'reconciling',
      'succeeded', 'failed', 'cancelled', 'outcome_unknown', 'quarantined'
    )),
  add column if not exists billing_state text not null default 'not_started'
    check (billing_state in ('not_started', 'not_billable', 'estimated', 'billed_possible', 'confirmed')),
  add column if not exists reconcile_after timestamptz,
  add column if not exists normalized_completion_code text,
  add column if not exists normalized_error_code text,
  add column if not exists estimated_input_units bigint
    check (estimated_input_units is null or estimated_input_units >= 0),
  add column if not exists actual_input_units bigint
    check (actual_input_units is null or actual_input_units >= 0),
  add column if not exists estimated_cost_minor_units bigint
    check (estimated_cost_minor_units is null or estimated_cost_minor_units >= 0),
  add column if not exists actual_cost_minor_units bigint
    check (actual_cost_minor_units is null or actual_cost_minor_units >= 0);

update provider_job_attempts
set outcome_state = 'outcome_unknown',
    billing_state = 'billed_possible',
    normalized_error_code = 'lease_migration_running_outcome_unknown',
    reconcile_after = now()
where status = 'running' and outcome_state = 'not_dispatched';

create index if not exists idx_provider_attempt_expired_lease
  on provider_job_attempts(lease_expires_at, id)
  where status = 'running';

create index if not exists idx_provider_attempt_outcome_reconcile
  on provider_job_attempts(reconcile_after, id)
  where outcome_state in ('reconciling', 'outcome_unknown');
