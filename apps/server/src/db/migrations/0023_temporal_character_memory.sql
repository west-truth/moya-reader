create table if not exists temporal_address_events (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  scene_id text not null,
  narrative_order integer not null,
  status text not null,
  supersedes_event_id text,
  fingerprint text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists idx_temporal_address_events_revision_scene
  on temporal_address_events(user_id, content_revision_id, scene_id, narrative_order);
create index if not exists idx_temporal_address_events_supersedes
  on temporal_address_events(supersedes_event_id) where supersedes_event_id is not null;

create table if not exists temporal_relation_edges (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  subject_speaker_entity_id text not null,
  object_speaker_entity_id text not null,
  relation_type text not null,
  status text not null,
  reader_visible_from_order integer,
  reader_visible_to_order integer,
  effective_from_narrative_order integer,
  effective_to_narrative_order integer,
  supersedes_edge_id text,
  fingerprint text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists idx_temporal_relation_edges_revision_subject
  on temporal_relation_edges(user_id, content_revision_id, subject_speaker_entity_id, status);
create index if not exists idx_temporal_relation_edges_revision_object
  on temporal_relation_edges(user_id, content_revision_id, object_speaker_entity_id, status);
create index if not exists idx_temporal_relation_edges_reader_interval
  on temporal_relation_edges(user_id, content_revision_id, reader_visible_from_order, reader_visible_to_order);
create index if not exists idx_temporal_relation_edges_supersedes
  on temporal_relation_edges(supersedes_edge_id) where supersedes_edge_id is not null;

create table if not exists character_temporal_snapshots (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  scene_id text not null,
  narrative_order integer not null,
  reader_mode text not null check (reader_mode in ('reader_safe', 'omniscient_consistent', 'streaming')),
  fingerprint text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, content_revision_id, scene_id, reader_mode)
);

create index if not exists idx_character_temporal_snapshots_chapter
  on character_temporal_snapshots(user_id, content_revision_id, chapter_id, narrative_order);
