create table if not exists self_host_accounts (
  singleton_key smallint primary key default 1 check (singleton_key = 1),
  user_id text not null unique references users(id) on delete cascade,
  username text not null,
  normalized_username text not null unique,
  display_name text not null,
  password_scheme text not null check (password_scheme = 'scrypt-v1'),
  password_salt text not null,
  password_digest text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists self_host_sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists self_host_sessions_user_expiry_idx
  on self_host_sessions (user_id, expires_at desc);

create index if not exists self_host_sessions_expiry_idx
  on self_host_sessions (expires_at);
