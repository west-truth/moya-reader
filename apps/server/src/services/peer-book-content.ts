import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { BookImportContentChangeV1 } from '@noveldesk/contracts/sync';
import type { ServerConfig } from '../config.js';
import type { ParsedHostedBackupArchive } from './hosted-backup-archive.js';
import {
  insertHostedBackupRow,
  PEER_BOOK_CONTENT_TABLES,
  restoreHostedBackup,
  restoreSourceObjects,
} from './hosted-backup-service.js';
import { rebuildParagraphSearchFromStoredPages } from './paragraph-search-persistence.js';
import { replaceParsedBookContent } from './import-service.js';
import {
  finalizeBookReplacement,
  prepareBookReplacement,
  restoreExactAnchoredReaderState,
} from './book-revision/service.js';
import { enqueueObjectDeletions, releaseObjectDeletionReservations } from './object-delete-outbox.js';

export interface BookIdentity {
  bookId: string;
  sourceHash: string;
  activeRevisionId: string;
  normalizedTextHash: string;
  chapterIds: string[];
}

export class PeerBookContentError extends Error {}

const revisionIdPattern = /^[A-Za-z0-9:_-]{1,512}$/;
const taggedHashPattern = /^sha256:[0-9a-f]{64}$/;

export function parsePeerBookContentChange(value: unknown): BookImportContentChangeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PeerBookContentError('peer_book_content_change_invalid');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !==
      'baseRevisionId,kind,normalizedHash,revisionNumber,sourceHash,targetRevisionId' ||
    row.kind !== 'revision_v1' ||
    typeof row.baseRevisionId !== 'string' ||
    !revisionIdPattern.test(row.baseRevisionId) ||
    typeof row.targetRevisionId !== 'string' ||
    !revisionIdPattern.test(row.targetRevisionId) ||
    row.baseRevisionId === row.targetRevisionId ||
    !Number.isSafeInteger(row.revisionNumber) ||
    Number(row.revisionNumber) < 2 ||
    typeof row.sourceHash !== 'string' ||
    !taggedHashPattern.test(row.sourceHash) ||
    typeof row.normalizedHash !== 'string' ||
    !taggedHashPattern.test(row.normalizedHash)
  )
    throw new PeerBookContentError('peer_book_content_change_invalid');
  return value as BookImportContentChangeV1;
}

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

function archiveIdentity(parsed: ParsedHostedBackupArchive, bookId: string, initialOnly = true): BookIdentity {
  const books = parsed.tables.get('library_books') ?? [];
  const book = books[0];
  if (
    books.length !== 1 ||
    book.id !== bookId ||
    book.deleted_at ||
    !Number.isSafeInteger(Number(book.content_revision_number)) ||
    Number(book.content_revision_number) < 1 ||
    (initialOnly && Number(book.content_revision_number) !== 1)
  )
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
  const revisions = parsed.tables.get('book_content_revisions') ?? [];
  if (
    revisions.length !== 1 ||
    revisions[0].id !== book.active_content_revision_id ||
    revisions[0].status !== 'active' ||
    revisions[0].source_object_id !== book.object_id ||
    revisions[0].source_raw_text_hash !== source.raw_text_hash ||
    Number(revisions[0].revision_number) !== Number(book.content_revision_number)
  )
    throw new PeerBookContentError('peer_book_revision_invalid');
  return {
    bookId,
    sourceHash: source.raw_text_hash,
    activeRevisionId: String(book.active_content_revision_id),
    normalizedTextHash: String(book.normalized_text_hash),
    chapterIds,
  };
}

/** Replace only canonical content. Reader state stays in the target server and is remapped there. */
export async function restorePeerBookReplacement(
  pool: pg.Pool,
  config: ServerConfig,
  parsed: ParsedHostedBackupArchive,
  bookId: string,
  signal: AbortSignal,
  change: BookImportContentChangeV1,
): Promise<{ installed: boolean; identity: BookIdentity }> {
  const expected = parsePeerBookContentChange(change);
  const identity = archiveIdentity(parsed, bookId, false);
  const book = parsed.tables.get('library_books')![0];
  const source = parsed.objects.find((object) => object.id === book.object_id && object.asset_kind === 'source');
  if (
    !source ||
    !/^[^/\\\x00-\x1f]{1,255}$/.test(source.file_name) ||
    identity.activeRevisionId !== expected.targetRevisionId ||
    identity.sourceHash !== expected.sourceHash ||
    identity.normalizedTextHash !== expected.normalizedHash ||
    Number(book.content_revision_number) !== expected.revisionNumber
  )
    throw new PeerBookContentError('peer_book_identity_changed');
  // First support text revisions. Fixed documents and their assets need their
  // own source/page replacement checks before this boundary can be widened.
  if (
    !['txt', 'markdown'].includes(String(book.format)) ||
    (parsed.tables.get('book_assets') ?? []).length ||
    (parsed.tables.get('document_pages') ?? []).length ||
    (parsed.tables.get('document_text_revisions') ?? []).length ||
    (parsed.tables.get('document_text_blocks') ?? []).length
  )
    throw new PeerBookContentError('peer_book_replacement_format_unsupported');
  const existing = await bookIdentity(pool, config.defaultUserId, bookId);
  if (existing && JSON.stringify(existing) === JSON.stringify(identity)) return { installed: false, identity };
  if (existing?.activeRevisionId !== expected.baseRevisionId)
    throw new PeerBookContentError('peer_book_identity_mismatch');

  const client = await pool.connect();
  const stagedKeys: string[] = [];
  const publishedKeys: string[] = [];
  try {
    signal.throwIfAborted();
    await client.query('begin');
    await client.query("set local statement_timeout = '1h'");
    await client.query('select id from library_books where id=$1 and user_id=$2 for update', [
      bookId,
      config.defaultUserId,
    ]);
    const current = await bookIdentity(client, config.defaultUserId, bookId);
    if (current?.activeRevisionId !== expected.baseRevisionId)
      throw new PeerBookContentError('peer_book_identity_mismatch');
    const objectIds = await restoreSourceObjects(
      pool,
      client,
      config,
      parsed,
      new Set([String(book.object_id)]),
      `${config.defaultUserId}/peer-replacements/${randomUUID().replaceAll('-', '')}`,
      stagedKeys,
      publishedKeys,
      signal,
    );
    const sourceObjectId = objectIds.get(String(book.object_id));
    if (!sourceObjectId) throw new PeerBookContentError('peer_book_source_missing');
    const prepared = await prepareBookReplacement(client, {
      userId: config.defaultUserId,
      bookId,
      sourceObjectId,
      sourceRawTextHash: expected.sourceHash,
      normalizedTextHash: expected.normalizedHash,
      sourceFileName: String(book.source_file_name),
      sourceEncoding: typeof book.source_encoding === 'string' ? book.source_encoding : undefined,
    });
    if (
      !prepared ||
      prepared.replacement.fromContentRevisionId !== expected.baseRevisionId ||
      prepared.replacement.toContentRevisionId !== expected.targetRevisionId ||
      prepared.replacement.toContentRevisionNumber !== expected.revisionNumber
    )
      throw new PeerBookContentError('peer_book_revision_mismatch');
    await client.query(
      `update library_books set object_id=$3, format=$4, source_file_name=$5, source_encoding=$6,
              normalized_text_hash=$7, total_chapters=$8, total_characters=$9,
              total_paragraphs=$10, document_section_count=$11, updated_at=now()
        where id=$1 and user_id=$2`,
      [
        bookId,
        config.defaultUserId,
        sourceObjectId,
        book.format,
        book.source_file_name,
        book.source_encoding ?? null,
        book.normalized_text_hash,
        book.total_chapters,
        book.total_characters,
        book.total_paragraphs,
        book.document_section_count ?? null,
      ],
    );
    await replaceParsedBookContent(client, bookId);
    for (const chapter of parsed.tables.get('chapters') ?? []) await insertHostedBackupRow(client, 'chapters', chapter);
    const pages = parsed.tables.get('paragraph_pages') ?? [];
    for (const page of pages) await insertHostedBackupRow(client, 'paragraph_pages', page);
    await rebuildParagraphSearchFromStoredPages(client, pages);
    await restoreExactAnchoredReaderState(client, prepared);
    await finalizeBookReplacement(client, prepared);
    const restored = await bookIdentity(client, config.defaultUserId, bookId);
    if (JSON.stringify(restored) !== JSON.stringify(identity))
      throw new PeerBookContentError('peer_book_identity_mismatch');
    await releaseObjectDeletionReservations(client, publishedKeys);
    signal.throwIfAborted();
    await client.query('commit');
    return { installed: true, identity };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    await enqueueObjectDeletions(pool, stagedKeys, 'peer_replacement_failed').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
