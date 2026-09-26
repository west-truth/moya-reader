-- An unsupported or divergent peer event stays behind its cursor. Keep the
-- offending event and both verified identities for later conflict resolution.
create table sync_peer_conflicts (
  user_id text not null references users(id) on delete cascade,
  peer_id text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  event_id text not null,
  event_type text not null,
  book_id text,
  reason text not null,
  local_identity jsonb,
  remote_identity jsonb,
  status text not null default 'unresolved' check (status in ('unresolved', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, peer_id, direction, event_id)
);

create index sync_peer_conflicts_open_idx on sync_peer_conflicts (user_id, peer_id, updated_at desc)
  where status = 'unresolved';
