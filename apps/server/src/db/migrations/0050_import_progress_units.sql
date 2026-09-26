alter table import_jobs
  add column if not exists progress_completed bigint,
  add column if not exists progress_total bigint,
  add column if not exists progress_unit text;
