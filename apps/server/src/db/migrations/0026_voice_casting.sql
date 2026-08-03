create table if not exists voice_casting_states (
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  version text not null check (version = 'voice-casting-v1'),
  revision integer not null check (revision > 0),
  state_payload jsonb not null check (jsonb_typeof(state_payload) = 'object'),
  user_authored_payload jsonb not null check (jsonb_typeof(user_authored_payload) = 'object'),
  derived_payload jsonb not null check (jsonb_typeof(derived_payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

create index if not exists idx_voice_casting_states_book_revision
  on voice_casting_states(user_id, book_id, revision);

create index if not exists idx_voice_casting_states_updated
  on voice_casting_states(user_id, updated_at desc);

comment on table voice_casting_states is
  'Authoritative voice-casting aggregate. Legacy voice-product replacement routes do not write this table.';
