create table if not exists analysis_review_artifacts (
  id text primary key,
  workflow_id text not null references book_ai_workflows(id) on delete cascade,
  provider_job_id text not null references provider_jobs(id) on delete cascade,
  attempt_id text references provider_job_attempts(id) on delete set null,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null,
  input_revision_id text not null references analysis_input_revisions(id) on delete cascade,
  staging_artifact_id text not null unique references analysis_staging_artifacts(id) on delete cascade,
  review_kind text not null check (review_kind in ('chapter_labeling')),
  window_id text not null,
  normalized_candidate jsonb not null,
  candidate_hash text not null,
  validation_issues jsonb not null default '[]'::jsonb,
  quality_issues jsonb not null default '[]'::jsonb,
  validation_summary jsonb not null default '{}'::jsonb,
  quality_summary jsonb not null default '{}'::jsonb,
  provider_execution_metadata jsonb,
  raw_response_object_key text,
  raw_response_expires_at timestamptz,
  status text not null default 'open'
    check (status in ('open', 'editing', 'validating', 'approved', 'rejected', 'obsolete', 'promoting', 'promoted')),
  review_revision bigint not null default 1 check (review_revision > 0),
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  revision_fence bigint not null,
  graph_revision_id text references character_graph_revisions(id) on delete set null,
  graph_fingerprint text not null,
  correction_fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists idx_analysis_review_artifacts_workflow
  on analysis_review_artifacts(workflow_id, status, created_at);

create index if not exists idx_analysis_review_artifacts_open
  on analysis_review_artifacts(user_id, book_id, updated_at desc)
  where status in ('open', 'editing', 'validating', 'approved', 'promoting');

create table if not exists analysis_review_decisions (
  id text primary key,
  review_artifact_id text not null references analysis_review_artifacts(id) on delete cascade,
  expected_review_revision bigint not null check (expected_review_revision > 0),
  resulting_review_revision bigint not null check (resulting_review_revision > expected_review_revision),
  action text not null check (action in ('save_draft', 'approve', 'reject', 'request_repair')),
  patch jsonb,
  actor_type text not null default 'user' check (actor_type in ('user', 'system')),
  actor_id text not null,
  decision_provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (review_artifact_id, resulting_review_revision)
);

create index if not exists idx_analysis_review_decisions_artifact
  on analysis_review_decisions(review_artifact_id, created_at);
