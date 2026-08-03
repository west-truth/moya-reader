alter table book_assets add column if not exists content_revision_id text;

drop index if exists idx_book_assets_active_kind;
create unique index if not exists idx_book_assets_active_cover
  on book_assets(book_id) where status = 'active' and kind = 'cover';
create index if not exists idx_book_assets_active_resources
  on book_assets(book_id, kind, status);
create index if not exists idx_book_assets_content_revision
  on book_assets(content_revision_id) where content_revision_id is not null;
