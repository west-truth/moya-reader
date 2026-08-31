-- Additive asset kind only. Existing books and source objects are not converted by a migration.
alter table book_assets drop constraint if exists book_assets_kind_check;
alter table book_assets add constraint book_assets_kind_check
  check (kind in ('cover', 'epub_resource', 'document_page', 'source_part', 'user_font'));
