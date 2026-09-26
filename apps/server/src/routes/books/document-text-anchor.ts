import type { QueryRunner } from '../ai/sync-event-repository.js';

type Anchor = Record<string, unknown>;

/** A text block id alone is not enough: it must belong to the active page bytes. */
export async function validDocumentTextAnchor(
  db: QueryRunner,
  bookId: string,
  pageIndex: number,
  pageHash: string,
  anchor: Anchor,
): Promise<boolean> {
  if (anchor.kind !== 'fixed_text') return true;
  const revisionId = anchor.textRevisionId;
  const ranges =
    Array.isArray(anchor.blockRanges) && anchor.blockRanges.length
      ? anchor.blockRanges
      : [{ blockId: anchor.blockId, startOffset: anchor.startOffset, endOffset: anchor.endOffset }];
  if (typeof revisionId !== 'string' || !revisionId || ranges.length > 512) return false;
  const revision = await db.query<{ page_hash: string }>(
    `select page_hash from document_text_revisions
     where id = $1 and book_id = $2 and page_index = $3 and status = 'ready'`,
    [revisionId, bookId, pageIndex],
  );
  if (revision.rows[0]?.page_hash !== pageHash) return false;
  const ids = ranges.map((item) => (item && typeof item === 'object' ? (item as Anchor).blockId : undefined));
  if (ids.some((id) => typeof id !== 'string' || !id)) return false;
  const blocks = await db.query<{ id: string; text: string }>(
    `select id, text from document_text_blocks
     where revision_id = $1 and book_id = $2 and page_index = $3 and id = any($4::text[])`,
    [revisionId, bookId, pageIndex, ids],
  );
  const lengths = new Map(blocks.rows.map((row) => [row.id, row.text.length]));
  return ranges.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const range = item as Anchor;
    const length = lengths.get(String(range.blockId));
    const start = Number(range.startOffset);
    const end = Number(range.endOffset);
    return (
      length !== undefined &&
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      end >= start &&
      end <= length
    );
  });
}
