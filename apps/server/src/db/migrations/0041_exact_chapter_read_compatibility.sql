-- Add read identities to pre-section comic imports. Do not rewrite source files,
-- chapter ids, offsets, revisions or already-known remote section ids.
update chapters c
   set document_section_id = 'local-section:' || c.book_id || ':' || c.document_section_index::text
  from library_books b
 where b.id = c.book_id and b.format = 'image_archive'
   and c.document_section_id is null and c.document_section_index is not null;

-- An old unsectioned archive is one reading unit, not one unit per image.
update chapters c
   set document_section_id = 'local-legacy:' || c.book_id
  from library_books b
 where b.id = c.book_id and b.format = 'image_archive'
   and c.document_section_id is null
   and not exists (select 1 from chapters section where section.book_id = c.book_id and section.document_section_id is not null);

-- Retain the existing table/wire field names for rollback compatibility. The key
-- is an imported comic section id, or the chapter id for TXT/EPUB/PDF.
-- Only the one proven reading position is recoverable; never infer earlier reads.
insert into fixed_document_section_read_states (book_id, user_id, document_section_id, last_read_at)
select rp.book_id, rp.user_id, coalesce(c.document_section_id, c.id), rp.updated_at
  from reading_positions rp
  join chapters c on c.id = rp.chapter_id and c.book_id = rp.book_id
on conflict (book_id, user_id, document_section_id) do update
  set last_read_at = greatest(fixed_document_section_read_states.last_read_at, excluded.last_read_at);
