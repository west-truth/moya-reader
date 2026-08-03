alter table analysis_review_artifacts
  add column if not exists promoted_artifact_id text
    references analysis_staging_artifacts(id) on delete set null,
  add column if not exists promoted_at timestamptz;
