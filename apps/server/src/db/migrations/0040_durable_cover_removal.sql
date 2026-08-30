alter table library_books
  add column if not exists cover_removed_at timestamptz;
