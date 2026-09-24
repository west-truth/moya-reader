import { persistentId128 } from '@noveldesk/text-core/hash';
import type { QueryRunner } from '../ai/sync-event-repository.js';

// Imported PDF/CBZ books have chapters and source assets, but currently do not
// materialize document_pages. Derive the same immutable page identity as the reader.
export async function documentPageHash(
  db: QueryRunner,
  bookId: string,
  pageIndex: number,
  userId?: string,
): Promise<string | undefined> {
  const result = await db.query<{
    format: string;
    raw_text_hash: string | null;
    chapter_id: string | null;
    asset_id: string | null;
  }>(
    `select b.format, o.raw_text_hash,
            (select c.id from chapters c where c.book_id = b.id
             order by c.chapter_index limit 1 offset $2) as chapter_id,
            (select a.id from book_assets a where a.book_id = b.id and a.kind = 'document_page'
             and a.page_index = $2 and a.status = 'active' limit 1) as asset_id
     from library_books b
     left join book_objects o on o.id = b.object_id
     where b.id = $1 and b.deleted_at is null and ($3::text is null or b.user_id = $3)`,
    [bookId, pageIndex, userId ?? null],
  );
  const row = result.rows[0];
  if (!row?.chapter_id) return undefined;
  if (row.format === 'pdf' && row.raw_text_hash) return `${row.raw_text_hash}:pdf-page:${pageIndex}`;
  if (row.format === 'image_archive' && row.asset_id) {
    return persistentId128('archive_thumbnail_asset_v2', [row.asset_id, String(pageIndex)]);
  }
  return undefined;
}
