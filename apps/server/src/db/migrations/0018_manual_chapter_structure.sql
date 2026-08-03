create table if not exists chapter_structure_drafts (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  base_content_revision_id text not null references book_content_revisions(id) on delete cascade,
  commands jsonb not null,
  preview jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_chapter_structure_drafts_book
  on chapter_structure_drafts(user_id, book_id, created_at desc);

create table if not exists chapter_structure_receipts (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  draft_id text not null,
  previous_content_revision_id text not null references book_content_revisions(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  commands jsonb not null,
  previous_snapshot jsonb not null,
  next_snapshot jsonb not null,
  status text not null check (status in ('active', 'rolled_back')),
  created_at timestamptz not null default now(),
  rolled_back_at timestamptz,
  rollback_content_revision_id text references book_content_revisions(id) on delete set null
);

create index if not exists idx_chapter_structure_receipts_book
  on chapter_structure_receipts(user_id, book_id, created_at desc);

create table if not exists chapter_structure_review_items (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  receipt_id text not null references chapter_structure_receipts(id) on delete cascade,
  item_kind text not null,
  entity_type text not null,
  entity_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_chapter_structure_review_book
  on chapter_structure_review_items(book_id, created_at desc);
