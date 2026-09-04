-- Hosted search is always scoped to one book or chapter. In the personal self-host
-- workload, the scope indexes keep bounded scans fast while avoiding the large
-- import/WAL cost of maintaining a global trigram GIN index.
drop index if exists idx_paragraph_search_text_trgm;
