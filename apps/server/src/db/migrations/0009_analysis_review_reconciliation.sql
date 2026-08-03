alter table analysis_review_artifacts
  add column if not exists promotion_attempt_count integer not null default 0
    check (promotion_attempt_count >= 0),
  add column if not exists promotion_last_error_code text,
  add column if not exists promotion_last_error_at timestamptz,
  add column if not exists next_reconcile_at timestamptz,
  add column if not exists reconcile_lease_owner text,
  add column if not exists reconcile_lease_expires_at timestamptz;

update analysis_review_artifacts
set next_reconcile_at = coalesce(next_reconcile_at, now())
where status in ('approved', 'promoting');

create index if not exists idx_analysis_review_reconcile_due
  on analysis_review_artifacts(next_reconcile_at, id)
  where status in ('approved', 'promoting', 'promoted')
    and next_reconcile_at is not null;
