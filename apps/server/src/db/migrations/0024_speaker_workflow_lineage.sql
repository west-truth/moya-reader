create table if not exists speaker_sequence_decisions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  scene_id text not null,
  packet_fingerprint text not null,
  fingerprint text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists idx_speaker_sequence_decisions_chapter
  on speaker_sequence_decisions(user_id, content_revision_id, chapter_id, scene_id);
create index if not exists idx_speaker_sequence_decisions_packet
  on speaker_sequence_decisions(user_id, packet_fingerprint);

create table if not exists speaker_artifact_dependencies (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  chapter_id text,
  scene_id text,
  burst_id text,
  artifact_id text not null,
  artifact_kind text not null,
  dependency_level text not null check (dependency_level in ('L0_source','L1_inventory','L2_memory','L3_speaker','L4_voice')),
  status text not null check (status in ('active','stale')),
  stale_reason text,
  fingerprint text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'active' and stale_reason is null) or
    (status = 'stale' and nullif(btrim(stale_reason), '') is not null)
  )
);

create index if not exists idx_speaker_artifact_dependencies_artifact
  on speaker_artifact_dependencies(user_id, artifact_id, status);
create index if not exists idx_speaker_artifact_dependencies_scope
  on speaker_artifact_dependencies(user_id, content_revision_id, chapter_id, scene_id);

create table if not exists speaker_identity_edges (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  source_reveal_anchor_id text not null check (btrim(source_reveal_anchor_id) <> ''),
  speaker_entity_id text not null,
  character_id text not null,
  visible_from_narrative_order integer not null,
  visible_to_narrative_order integer,
  status text not null check (status in ('active','superseded','rejected')),
  fingerprint text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  check (visible_from_narrative_order >= 0),
  check (visible_to_narrative_order is null or visible_to_narrative_order >= visible_from_narrative_order)
);

create index if not exists idx_speaker_identity_edges_entity
  on speaker_identity_edges(
    user_id, book_id, content_revision_id, speaker_entity_id, visible_from_narrative_order
  );
create index if not exists idx_speaker_identity_edges_active
  on speaker_identity_edges(user_id, book_id, content_revision_id, speaker_entity_id)
  where status = 'active';

create table if not exists speaker_voice_identities (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  source_reveal_anchor_id text not null check (btrim(source_reveal_anchor_id) <> ''),
  speaker_entity_id text not null,
  voice_identity_id text not null,
  visible_from_narrative_order integer not null,
  visible_to_narrative_order integer,
  user_pinned boolean not null default false,
  fingerprint text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  check (visible_from_narrative_order >= 0),
  check (visible_to_narrative_order is null or visible_to_narrative_order >= visible_from_narrative_order)
);

create index if not exists idx_speaker_voice_identities_entity
  on speaker_voice_identities(
    user_id, book_id, content_revision_id, speaker_entity_id, visible_from_narrative_order
  );
create index if not exists idx_speaker_voice_identities_voice
  on speaker_voice_identities(user_id, book_id, content_revision_id, voice_identity_id);
