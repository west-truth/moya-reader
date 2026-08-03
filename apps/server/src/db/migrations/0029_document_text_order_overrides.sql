create table if not exists document_text_order_overrides (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  page_index integer not null check (page_index >= 0),
  page_hash text not null,
  source_revision_id text not null,
  ordered_block_fingerprints jsonb not null default '[]'::jsonb,
  excluded_block_fingerprints jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (book_id, user_id, page_index)
);

create index if not exists idx_document_text_order_overrides_book_page
  on document_text_order_overrides(book_id, user_id, page_index);
