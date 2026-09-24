create table if not exists sync_server_identity (
  singleton boolean primary key default true check (singleton),
  server_id text not null unique
);

create table if not exists sync_server_peers (
  user_id text primary key references users(id) on delete cascade,
  peer_id text not null,
  peer_url text not null,
  peer_server_id text not null,
  session_ciphertext text not null,
  session_iv text not null,
  session_auth_tag text not null,
  session_key_version text not null,
  outbound_cursor bigint not null default 0 check (outbound_cursor >= 0),
  inbound_cursor bigint not null default 0 check (inbound_cursor >= 0),
  status text not null default 'ready',
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
