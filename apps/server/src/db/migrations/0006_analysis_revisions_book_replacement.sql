alter table library_books add column if not exists content_revision_number bigint not null default 1;
alter table library_books add column if not exists revision_fence bigint not null default 1;
alter table library_books add column if not exists active_content_revision_id text;
alter table library_books add column if not exists active_character_graph_revision_id text;

alter table provider_jobs drop constraint if exists provider_jobs_chapter_id_fkey;
alter table provider_jobs
  add constraint provider_jobs_chapter_id_fkey
  foreign key (chapter_id) references chapters(id) on delete set null;

alter table analysis_runs drop constraint if exists analysis_runs_chapter_id_fkey;
alter table analysis_runs
  add constraint analysis_runs_chapter_id_fkey
  foreign key (chapter_id) references chapters(id) on delete set null;

create table if not exists book_content_revisions (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  revision_number bigint not null check (revision_number > 0),
  source_object_id text,
  source_raw_text_hash text,
  normalized_text_hash text not null,
  source_file_name text not null,
  source_encoding text,
  status text not null check (status in ('preparing', 'active', 'superseded', 'quarantined')),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  superseded_at timestamptz,
  unique (book_id, revision_number)
);

create unique index if not exists idx_book_content_revisions_active
  on book_content_revisions(book_id)
  where status = 'active';

insert into book_content_revisions (
  id, book_id, revision_number, source_object_id, source_raw_text_hash,
  normalized_text_hash, source_file_name, source_encoding, status, created_at, activated_at
)
select
  'content_revision:legacy:' || book.id,
  book.id,
  greatest(book.content_revision_number, 1),
  book.object_id,
  object.raw_text_hash,
  book.normalized_text_hash,
  book.source_file_name,
  book.source_encoding,
  'active',
  book.created_at,
  coalesce(book.updated_at, book.created_at)
from library_books book
left join book_objects object on object.id = book.object_id
where not exists (
  select 1 from book_content_revisions revision where revision.book_id = book.id
);

update library_books book
set active_content_revision_id = revision.id,
    content_revision_number = revision.revision_number
from book_content_revisions revision
where revision.book_id = book.id
  and revision.status = 'active'
  and book.active_content_revision_id is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'library_books_active_content_revision_fk') then
    alter table library_books
      add constraint library_books_active_content_revision_fk
      foreign key (active_content_revision_id)
      references book_content_revisions(id)
      on delete set null
      deferrable initially immediate;
  end if;
end $$;

create table if not exists character_graph_revisions (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  revision_number bigint not null check (revision_number > 0),
  graph_fingerprint text not null,
  snapshot jsonb not null,
  source_input_revision_id text,
  source_artifact_id text,
  status text not null check (status in ('active', 'superseded', 'staged', 'stale', 'quarantined')),
  created_at timestamptz not null default now(),
  promoted_at timestamptz,
  superseded_at timestamptz,
  unique (book_id, revision_number)
);

create unique index if not exists idx_character_graph_revisions_active
  on character_graph_revisions(book_id)
  where status = 'active';

insert into character_graph_revisions (
  id, book_id, content_revision_id, revision_number, graph_fingerprint, snapshot, status, created_at, promoted_at
)
select
  'graph_revision:legacy:' || book.id,
  book.id,
  book.active_content_revision_id,
  1,
  'legacy:' || book.normalized_text_hash,
  jsonb_build_object(
    'novelId', book.id,
    'characters', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', character.id,
        'novelId', character.book_id,
        'canonicalName', character.canonical_name,
        'aliases', character.aliases,
        'color', character.color,
        'description', character.description,
        'confidence', character.confidence,
        'isUserConfirmed', character.is_user_confirmed
      ) order by character.id)
      from characters character
      where character.book_id = book.id
    ), '[]'::jsonb),
    'relations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', relation.id,
        'novelId', relation.book_id,
        'sourceCharacterId', relation.source_character_id,
        'targetCharacterId', relation.target_character_id,
        'relationLabel', relation.relation_label,
        'termsUsedBySource', relation.terms_used_by_source,
        'termsUsedByTarget', relation.terms_used_by_target,
        'confidence', relation.confidence,
        'evidence', coalesce(relation.evidence, '[]'::jsonb)
      ) order by relation.id)
      from character_relations relation
      where relation.book_id = book.id
    ), '[]'::jsonb)
  ),
  'active',
  book.created_at,
  coalesce(book.updated_at, book.created_at)
from library_books book
where book.active_content_revision_id is not null
  and not exists (
    select 1 from character_graph_revisions revision where revision.book_id = book.id
  );

update library_books book
set active_character_graph_revision_id = revision.id
from character_graph_revisions revision
where revision.book_id = book.id
  and revision.status = 'active'
  and book.active_character_graph_revision_id is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'library_books_active_graph_revision_fk') then
    alter table library_books
      add constraint library_books_active_graph_revision_fk
      foreign key (active_character_graph_revision_id)
      references character_graph_revisions(id)
      on delete set null
      deferrable initially immediate;
  end if;
end $$;

alter table book_ai_workflows add column if not exists content_revision_id text;
alter table book_ai_workflows add column if not exists base_graph_revision_id text;
alter table book_ai_workflows add column if not exists revision_fence bigint;

update book_ai_workflows workflow
set content_revision_id = book.active_content_revision_id,
    base_graph_revision_id = book.active_character_graph_revision_id,
    revision_fence = book.revision_fence
from library_books book
where book.id = workflow.book_id
  and (workflow.content_revision_id is null or workflow.revision_fence is null);

alter table book_ai_workflows alter column content_revision_id set not null;
alter table book_ai_workflows alter column revision_fence set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'book_ai_workflows_content_revision_fk') then
    alter table book_ai_workflows
      add constraint book_ai_workflows_content_revision_fk
      foreign key (content_revision_id) references book_content_revisions(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'book_ai_workflows_base_graph_revision_fk') then
    alter table book_ai_workflows
      add constraint book_ai_workflows_base_graph_revision_fk
      foreign key (base_graph_revision_id) references character_graph_revisions(id) on delete set null;
  end if;
end $$;

drop index if exists idx_book_ai_workflows_active_plan;
create unique index idx_book_ai_workflows_active_plan
  on book_ai_workflows(
    user_id, book_id, workflow_type, provider_id, coalesce(model_id, ''), plan_hash, content_revision_id
  )
  where status = 'running';

create table if not exists analysis_input_revisions (
  id text primary key,
  provider_job_id text not null unique references provider_jobs(id) on delete cascade,
  workflow_id text references book_ai_workflows(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text,
  job_type text not null,
  content_revision_id text not null references book_content_revisions(id) on delete cascade,
  content_revision_number bigint not null check (content_revision_number > 0),
  revision_fence bigint not null check (revision_fence > 0),
  source_object_id text,
  source_raw_text_hash text,
  normalized_text_hash text not null,
  character_graph_revision_id text references character_graph_revisions(id) on delete set null,
  character_graph_fingerprint text not null,
  correction_fingerprint text not null,
  request_profile_id text not null,
  prompt_version text not null,
  schema_version text not null,
  provider_id text not null,
  model_id text,
  provider_options_fingerprint text not null,
  provider_options jsonb not null,
  window_spec jsonb not null,
  source_snapshot jsonb not null,
  graph_snapshot jsonb not null,
  corrections_snapshot jsonb not null,
  episode_context_snapshot jsonb,
  render_spec jsonb,
  render_spec_hash text,
  voice_profile_snapshot jsonb,
  input_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_analysis_input_revisions_workflow
  on analysis_input_revisions(workflow_id, chapter_id, created_at);
create index if not exists idx_analysis_input_revisions_book_content
  on analysis_input_revisions(book_id, content_revision_id);

alter table provider_jobs add column if not exists analysis_input_revision_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'provider_jobs_analysis_input_revision_fk') then
    alter table provider_jobs
      add constraint provider_jobs_analysis_input_revision_fk
      foreign key (analysis_input_revision_id)
      references analysis_input_revisions(id)
      on delete set null
      deferrable initially immediate;
  end if;
end $$;

create table if not exists analysis_staging_artifacts (
  id text primary key,
  input_revision_id text not null references analysis_input_revisions(id) on delete cascade,
  provider_job_id text not null references provider_jobs(id) on delete cascade,
  workflow_id text references book_ai_workflows(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text,
  artifact_type text not null,
  output_hash text not null,
  payload jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  expected_content_revision_id text not null references book_content_revisions(id) on delete cascade,
  expected_graph_revision_id text references character_graph_revisions(id) on delete set null,
  status text not null default 'staged' check (status in ('staged', 'promoted', 'stale', 'quarantined')),
  stale_reason text,
  created_at timestamptz not null default now(),
  promoted_at timestamptz,
  unique (provider_job_id, artifact_type, output_hash)
);

create index if not exists idx_analysis_staging_artifacts_pending
  on analysis_staging_artifacts(book_id, status, created_at)
  where status = 'staged';

create table if not exists analysis_episode_contexts (
  id text primary key,
  workflow_id text not null references book_ai_workflows(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  chapter_id text not null,
  window_id text not null,
  window_sequence integer not null check (window_sequence >= 0),
  input_revision_id text not null references analysis_input_revisions(id) on delete cascade,
  artifact_id text not null references analysis_staging_artifacts(id) on delete cascade,
  context jsonb not null,
  is_chapter_aggregate boolean not null default false,
  status text not null default 'active' check (status in ('active', 'stale', 'quarantined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_id, chapter_id, window_sequence)
);

create index if not exists idx_analysis_episode_contexts_previous
  on analysis_episode_contexts(workflow_id, chapter_id, window_sequence desc)
  where status = 'active';

create table if not exists book_replacement_runs (
  id text primary key,
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  from_content_revision_id text not null references book_content_revisions(id) on delete cascade,
  to_content_revision_id text not null references book_content_revisions(id) on delete cascade,
  expected_revision_fence bigint not null,
  status text not null check (status in ('preparing', 'finalized', 'failed')),
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  unique (book_id, to_content_revision_id)
);

create table if not exists book_revision_quarantine (
  id text primary key,
  replacement_run_id text not null references book_replacement_runs(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  source_content_revision_id text references book_content_revisions(id) on delete set null,
  artifact_type text not null,
  source_entity_id text not null,
  reason text not null,
  payload jsonb not null,
  source_anchor jsonb,
  source_anchor_hash text,
  remap_status text not null default 'quarantined'
    check (remap_status in ('quarantined', 'remapped', 'discarded')),
  remapped_entity_id text,
  quarantined_at timestamptz not null default now(),
  remapped_at timestamptz,
  unique (replacement_run_id, artifact_type, source_entity_id)
);

create index if not exists idx_book_revision_quarantine_book
  on book_revision_quarantine(book_id, quarantined_at desc);

alter table analysis_runs add column if not exists content_revision_id text;
alter table analysis_runs add column if not exists input_revision_id text;
alter table analysis_runs add column if not exists artifact_id text;
alter table analysis_runs add column if not exists lifecycle_state text not null default 'active';

alter table characters add column if not exists graph_revision_id text;
alter table characters add column if not exists source_content_revision_id text;
alter table characters add column if not exists source_anchor jsonb;
alter table characters add column if not exists source_anchor_hash text;
alter table characters add column if not exists provenance_kind text not null default 'generated';

alter table character_aliases add column if not exists graph_revision_id text;
alter table character_relations add column if not exists graph_revision_id text;

alter table labeled_segments add column if not exists content_revision_id text;
alter table labeled_segments add column if not exists graph_revision_id text;
alter table labeled_segments add column if not exists artifact_id text;
alter table labeled_segments add column if not exists lifecycle_state text not null default 'active';

alter table chapter_contexts add column if not exists content_revision_id text;
alter table chapter_contexts add column if not exists graph_revision_id text;
alter table chapter_contexts add column if not exists artifact_id text;
alter table chapter_contexts add column if not exists lifecycle_state text not null default 'active';

alter table voice_profiles add column if not exists source_content_revision_id text;
alter table voice_profiles add column if not exists source_anchor jsonb;
alter table voice_profiles add column if not exists source_anchor_hash text;
alter table voice_profiles add column if not exists lifecycle_state text not null default 'active';

alter table user_corrections add column if not exists source_content_revision_id text;
alter table user_corrections add column if not exists source_anchor jsonb;
alter table user_corrections add column if not exists source_anchor_hash text;
alter table user_corrections add column if not exists lifecycle_state text not null default 'active';

alter table tts_audio_cache add column if not exists content_revision_id text;
alter table tts_audio_cache add column if not exists graph_revision_id text;
alter table tts_audio_cache add column if not exists input_revision_id text;
alter table tts_audio_cache add column if not exists lifecycle_state text not null default 'active';

update analysis_runs run
set content_revision_id = book.active_content_revision_id
from library_books book
where book.id = run.book_id and run.content_revision_id is null;

update characters character
set graph_revision_id = book.active_character_graph_revision_id,
    source_content_revision_id = book.active_content_revision_id,
    source_anchor = jsonb_build_object('kind', 'legacy_book', 'normalizedTextHash', book.normalized_text_hash),
    source_anchor_hash = book.normalized_text_hash,
    provenance_kind = case when character.is_user_confirmed then 'user_confirmed' else 'generated' end
from library_books book
where book.id = character.book_id;

update character_aliases alias
set graph_revision_id = book.active_character_graph_revision_id
from library_books book
where book.id = alias.book_id and alias.graph_revision_id is null;

update character_relations relation
set graph_revision_id = book.active_character_graph_revision_id
from library_books book
where book.id = relation.book_id and relation.graph_revision_id is null;

update labeled_segments segment
set content_revision_id = book.active_content_revision_id,
    graph_revision_id = book.active_character_graph_revision_id
from library_books book
where book.id = segment.book_id and segment.content_revision_id is null;

update chapter_contexts context
set content_revision_id = book.active_content_revision_id,
    graph_revision_id = book.active_character_graph_revision_id
from library_books book
where book.id = context.book_id and context.content_revision_id is null;

update voice_profiles profile
set source_content_revision_id = book.active_content_revision_id,
    source_anchor = jsonb_build_object('kind', 'legacy_book', 'normalizedTextHash', book.normalized_text_hash),
    source_anchor_hash = book.normalized_text_hash
from library_books book
where book.id = profile.book_id and profile.source_content_revision_id is null;

update user_corrections correction
set source_content_revision_id = book.active_content_revision_id,
    source_anchor = jsonb_build_object(
      'kind', 'paragraph',
      'chapterIndex', chapter.chapter_index,
      'paragraphIndex', paragraph.paragraph_index,
      'paragraphId', paragraph.paragraph_id,
      'textHash', coalesce(paragraph.paragraph->>'textHash', paragraph.paragraph->>'text_hash', '')
    ),
    source_anchor_hash = coalesce(
      nullif(paragraph.paragraph->>'textHash', ''),
      nullif(paragraph.paragraph->>'text_hash', '')
    )
from library_books book, chapters chapter, paragraph_search paragraph
where book.id = correction.book_id
  and chapter.id = correction.chapter_id
  and chapter.book_id = correction.book_id
  and paragraph.book_id = correction.book_id
  and paragraph.chapter_id = correction.chapter_id
  and paragraph.paragraph_id = correction.paragraph_id
  and correction.source_content_revision_id is null;

update user_corrections correction
set source_content_revision_id = book.active_content_revision_id,
    source_anchor = jsonb_build_object(
      'kind', 'chapter', 'chapterIndex', chapter.chapter_index, 'textHash', chapter.text_hash
    ),
    source_anchor_hash = chapter.text_hash
from library_books book, chapters chapter
where book.id = correction.book_id
  and chapter.id = correction.chapter_id
  and chapter.book_id = correction.book_id
  and correction.source_content_revision_id is null;

update user_corrections correction
set source_content_revision_id = book.active_content_revision_id,
    source_anchor = jsonb_build_object('kind', 'legacy_book', 'normalizedTextHash', book.normalized_text_hash),
    source_anchor_hash = book.normalized_text_hash
from library_books book
where book.id = correction.book_id and correction.source_content_revision_id is null;

update tts_audio_cache cache
set content_revision_id = book.active_content_revision_id,
    graph_revision_id = book.active_character_graph_revision_id
from library_books book
where book.id = cache.book_id and cache.content_revision_id is null;

create or replace function guard_analysis_input_revision_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'analysis input revisions are immutable' using errcode = '23514';
end;
$$;

drop trigger if exists analysis_input_revision_immutable on analysis_input_revisions;
create trigger analysis_input_revision_immutable
before update on analysis_input_revisions
for each row execute function guard_analysis_input_revision_immutable();

create or replace function guard_analysis_artifact_payload_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.input_revision_id is distinct from old.input_revision_id
     or new.provider_job_id is distinct from old.provider_job_id
     or new.artifact_type is distinct from old.artifact_type
     or new.output_hash is distinct from old.output_hash
     or new.payload is distinct from old.payload
     or new.expected_content_revision_id is distinct from old.expected_content_revision_id
     or new.expected_graph_revision_id is distinct from old.expected_graph_revision_id then
    raise exception 'analysis staging artifact payload is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists analysis_artifact_payload_immutable on analysis_staging_artifacts;
create trigger analysis_artifact_payload_immutable
before update on analysis_staging_artifacts
for each row execute function guard_analysis_artifact_payload_immutable();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'character_graph_revisions_input_revision_fk') then
    alter table character_graph_revisions
      add constraint character_graph_revisions_input_revision_fk
      foreign key (source_input_revision_id)
      references analysis_input_revisions(id)
      on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'character_graph_revisions_artifact_fk') then
    alter table character_graph_revisions
      add constraint character_graph_revisions_artifact_fk
      foreign key (source_artifact_id)
      references analysis_staging_artifacts(id)
      on delete set null;
  end if;
end $$;

create or replace function guard_book_content_revision_transition()
returns trigger
language plpgsql
as $$
begin
  if new.book_id is distinct from old.book_id
     or new.revision_number is distinct from old.revision_number
     or new.source_object_id is distinct from old.source_object_id
     or new.source_raw_text_hash is distinct from old.source_raw_text_hash
     or new.normalized_text_hash is distinct from old.normalized_text_hash
     or new.source_file_name is distinct from old.source_file_name
     or new.source_encoding is distinct from old.source_encoding then
    raise exception 'book content revision provenance is immutable' using errcode = '23514';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if old.status = 'preparing' and new.status in ('active', 'quarantined') then
    return new;
  end if;
  if old.status = 'active' and new.status in ('superseded', 'quarantined') then
    return new;
  end if;
  raise exception 'invalid book content revision transition: % -> %', old.status, new.status
    using errcode = '23514';
end;
$$;

drop trigger if exists book_content_revision_transition_guard on book_content_revisions;
create trigger book_content_revision_transition_guard
before update on book_content_revisions
for each row execute function guard_book_content_revision_transition();

create or replace function normalize_library_book_revision_pointers()
returns trigger
language plpgsql
as $$
begin
  if new.active_content_revision_id is not null and not exists (
    select 1
    from book_content_revisions revision
    where revision.id = new.active_content_revision_id and revision.book_id = new.id
  ) then
    new.active_content_revision_id := null;
  end if;
  if new.active_character_graph_revision_id is not null and not exists (
    select 1
    from character_graph_revisions revision
    where revision.id = new.active_character_graph_revision_id and revision.book_id = new.id
  ) then
    new.active_character_graph_revision_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists library_book_revision_pointer_normalization on library_books;
create trigger library_book_revision_pointer_normalization
before insert on library_books
for each row execute function normalize_library_book_revision_pointers();

create or replace function initialize_book_content_revision()
returns trigger
language plpgsql
as $$
declare
  revision_id text;
  raw_hash text;
  current_revision_book_id text;
  current_graph_book_id text;
begin
  if new.active_content_revision_id is not null then
    select revision.book_id
    into current_revision_book_id
    from book_content_revisions revision
    where revision.id = new.active_content_revision_id;
    if current_revision_book_id = new.id then
      return new;
    end if;
  end if;
  revision_id := 'content_revision:initial:' || new.id;
  select object.raw_text_hash into raw_hash from book_objects object where object.id = new.object_id;
  if new.active_character_graph_revision_id is not null then
    select revision.book_id
    into current_graph_book_id
    from character_graph_revisions revision
    where revision.id = new.active_character_graph_revision_id;
  end if;
  insert into book_content_revisions (
    id, book_id, revision_number, source_object_id, source_raw_text_hash,
    normalized_text_hash, source_file_name, source_encoding, status, created_at, activated_at
  )
  values (
    revision_id, new.id, greatest(new.content_revision_number, 1), new.object_id, raw_hash,
    new.normalized_text_hash, new.source_file_name, new.source_encoding, 'active', new.created_at, now()
  )
  on conflict (id) do nothing;
  update library_books
  set active_content_revision_id = revision_id,
      active_character_graph_revision_id = case
        when current_graph_book_id = new.id then new.active_character_graph_revision_id
        else null
      end,
      content_revision_number = greatest(new.content_revision_number, 1)
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists library_book_content_revision_init on library_books;
create trigger library_book_content_revision_init
after insert on library_books
for each row execute function initialize_book_content_revision();

create or replace function fill_book_ai_workflow_revision_defaults()
returns trigger
language plpgsql
as $$
declare
  active_content_revision_id text;
  active_graph_revision_id text;
  active_revision_fence bigint;
  content_revision_is_current boolean;
begin
  select book.active_content_revision_id,
         book.active_character_graph_revision_id,
         book.revision_fence
  into active_content_revision_id, active_graph_revision_id, active_revision_fence
  from library_books book
  where book.id = new.book_id and book.user_id = new.user_id;

  select exists (
    select 1
    from book_content_revisions revision
    where revision.id = new.content_revision_id and revision.book_id = new.book_id
  ) into content_revision_is_current;

  if new.content_revision_id is null or not content_revision_is_current then
    new.content_revision_id := active_content_revision_id;
    new.revision_fence := active_revision_fence;
  elsif new.revision_fence is null then
    new.revision_fence := active_revision_fence;
  end if;

  if new.base_graph_revision_id is not null and not exists (
    select 1
    from character_graph_revisions revision
    where revision.id = new.base_graph_revision_id and revision.book_id = new.book_id
  ) then
    new.base_graph_revision_id := active_graph_revision_id;
  end if;
  return new;
end;
$$;

drop trigger if exists book_ai_workflow_revision_defaults on book_ai_workflows;
create trigger book_ai_workflow_revision_defaults
before insert on book_ai_workflows
for each row execute function fill_book_ai_workflow_revision_defaults();
