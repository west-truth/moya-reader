create table if not exists voice_catalog_snapshots (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  provider_id text not null,
  model_id text,
  fingerprint text not null,
  payload jsonb not null,
  captured_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_voice_catalog_snapshots_identity
  on voice_catalog_snapshots(user_id, book_id, provider_id, coalesce(model_id, ''), fingerprint);

create index if not exists idx_voice_catalog_snapshots_book_provider
  on voice_catalog_snapshots(user_id, book_id, provider_id, captured_at desc);

create table if not exists voice_catalog_entries (
  id text not null,
  snapshot_id text not null references voice_catalog_snapshots(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  provider_id text not null,
  voice_id text not null,
  fingerprint text not null,
  available boolean not null,
  payload jsonb not null,
  primary key (snapshot_id, id)
);

create index if not exists idx_voice_catalog_entries_selected
  on voice_catalog_entries(book_id, provider_id, voice_id, fingerprint);

create table if not exists voice_suggestions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  voice_profile_id text not null,
  character_id text,
  major boolean not null default false,
  payload jsonb not null,
  created_at timestamptz not null
);

create index if not exists idx_voice_suggestions_book
  on voice_suggestions(user_id, book_id, major desc, created_at desc);

create table if not exists voice_sample_requests (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  voice_profile_id text not null,
  kind text not null check (kind in ('neutral', 'in_context')),
  payload jsonb not null,
  created_at timestamptz not null
);

create index if not exists idx_voice_sample_requests_profile
  on voice_sample_requests(user_id, book_id, voice_profile_id, created_at desc);

create table if not exists voice_sample_approvals (
  approval_id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  voice_profile_id text not null,
  decision text not null check (decision in ('approved', 'rejected')),
  stale_reason text,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  unique (user_id, book_id, voice_profile_id)
);

create index if not exists idx_voice_sample_approvals_book
  on voice_sample_approvals(user_id, book_id, decision, stale_reason);

create table if not exists pronunciation_profiles (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  revision integer not null check (revision >= 0),
  revision_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null,
  unique (user_id, book_id)
);

create table if not exists voice_product_preferences (
  book_id text primary key references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  minor_fallback_enabled boolean not null default false,
  major_character_limit integer not null default 5 check (major_character_limit between 1 and 50),
  updated_at timestamptz not null default now()
);
