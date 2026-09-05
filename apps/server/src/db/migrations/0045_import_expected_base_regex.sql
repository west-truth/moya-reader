-- Preserve the 0044 checksum for installations that already applied it.
-- PostgreSQL rejects the {1,512} repetition bound when a revision is checked.
alter table upload_sessions drop constraint upload_sessions_expected_base_check;

alter table upload_sessions add constraint upload_sessions_expected_base_check check (
  expected_base is null or coalesce((
    import_mode = 'replace_book' and client_book_id is not null and
    jsonb_typeof(expected_base) = 'object' and (
      expected_base = '{"kind":"absent"}'::jsonb or (
        expected_base->>'kind' = 'revision' and
        jsonb_typeof(expected_base->'contentRevisionId') = 'string' and
        length(expected_base->>'contentRevisionId') between 1 and 512 and
        expected_base->>'contentRevisionId' ~ '^[A-Za-z0-9:_-]+$' and
        expected_base - 'kind' - 'contentRevisionId' = '{}'::jsonb
      )
    )
  ), false)
);
