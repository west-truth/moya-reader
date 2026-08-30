create index if not exists idx_paragraph_pages_book_chapter_page
  on paragraph_pages(book_id, chapter_id, page_index);

create index if not exists idx_sync_events_conflict_lookup
  on sync_events(user_id, book_id, type, entity_id, sequence desc);
