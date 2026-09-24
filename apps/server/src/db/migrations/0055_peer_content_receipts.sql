create table if not exists sync_peer_content_receipts (
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  base_revision_id text not null,
  target_revision_id text not null,
  event_ids jsonb not null check (jsonb_typeof(event_ids) = 'array'),
  created_at timestamptz not null default now(),
  primary key (user_id, book_id, target_revision_id)
);

create table if not exists sync_peer_received_events (
  user_id text not null references users(id) on delete cascade,
  peer_id text not null,
  event_id text not null references sync_events(id) on delete cascade,
  received_at timestamptz not null default now(),
  primary key (user_id, peer_id, event_id)
);
