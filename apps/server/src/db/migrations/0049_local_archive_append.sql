alter table upload_sessions drop constraint upload_sessions_import_mode_check;
alter table upload_sessions add constraint upload_sessions_import_mode_check
  check (import_mode in ('replace_book', 'append_image_series', 'append_local_archive'));
