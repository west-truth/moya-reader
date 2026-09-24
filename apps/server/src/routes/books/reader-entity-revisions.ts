import { resourceEntityRevision } from '@noveldesk/text-core/identity/sync';
import type { QueryRunner } from '../ai/sync-event-repository.js';

export type ReaderEntityKind = 'bookmark' | 'highlight' | 'note' | 'document_annotation';

function iso(value: unknown): string {
  return new Date(value as string).toISOString();
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function entityValue(kind: ReaderEntityKind, row: Record<string, unknown>) {
  if (kind === 'document_annotation') {
    return {
      id: String(row.id),
      bookId: String(row.book_id),
      pageIndex: Number(row.page_index),
      type: String(row.annotation_type),
      anchor: row.anchor,
      ...(row.quote == null ? {} : { quote: String(row.quote) }),
      ...(row.body == null ? {} : { body: String(row.body) }),
      ...(row.color == null ? {} : { color: String(row.color) }),
      ...(row.text_anchor_remap == null ? {} : { textAnchorRemap: row.text_anchor_remap }),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
  const common = {
    id: String(row.id),
    novelId: String(row.book_id),
    chapterId: String(row.chapter_id),
    paragraphId: optional(row.paragraph_id),
    progress: Number(row.progress),
    createdAt: iso(row.created_at),
  };
  if (kind === 'bookmark') {
    return { ...common, label: String(row.label), scrollTop: Number(row.scroll_top) };
  }
  if (kind === 'highlight') {
    return {
      ...common,
      paragraphId: String(row.paragraph_id),
      quote: String(row.quote),
      color: String(row.color),
      updatedAt: iso(row.updated_at),
    };
  }
  return {
    ...common,
    quote: optional(row.quote),
    body: String(row.body),
    updatedAt: iso(row.updated_at),
  };
}

const tables = {
  bookmark: 'bookmarks',
  highlight: 'highlights',
  note: 'notes',
  document_annotation: 'document_annotations',
} as const;

export async function readerEntityValue(
  db: QueryRunner,
  userId: string,
  kind: ReaderEntityKind,
  id: string,
): Promise<ReturnType<typeof entityValue> | undefined> {
  const result = await db.query(`select * from ${tables[kind]} where id = $1 and user_id = $2 and deleted_at is null`, [
    id,
    userId,
  ]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? entityValue(kind, row) : undefined;
}

/** The tombstone is a distinct state, so a late creation cannot treat a deletion as absence. */
export async function readerEntityRevision(
  db: QueryRunner,
  userId: string,
  kind: ReaderEntityKind,
  id: string,
  includeTombstone = true,
): Promise<string> {
  const result = await db.query(`select * from ${tables[kind]} where id = $1 and user_id = $2`, [id, userId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row || (row.deleted_at && !includeTombstone)) return resourceEntityRevision(kind, undefined);
  return resourceEntityRevision(kind, row.deleted_at ? { id, deletedAt: iso(row.deleted_at) } : entityValue(kind, row));
}

export async function activeBookContentRevisionId(db: QueryRunner, userId: string, bookId: string): Promise<string> {
  const result = await db.query<{ active_content_revision_id: string | null }>(
    'select active_content_revision_id from library_books where id = $1 and user_id = $2',
    [bookId, userId],
  );
  const id = result.rows[0]?.active_content_revision_id;
  if (!id) throw new Error('book content revision not found');
  return id;
}
