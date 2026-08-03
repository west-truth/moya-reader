create table if not exists speaker_source_manifests (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  status text not null check (status in ('ready', 'review_required', 'stale')),
  fingerprint text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, content_revision_id)
);

create index if not exists idx_speaker_source_manifests_book
  on speaker_source_manifests(user_id, book_id, updated_at desc);

create table if not exists speaker_chapter_inventories (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  chapter_id text not null references chapters(id) on delete cascade,
  chapter_index integer not null,
  fingerprint text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, content_revision_id, chapter_id)
);

create index if not exists idx_speaker_chapter_inventories_book_revision
  on speaker_chapter_inventories(user_id, book_id, content_revision_id, chapter_index);

create table if not exists speaker_scenes (
  id text primary key,
  inventory_id text not null references speaker_chapter_inventories(id) on delete cascade,
  book_id text not null,
  content_revision_id text not null,
  chapter_id text not null,
  scene_index integer not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
);

create unique index if not exists idx_speaker_scenes_inventory_index
  on speaker_scenes(inventory_id, scene_index);

create table if not exists speaker_spans (
  id text primary key,
  inventory_id text not null references speaker_chapter_inventories(id) on delete cascade,
  book_id text not null,
  content_revision_id text not null,
  chapter_id text not null,
  scene_id text not null,
  paragraph_id text not null,
  span_index integer not null,
  start_offset integer not null,
  end_offset integer not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
);

create unique index if not exists idx_speaker_spans_inventory_index
  on speaker_spans(inventory_id, span_index);
create index if not exists idx_speaker_spans_scene on speaker_spans(inventory_id, scene_id);
create index if not exists idx_speaker_spans_paragraph on speaker_spans(chapter_id, paragraph_id, start_offset);

create table if not exists speaker_dialogue_bursts (
  id text primary key,
  inventory_id text not null references speaker_chapter_inventories(id) on delete cascade,
  book_id text not null,
  content_revision_id text not null,
  chapter_id text not null,
  scene_id text not null,
  burst_index integer not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
);

create unique index if not exists idx_speaker_dialogue_bursts_inventory_index
  on speaker_dialogue_bursts(inventory_id, burst_index);
create index if not exists idx_speaker_dialogue_bursts_scene
  on speaker_dialogue_bursts(inventory_id, scene_id);

create table if not exists speaker_mentions (
  id text primary key,
  inventory_id text not null references speaker_chapter_inventories(id) on delete cascade,
  book_id text not null,
  content_revision_id text not null,
  chapter_id text not null,
  scene_id text not null,
  span_id text not null,
  paragraph_id text not null,
  ordinal integer not null,
  start_offset integer not null,
  end_offset integer not null,
  normalized_surface text not null,
  mention_type text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
);

create unique index if not exists idx_speaker_mentions_inventory_ordinal
  on speaker_mentions(inventory_id, ordinal);
create index if not exists idx_speaker_mentions_scene_surface
  on speaker_mentions(inventory_id, scene_id, normalized_surface);
create index if not exists idx_speaker_mentions_span on speaker_mentions(inventory_id, span_id);

create table if not exists speaker_entities (
  id text primary key,
  inventory_id text not null references speaker_chapter_inventories(id) on delete cascade,
  book_id text not null,
  content_revision_id text not null,
  chapter_id text not null,
  scene_id text,
  character_id text,
  entity_kind text not null,
  status text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
);

create index if not exists idx_speaker_entities_scope
  on speaker_entities(inventory_id, scene_id, entity_kind, status);
create index if not exists idx_speaker_entities_character
  on speaker_entities(inventory_id, character_id) where character_id is not null;

create table if not exists speaker_address_events (
  id text primary key,
  inventory_id text not null references speaker_chapter_inventories(id) on delete cascade,
  book_id text not null,
  content_revision_id text not null,
  chapter_id text not null,
  scene_id text not null,
  span_id text not null,
  mention_id text not null,
  status text not null,
  relation_status text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
);

create index if not exists idx_speaker_address_events_scene
  on speaker_address_events(inventory_id, scene_id, status);
create index if not exists idx_speaker_address_events_mention
  on speaker_address_events(inventory_id, mention_id);
