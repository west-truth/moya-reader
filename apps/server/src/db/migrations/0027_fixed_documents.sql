alter table library_books drop constraint if exists library_books_format_check;
alter table library_books add constraint library_books_format_check
  check (format in ('txt', 'markdown', 'epub', 'pdf', 'image_archive'));

alter table book_assets drop constraint if exists book_assets_kind_check;
alter table book_assets add constraint book_assets_kind_check
  check (kind in ('cover', 'epub_resource', 'document_page', 'user_font'));

alter table book_assets add column if not exists page_index integer;
alter table book_assets add constraint book_assets_page_index_check
  check (page_index is null or page_index >= 0);

create index if not exists idx_book_assets_active_document_pages
  on book_assets(book_id, page_index)
  where status = 'active' and kind = 'document_page';
