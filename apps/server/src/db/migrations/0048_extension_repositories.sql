CREATE TABLE IF NOT EXISTS extension_repositories (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_url text NOT NULL CHECK (octet_length(repository_url) <= 8192),
  revision bigint NOT NULL CHECK (revision > 0),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 1048576),
  PRIMARY KEY (user_id, repository_url)
);
