-- A deterministic external-series book id can be purged and later reused.
-- Content revision ids are optimistic-concurrency fences, so they must never
-- be reused by a later incarnation of the same canonical book id.
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

  revision_id := 'content_revision:initial:' || new.id || ':' || gen_random_uuid()::text;
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
  );

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
