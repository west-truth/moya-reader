alter table library_books add column if not exists metadata_revision bigint not null default 0;
alter table library_books add column if not exists deleted_at timestamptz;
alter table library_books add column if not exists deleted_by_device_id text;

create index if not exists idx_library_books_active_catalog
  on library_books(user_id, updated_at desc)
  where deleted_at is null;

create index if not exists idx_library_books_trash_catalog
  on library_books(user_id, deleted_at desc)
  where deleted_at is not null;
