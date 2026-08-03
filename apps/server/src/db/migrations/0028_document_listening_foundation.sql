create table if not exists listening_positions (
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  chapter_id text not null,
  anchor jsonb not null,
  queue_item_fingerprint text not null,
  content_revision_id text not null,
  settings_fingerprint text not null,
  device_id text,
  updated_at timestamptz not null default now(),
  primary key (book_id, user_id)
);

create table if not exists document_pages (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  page_index integer not null check (page_index >= 0),
  page_id text not null,
  page_hash text not null,
  source_kind text not null check (source_kind in ('pdf_page', 'archive_image')),
  width numeric,
  height numeric,
  rotation integer,
  asset_id text,
  archive_path text,
  thumbnail_asset_id text,
  updated_at timestamptz not null default now(),
  unique (book_id, page_index)
);

create table if not exists document_text_revisions (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  page_index integer not null check (page_index >= 0),
  page_hash text not null,
  source text not null check (source in ('pdf_native', 'ocr')),
  engine text not null,
  engine_version text not null,
  language text,
  status text not null check (status in ('pending', 'ready', 'failed', 'stale')),
  quality_score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_document_text_revisions_book_page
  on document_text_revisions(book_id, page_index);

create table if not exists document_text_blocks (
  id text primary key,
  revision_id text not null references document_text_revisions(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  page_index integer not null check (page_index >= 0),
  block_order integer not null check (block_order >= 0),
  role text not null,
  text text not null,
  normalized_text text not null,
  quads jsonb not null default '[]'::jsonb,
  direction text not null check (direction in ('ltr', 'rtl', 'ttb')),
  unique (revision_id, block_order)
);

create table if not exists document_annotations (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  page_index integer not null check (page_index >= 0),
  annotation_type text not null,
  anchor jsonb not null,
  body text,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_document_annotations_book_page
  on document_annotations(book_id, user_id, page_index);

create table if not exists comic_reading_profiles (
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  profile jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (book_id, user_id)
);

create table if not exists spoken_text_rules (
  id text primary key,
  book_id text references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  rule jsonb not null,
  updated_at timestamptz not null default now()
);
