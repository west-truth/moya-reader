-- Executable extension data is separate from reader settings, sync and book backups.
create table extension_packages (
  user_id text not null references users(id) on delete cascade,
  package_id text not null,
  revision bigint not null check (revision > 0),
  metadata jsonb not null,
  active_archive bytea,
  previous_archive bytea,
  primary key (user_id, package_id),
  check (jsonb_typeof(metadata) = 'object'),
  check (octet_length(active_archive) <= 10485760),
  check (octet_length(previous_archive) <= 10485760)
);
