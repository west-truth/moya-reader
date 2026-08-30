create table if not exists fixed_document_section_read_states (
  book_id text not null references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  document_section_id text not null,
  last_read_at timestamptz not null,
  primary key (book_id, user_id, document_section_id)
);

create index if not exists idx_fixed_document_section_read_states_user
  on fixed_document_section_read_states(user_id, last_read_at desc);

-- The previous schema only retained one book-level reading position. Preserve
-- that exact current section during migration without guessing that skipped
-- earlier sections were read.
insert into fixed_document_section_read_states (book_id, user_id, document_section_id, last_read_at)
select rp.book_id, rp.user_id, c.document_section_id, rp.updated_at
  from reading_positions rp
  join chapters c on c.id = rp.chapter_id and c.book_id = rp.book_id
 where c.document_section_id is not null
on conflict (book_id, user_id, document_section_id) do update
  set last_read_at = greatest(fixed_document_section_read_states.last_read_at, excluded.last_read_at);
