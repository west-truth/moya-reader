alter table library_books add column if not exists author text;
alter table library_books add column if not exists format text not null default 'txt'
  check (format in ('txt', 'markdown', 'epub'));
alter table library_books add column if not exists series_title text;
alter table library_books add column if not exists series_index numeric;
alter table library_books add column if not exists tags jsonb not null default '[]'::jsonb;
alter table library_books add column if not exists description text;
alter table library_books add column if not exists language text;
alter table library_books add column if not exists cover_fit text not null default 'crop'
  check (cover_fit in ('crop', 'contain'));
alter table library_books add column if not exists cover_position_x numeric not null default 50
  check (cover_position_x between 0 and 100);
alter table library_books add column if not exists cover_position_y numeric not null default 50
  check (cover_position_y between 0 and 100);

create table if not exists book_assets (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  kind text not null check (kind in ('cover', 'epub_resource', 'user_font')),
  provenance text not null,
  status text not null check (status in ('staged', 'active', 'superseded')),
  storage_key text not null,
  file_name text,
  content_type text not null,
  byte_length bigint not null check (byte_length >= 0),
  content_hash text not null,
  pixel_width integer,
  pixel_height integer,
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

create unique index if not exists idx_book_assets_active_kind
  on book_assets(book_id, kind) where status = 'active';
create index if not exists idx_book_assets_content_hash on book_assets(user_id, content_hash);

alter table library_books add column if not exists cover_asset_id text references book_assets(id) on delete set null;

create table if not exists shelves (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  color text,
  sort_order integer not null default 0,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_shelves_user_name on shelves(user_id, lower(name));
create index if not exists idx_shelves_user_order on shelves(user_id, sort_order, name);

create table if not exists shelf_memberships (
  id text primary key,
  shelf_id text not null references shelves(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (shelf_id, book_id)
);

create index if not exists idx_shelf_memberships_book on shelf_memberships(user_id, book_id);

create table if not exists library_operation_receipts (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  idempotency_key text not null,
  command jsonb not null,
  results jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
