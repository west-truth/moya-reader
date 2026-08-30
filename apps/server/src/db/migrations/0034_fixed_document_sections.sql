alter table library_books
  add column if not exists document_section_count integer;

alter table chapters
  add column if not exists document_section_id text,
  add column if not exists document_section_title text,
  add column if not exists document_section_index integer,
  add column if not exists document_page_index_in_section integer;

-- Older self-host imports kept the deterministic page title but discarded the
-- logical series fields. Recover the unambiguous title/page grouping here; the
-- remote Suwayomi id itself is intentionally left null and is recovered by the
-- client only when one remote release has the same title.
with parsed_pages as (
  select c.id,
         c.book_id,
         c.chapter_index,
         btrim((regexp_match(c.title, '^(.*)[[:space:]]*·[[:space:]]*([1-9][0-9]*)페이지[[:space:]]*$'))[1]) as section_title,
         ((regexp_match(c.title, '^(.*)[[:space:]]*·[[:space:]]*([1-9][0-9]*)페이지[[:space:]]*$'))[2])::integer as page_index
    from chapters c
    join library_books b on b.id = c.book_id
   where b.format = 'image_archive'
     and c.document_section_id is null
), section_starts as (
  select book_id, section_title, min(chapter_index) as first_chapter_index
    from parsed_pages
   where section_title is not null
   group by book_id, section_title
), ranked_sections as (
  select book_id,
         section_title,
         dense_rank() over (partition by book_id order by first_chapter_index, section_title)::integer as section_index
    from section_starts
), recovered_pages as (
  select p.id, p.section_title, p.page_index, s.section_index
    from parsed_pages p
    join ranked_sections s using (book_id, section_title)
)
update chapters c
   set document_section_title = recovered.section_title,
       document_section_index = recovered.section_index,
       document_page_index_in_section = recovered.page_index
  from recovered_pages recovered
 where c.id = recovered.id;

update library_books b
   set document_section_count = recovered.section_count
  from (
    select book_id, max(document_section_index)::integer as section_count
      from chapters
     where document_section_title is not null
     group by book_id
  ) recovered
 where b.id = recovered.book_id
   and b.document_section_count is null;
