alter table analysis_review_artifacts
  add column if not exists generated_candidate jsonb,
  add column if not exists generated_candidate_hash text,
  add column if not exists edit_intents jsonb not null default '{}'::jsonb;

update analysis_review_artifacts review
set generated_candidate = staging.payload,
    generated_candidate_hash = staging.output_hash
from analysis_staging_artifacts staging
where staging.id = review.staging_artifact_id
  and (review.generated_candidate is null or review.generated_candidate_hash is null);

update analysis_review_artifacts
set generated_candidate = normalized_candidate,
    generated_candidate_hash = candidate_hash
where generated_candidate is null or generated_candidate_hash is null;

alter table analysis_review_artifacts
  alter column generated_candidate set not null,
  alter column generated_candidate_hash set not null;
