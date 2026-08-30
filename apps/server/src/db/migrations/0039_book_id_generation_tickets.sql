-- A canonical book id can be deleted and later reused. Keep an identity
-- generation outside library_books so queued work can prove that it still
-- targets the same incarnation even after the canonical row was purged.
create table if not exists book_id_generations (
  user_id text not null references users(id) on delete cascade,
  book_id text not null,
  generation bigint not null check (generation >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

insert into book_id_generations (user_id, book_id, generation)
select user_id, book_id, greatest(count(*)::bigint + 1, 2)
  from sync_events
 where book_id is not null and type = 'book_purged'
 group by user_id, book_id
on conflict (user_id, book_id) do update
  set generation = greatest(book_id_generations.generation, excluded.generation),
      updated_at = now();

insert into book_id_generations (user_id, book_id, generation)
select user_id, id, 1 from library_books
on conflict (user_id, book_id) do update
  set generation = greatest(book_id_generations.generation, excluded.generation),
      updated_at = now();

create or replace function advance_book_id_generation()
returns trigger
language plpgsql
as $$
declare
  target_user_id text;
  target_book_id text;
begin
  target_user_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  target_book_id := case when tg_op = 'DELETE' then old.id else new.id end;

  -- A user cascade removes both the canonical book and this ledger. Do not
  -- recreate a child row after its parent user has already been deleted.
  if tg_op = 'DELETE' and not exists (select 1 from users where id = target_user_id) then
    return old;
  end if;

  insert into book_id_generations (user_id, book_id, generation)
  values (target_user_id, target_book_id, 1)
  on conflict (user_id, book_id) do update
    set generation = book_id_generations.generation + 1,
        updated_at = now();

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_library_books_advance_id_generation on library_books;
create trigger trg_library_books_advance_id_generation
after insert or delete on library_books
for each row execute function advance_book_id_generation();

alter table upload_sessions
  add column if not exists target_book_generation bigint,
  add column if not exists target_active_content_revision_id text;

alter table upload_sessions
  drop constraint if exists upload_sessions_target_book_generation_check;

alter table upload_sessions
  add constraint upload_sessions_target_book_generation_check
  check (target_book_generation is null or target_book_generation >= 0);
