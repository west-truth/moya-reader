alter table upload_sessions
  add column if not exists import_mode text not null default 'replace_book';

alter table upload_sessions
  add column if not exists base_active_content_revision_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'upload_sessions_import_mode_check'
  ) then
    alter table upload_sessions
      add constraint upload_sessions_import_mode_check
      check (import_mode in ('replace_book', 'append_image_series'));
  end if;
end $$;
