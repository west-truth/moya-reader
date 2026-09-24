import pg from 'pg';
import type { ServerConfig } from '../config.js';
import type { ParsedHostedBackupArchive } from './hosted-backup-archive.js';
import { PEER_BOOK_CONTENT_TABLES, restoreHostedBackup } from './hosted-backup-service.js';

export interface BookIdentity {
  bookId: string;
  sourceHash: string;
  activeRevisionId: string;
  normalizedTextHash: string;
  chapterIds: string[];
}

export class PeerBookContentError extends Error {}

export async function bookIdentity(
  pool: pg.Pool | pg.PoolClient,
  userId: string,
  bookId: string,
): Promise<BookIdentity | undefined> {
  const result = await pool.query<{
    id: string;
    source_hash: string | null;
    active_revision_id: string | null;
    normalized_text_hash: string;
    chapter_ids: string[];
  }>(
    `select b.id, o.raw_text_hash as source_hash, b.active_content_revision_id as active_revision_id,
            b.normalized_text_hash,
            coalesce(array_agg(c.id order by c.chapter_index) filter (where c.id is not null), '{}'::text[]) as chapter_ids
       from library_books b
       left join book_objects o on o.id = b.object_id
       left join chapters c on c.book_id = b.id
      where b.id = $1 and b.user_id = $2 and b.deleted_at is null
      group by b.id, o.raw_text_hash`,
    [bookId, userId],
  );
  const row = result.rows[0];
  if (!row?.source_hash || !row.active_revision_id || !row.chapter_ids.length) return undefined;
  return {
    bookId: row.id,
    sourceHash: row.source_hash,
    activeRevisionId: row.active_revision_id,
    normalizedTextHash: row.normalized_text_hash,
    chapterIds: row.chapter_ids,
  };
}

function archiveIdentity(parsed: ParsedHostedBackupArchive, bookId: string): BookIdentity {
  const books = parsed.tables.get('library_books') ?? [];
  const book = books[0];
  if (books.length !== 1 || book.id !== bookId || book.deleted_at || Number(book.content_revision_number) !== 1)
    throw new PeerBookContentError('peer_book_initial_content_required');
  for (const [table, rows] of parsed.tables) {
    if (rows.length && !PEER_BOOK_CONTENT_TABLES.has(table))
      throw new PeerBookContentError('peer_book_content_scope_invalid');
    if (table !== 'library_books' && rows.some((row) => row.book_id !== bookId))
      throw new PeerBookContentError('peer_book_content_scope_invalid');
  }
  if (parsed.objects.some((object) => object.asset_kind === 'user_font'))
    throw new PeerBookContentError('peer_book_content_scope_invalid');
  if (
    (parsed.tables.get('book_assets') ?? []).some(
      (asset) => !['cover', 'epub_resource', 'document_page', 'source_part'].includes(String(asset.kind)),
    )
  )
    throw new PeerBookContentError('peer_book_content_scope_invalid');
  const source = parsed.objects.find(
    (object) => object.id === book.object_id && (!object.asset_kind || object.asset_kind === 'source'),
  );
  const chapterIds = [...(parsed.tables.get('chapters') ?? [])]
    .sort((a, b) => Number(a.chapter_index) - Number(b.chapter_index))
    .map((chapter) => String(chapter.id));
  if (!source || !book.active_content_revision_id || !chapterIds.length)
    throw new PeerBookContentError('peer_book_identity_unavailable');
  return {
    bookId,
    sourceHash: source.raw_text_hash,
    activeRevisionId: String(book.active_content_revision_id),
    normalizedTextHash: String(book.normalized_text_hash),
    chapterIds,
  };
}

export async function restorePeerBookContent(
  pool: pg.Pool,
  config: ServerConfig,
  parsed: ParsedHostedBackupArchive,
  bookId: string,
  signal: AbortSignal,
  expected?: BookIdentity,
): Promise<{ installed: boolean; identity: BookIdentity }> {
  const identity = archiveIdentity(parsed, bookId);
  if (expected && JSON.stringify(identity) !== JSON.stringify(expected))
    throw new PeerBookContentError('peer_book_identity_changed');
  const existing = await bookIdentity(pool, config.defaultUserId, bookId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(identity))
      throw new PeerBookContentError('peer_book_identity_mismatch');
    return { installed: false, identity: existing };
  }
  await restoreHostedBackup(pool, config, parsed, { defaultConflictResolution: 'skip' }, signal, {
    beforeRestore: async (client) => {
      // Recheck absence under the same lock used by the initial-copy restore.
      // A concurrent import must never turn this into a replace or partial merge.
      await client.query('lock table library_books in share row exclusive mode');
      const occupied = await client.query('select id from library_books where id = $1', [bookId]);
      if (occupied.rows.length) throw new PeerBookContentError('peer_book_target_changed');
    },
    beforeCommit: async (client) => {
      const restored = await bookIdentity(client, config.defaultUserId, bookId);
      if (JSON.stringify(restored) !== JSON.stringify(identity))
        throw new PeerBookContentError('peer_book_identity_mismatch');
    },
  });
  return { installed: true, identity };
}
