create table if not exists user_fonts (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  family_label text not null,
  file_name text not null,
  style text not null check (style in ('normal', 'italic')),
  weight integer not null check (weight between 100 and 900),
  content_hash text not null,
  content_type text not null,
  byte_length bigint not null check (byte_length between 1 and 10485760),
  storage_key text not null unique,
  license_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, content_hash)
);

create index if not exists idx_user_fonts_user_updated on user_fonts(user_id, updated_at desc);

create table if not exists reading_session_events (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  device_id text not null,
  mode text not null check (mode in ('reading', 'listening')),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  active_seconds integer not null check (active_seconds between 1 and 86400),
  start_anchor jsonb,
  end_anchor jsonb,
  characters_advanced integer check (characters_advanced >= 0),
  operation_id text not null,
  created_at timestamptz not null default now(),
  unique (user_id, operation_id),
  check (ended_at >= started_at)
);

create index if not exists idx_reading_sessions_book_end
  on reading_session_events(user_id, book_id, ended_at desc);
create index if not exists idx_reading_sessions_user_end
  on reading_session_events(user_id, ended_at desc);
