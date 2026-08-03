create table if not exists character_evidence_v2 (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null,
  paragraph_id text,
  normalized_surface text,
  status text not null default 'candidate',
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists character_facts_v2 (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  character_id text not null,
  field_name text not null,
  status text not null,
  from_chapter_index integer not null default 0,
  to_chapter_index integer,
  scene_id text,
  locked_by_user boolean not null default false,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists character_mentions_v2 (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  character_id text,
  normalized_surface text not null,
  chapter_id text,
  scene_id text,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists character_address_terms_v2 (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  speaker_character_id text,
  target_character_id text not null,
  normalized_surface text not null,
  from_chapter_index integer not null default 0,
  to_chapter_index integer,
  scene_id text,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists character_speech_traits_v2 (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  character_id text not null,
  trait text not null,
  from_chapter_index integer not null default 0,
  to_chapter_index integer,
  scene_id text,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists character_relation_facts_v2 (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  source_character_id text not null,
  target_character_id text not null,
  relation_label text not null,
  from_chapter_index integer not null default 0,
  to_chapter_index integer,
  scene_id text,
  status text not null,
  locked_by_user boolean not null default false,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists character_merge_candidates_v2 (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  source_character_id text not null,
  target_character_id text not null,
  status text not null,
  confidence numeric not null default 0,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists character_id_redirects_v2 (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  source_character_id text not null,
  target_character_id text not null,
  operation_id text not null,
  graph_revision text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (book_id, source_character_id)
);

create table if not exists character_identity_operation_receipts_v2 (
  operation_id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  command_hash text not null,
  result jsonb not null,
  applied_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_character_facts_v2_active
  on character_facts_v2(book_id, character_id, status, from_chapter_index, to_chapter_index);
create index if not exists idx_character_mentions_v2_surface
  on character_mentions_v2(book_id, normalized_surface, chapter_id, scene_id, status);
create index if not exists idx_character_address_terms_v2_surface
  on character_address_terms_v2(book_id, normalized_surface, from_chapter_index, to_chapter_index, status);
create index if not exists idx_character_evidence_v2_source
  on character_evidence_v2(book_id, chapter_id, paragraph_id);
create index if not exists idx_character_merge_candidates_v2_open
  on character_merge_candidates_v2(book_id, status, confidence desc);
create index if not exists idx_character_redirects_v2_source
  on character_id_redirects_v2(book_id, source_character_id);

insert into character_facts_v2 (
  id, book_id, character_id, field_name, status, from_chapter_index, locked_by_user, payload
)
select
  'cgf2_' || md5(character.id || ':canonical_name:' || character.canonical_name),
  character.book_id,
  character.id,
  'canonical_name',
  'active',
  0,
  character.is_user_confirmed,
  jsonb_build_object(
    'id', 'cgf2_' || md5(character.id || ':canonical_name:' || character.canonical_name),
    'novelId', character.book_id,
    'characterId', character.id,
    'field', 'canonical_name',
    'value', character.canonical_name,
    'aliasType', 'name',
    'confidence', character.confidence,
    'status', 'active',
    'source', 'legacy_backfill',
    'lockedByUser', character.is_user_confirmed,
    'validity', jsonb_build_object('fromChapterIndex', 0),
    'evidenceIds', '[]'::jsonb
  )
from characters character
on conflict (id) do nothing;

with aliases as (
  select character.id as character_id, character.book_id, character.confidence,
         character.is_user_confirmed, alias.value as surface,
         lower(regexp_replace(trim(alias.value), '\s+', ' ', 'g')) as normalized_surface
  from characters character
  cross join lateral jsonb_array_elements_text(character.aliases) alias(value)
), generic as (
  select * from aliases
  where normalized_surface = any(array[
    '그', '그녀', '그 남자', '그 여자', '남자', '여자', '아이', '소년', '소녀',
    '팀장', '사장', '선생', '선생님', '아저씨', '아줌마', 'he', 'she', 'they',
    'the man', 'the woman', 'the child'
  ])
)
insert into character_mentions_v2 (
  id, book_id, character_id, normalized_surface, status, payload
)
select
  'cgm2_' || md5(character_id || ':legacy:' || normalized_surface),
  book_id,
  character_id,
  normalized_surface,
  'candidate',
  jsonb_build_object(
    'id', 'cgm2_' || md5(character_id || ':legacy:' || normalized_surface),
    'novelId', book_id,
    'characterId', character_id,
    'surface', surface,
    'normalizedSurface', normalized_surface,
    'kind', 'generic_reference',
    'confidence', confidence,
    'status', 'candidate',
    'validity', jsonb_build_object('fromChapterIndex', 0),
    'evidenceIds', '[]'::jsonb
  )
from generic
on conflict (id) do nothing;

with aliases as (
  select character.id as character_id, character.book_id, character.confidence,
         character.is_user_confirmed, alias.value as surface,
         lower(regexp_replace(trim(alias.value), '\s+', ' ', 'g')) as normalized_surface
  from characters character
  cross join lateral jsonb_array_elements_text(character.aliases) alias(value)
)
insert into character_facts_v2 (
  id, book_id, character_id, field_name, status, from_chapter_index, locked_by_user, payload
)
select
  'cgf2_' || md5(character_id || ':typed_alias:' || surface),
  book_id,
  character_id,
  'typed_alias',
  'active',
  0,
  is_user_confirmed,
  jsonb_build_object(
    'id', 'cgf2_' || md5(character_id || ':typed_alias:' || surface),
    'novelId', book_id,
    'characterId', character_id,
    'field', 'typed_alias',
    'value', surface,
    'aliasType', 'untyped',
    'confidence', confidence,
    'status', 'active',
    'source', 'legacy_backfill',
    'lockedByUser', is_user_confirmed,
    'validity', jsonb_build_object('fromChapterIndex', 0),
    'evidenceIds', '[]'::jsonb
  )
from aliases
where normalized_surface <> all(array[
  '그', '그녀', '그 남자', '그 여자', '남자', '여자', '아이', '소년', '소녀',
  '팀장', '사장', '선생', '선생님', '아저씨', '아줌마', 'he', 'she', 'they',
  'the man', 'the woman', 'the child'
])
on conflict (id) do nothing;

insert into character_relation_facts_v2 (
  id, book_id, source_character_id, target_character_id, relation_label,
  from_chapter_index, status, locked_by_user, payload
)
select relation.id, relation.book_id, relation.source_character_id, relation.target_character_id,
       relation.relation_label, 0, 'active', false,
       jsonb_build_object(
         'id', relation.id,
         'novelId', relation.book_id,
         'sourceCharacterId', relation.source_character_id,
         'targetCharacterId', relation.target_character_id,
         'relationLabel', relation.relation_label,
         'termsUsedBySource', relation.terms_used_by_source,
         'termsUsedByTarget', relation.terms_used_by_target,
         'confidence', relation.confidence,
         'evidence', coalesce(relation.evidence, '[]'::jsonb),
         'status', 'active',
         'validity', jsonb_build_object('fromChapterIndex', 0),
         'evidenceIds', '[]'::jsonb,
         'lockedByUser', false
       )
from character_relations relation
on conflict (id) do nothing;
