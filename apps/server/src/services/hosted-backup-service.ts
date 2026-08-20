import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ServerConfig } from '../config.js';
import { createEmptyVoiceCastingState } from '../../../../src/providers/voice-casting/state';
import { createS3Client, getObjectBuffer, putRawBookObject } from './object-storage.js';
import {
  enqueueObjectDeletions,
  releaseObjectDeletionReservations,
  reserveObjectDeletions,
} from './object-delete-outbox.js';
import {
  createHostedBackupStream,
  HOSTED_BACKUP_BOOK_TABLES,
  HOSTED_BACKUP_GLOBAL_TABLES,
  HOSTED_BACKUP_TABLES,
  type HostedBackupBook,
  type HostedBackupManifestV1,
  type HostedBackupStreamResult,
  type HostedBackupTableName,
  type HostedBookObjectRow,
  parseHostedBackupArchive,
} from './hosted-backup-archive.js';

export type HostedBackupConflictResolution = 'skip' | 'replace' | 'copy';

export interface HostedBackupConflict {
  readonly bookId: string;
  readonly title: string;
  readonly existingTitle: string;
}

export interface HostedBackupInspection {
  readonly manifest: HostedBackupManifestV1;
  readonly conflicts: HostedBackupConflict[];
  readonly archiveByteLength: number;
  readonly totalUncompressedBytes: number;
  readonly warnings: string[];
}

export interface HostedBackupRestoreOptions {
  readonly defaultConflictResolution: HostedBackupConflictResolution;
  readonly conflictResolutions?: Readonly<Record<string, HostedBackupConflictResolution>>;
}

export interface HostedBackupRestoreResult {
  readonly restoredBooks: number;
  readonly skippedBooks: number;
  readonly copiedBooks: number;
  readonly restoredEntries: number;
}

interface SupersededRestoreObjects {
  readonly storageKeys: Set<string>;
  readonly sourceObjects: Map<string, string>;
}

const APP_VERSION = '0.1.0';

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function normalizedHash(value: string): string {
  if (/^sha256:[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(value)) return `sha256:${value.toLowerCase()}`;
  throw new Error('Source object hash is not SHA-256');
}

function rowBookId(table: HostedBackupTableName, row: Record<string, unknown>): string | undefined {
  const value = table === 'library_books' ? row.id : row.book_id;
  return typeof value === 'string' && value ? value : undefined;
}

function rekeyValue(value: unknown, maps: readonly ReadonlyMap<string, string>[]): unknown {
  if (typeof value === 'string') {
    for (const map of maps) {
      const replacement = map.get(value);
      if (replacement) return replacement;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => rekeyValue(item, maps));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, rekeyValue(child, maps)]),
  );
}

function collectNestedIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNestedIds(item, ids));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'id' || key === 'storageId' || key === 'operationId') && typeof child === 'string' && child) {
      ids.add(child);
    }
    collectNestedIds(child, ids);
  }
}

function copyIdMap(
  bookId: string,
  tables: ReadonlyMap<HostedBackupTableName, Record<string, unknown>[]>,
): ReadonlyMap<string, string> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const ids = new Set<string>([bookId]);
  for (const [table, rows] of tables) {
    for (const row of rows) {
      if (rowBookId(table, row) !== bookId) continue;
      collectNestedIds(row, ids);
      if (table === 'character_identity_operation_receipts_v2' && typeof row.operation_id === 'string') {
        ids.add(row.operation_id);
      }
    }
  }
  return new Map(Array.from(ids, (id) => [id, `${id}__copy_${suffix}`]));
}

function resolutionFor(
  bookId: string,
  conflicts: ReadonlySet<string>,
  options: HostedBackupRestoreOptions,
): HostedBackupConflictResolution | undefined {
  if (!conflicts.has(bookId)) return undefined;
  return options.conflictResolutions?.[bookId] ?? options.defaultConflictResolution;
}

function invalidateRestoredVoiceCasting(row: Record<string, unknown>): void {
  const payload = row.state_payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Backup voice casting state is invalid');
  }
  const contentRevisionId = (payload as Record<string, unknown>).contentRevisionId;
  if (typeof row.book_id !== 'string' || typeof contentRevisionId !== 'string' || !contentRevisionId) {
    throw new Error('Backup voice casting scope is invalid');
  }
  row.state_payload = createEmptyVoiceCastingState({
    bookId: row.book_id,
    contentRevisionId,
    status: 'staging',
  });
  row.derived_payload = {
    importanceProfiles: [],
    traitEvidence: [],
    traitProfiles: [],
    pools: [],
  };
}

function bookRows(parsed: Awaited<ReturnType<typeof parseHostedBackupArchive>>): Record<string, unknown>[] {
  return parsed.tables.get('library_books') ?? [];
}

async function existingBookTitles(
  pool: pg.Pool | pg.PoolClient,
  userId: string,
  bookIds: readonly string[],
): Promise<Map<string, string>> {
  if (bookIds.length === 0) return new Map();
  const result = await pool.query('select id, title from library_books where user_id = $1 and id = any($2::text[])', [
    userId,
    bookIds,
  ]);
  return new Map(result.rows.map((row) => [String(row.id), String(row.title)]));
}

async function snapshotHostedData(pool: pg.Pool, userId: string) {
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const catalog = await client.query('select * from library_books where user_id = $1 order by created_at, id', [
      userId,
    ]);
    const bookIds = catalog.rows.map((row) => String(row.id));
    const tables = new Map<HostedBackupTableName, readonly Record<string, unknown>[]>();
    tables.set('library_books', catalog.rows);
    for (const table of HOSTED_BACKUP_BOOK_TABLES) {
      if (table === 'library_books') continue;
      const result =
        bookIds.length === 0
          ? { rows: [] }
          : await client.query(
              `select * from ${quoteIdentifier(table)} where book_id = any($1::text[])${
                table === 'book_assets' ? " and status = 'active'" : ''
              }`,
              [bookIds],
            );
      tables.set(table, result.rows);
    }
    for (const table of HOSTED_BACKUP_GLOBAL_TABLES) {
      const result = await client.query(`select * from ${quoteIdentifier(table)} where user_id = $1`, [userId]);
      tables.set(table, result.rows);
    }
    const objectIds = catalog.rows.map((row) => row.object_id).filter((value): value is string => Boolean(value));
    const sourceObjects =
      objectIds.length === 0
        ? []
        : (
            await client.query<HostedBookObjectRow>(
              `select id, raw_text_hash, storage_key, file_name, content_type, size_bytes, created_at
               from book_objects where id = any($1::text[]) order by id`,
              [objectIds],
            )
          ).rows.map((row) => ({ ...row, asset_kind: 'source' as const }));
    const embeddedAssets = (tables.get('book_assets') ?? [])
      .filter(
        (row) =>
          (row.kind === 'cover' || row.kind === 'epub_resource' || row.kind === 'document_page') &&
          row.status === 'active',
      )
      .map(
        (row) =>
          ({
            id: String(row.id),
            raw_text_hash: String(row.content_hash),
            storage_key: String(row.storage_key),
            file_name: String(row.file_name ?? 'cover'),
            content_type: String(row.content_type ?? 'image/jpeg'),
            size_bytes: Number(row.byte_length),
            created_at: row.created_at as string | Date,
            asset_kind: row.kind as 'cover' | 'epub_resource' | 'document_page',
          }) satisfies HostedBookObjectRow,
      );
    const fontAssets = (tables.get('user_fonts') ?? []).map(
      (row) =>
        ({
          id: String(row.id),
          raw_text_hash: String(row.content_hash),
          storage_key: String(row.storage_key),
          file_name: String(row.file_name),
          content_type: String(row.content_type),
          size_bytes: Number(row.byte_length),
          created_at: row.created_at as string | Date,
          asset_kind: 'user_font',
        }) satisfies HostedBookObjectRow,
    );
    const objects = [...sourceObjects, ...embeddedAssets, ...fontAssets];
    await client.query('commit');
    const books: HostedBackupBook[] = catalog.rows.map((row) => ({
      id: String(row.id),
      format: String(row.format ?? 'txt'),
      activeContentRevisionId: row.active_content_revision_id ? String(row.active_content_revision_id) : undefined,
      title: String(row.title),
    }));
    return { tables, objects, books, exportedAt: new Date().toISOString(), appVersion: APP_VERSION };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function exportHostedBackup(pool: pg.Pool, config: ServerConfig): Promise<HostedBackupStreamResult> {
  const snapshot = await snapshotHostedData(pool, config.defaultUserId);
  const s3 = createS3Client(config);
  return createHostedBackupStream(snapshot, async (object) => {
    const stored = await getObjectBuffer(s3, config, object.storage_key);
    return stored.body;
  });
}

export async function inspectHostedBackup(
  pool: pg.Pool,
  config: ServerConfig,
  archive: Uint8Array,
): Promise<HostedBackupInspection> {
  const parsed = await parseHostedBackupArchive(archive);
  const books = bookRows(parsed);
  const ids = books.map((row) => String(row.id));
  const existing = await existingBookTitles(pool, config.defaultUserId, ids);
  return {
    manifest: parsed.manifest,
    conflicts: parsed.manifest.books.flatMap((book) => {
      const existingTitle = existing.get(book.id);
      return existingTitle ? [{ bookId: book.id, title: book.title, existingTitle }] : [];
    }),
    archiveByteLength: archive.byteLength,
    totalUncompressedBytes: parsed.totalUncompressedBytes,
    warnings: [],
  };
}

async function insertRow(client: pg.PoolClient, table: HostedBackupTableName, row: Record<string, unknown>) {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const columns = entries.map(([column]) => quoteIdentifier(column));
  const values = entries.map(([, value]) => value);
  const placeholders = values.map((_, index) => `$${index + 1}`);
  if (table === 'reader_settings') {
    await client.query(
      `insert into ${quoteIdentifier(table)} (${columns.join(', ')}) values (${placeholders.join(', ')})
       on conflict (user_id) do update set settings = excluded.settings, updated_at = excluded.updated_at`,
      values,
    );
    return;
  }
  if (table === 'user_fonts') {
    await client.query(
      `insert into ${quoteIdentifier(table)} (${columns.join(', ')}) values (${placeholders.join(', ')})
       on conflict (id) do update set family_label = excluded.family_label, file_name = excluded.file_name,
         style = excluded.style, weight = excluded.weight, content_hash = excluded.content_hash,
         content_type = excluded.content_type, byte_length = excluded.byte_length, storage_key = excluded.storage_key,
         license_note = excluded.license_note, updated_at = excluded.updated_at`,
      values,
    );
    return;
  }
  await client.query(
    `insert into ${quoteIdentifier(table)} (${columns.join(', ')}) values (${placeholders.join(', ')})
     on conflict do nothing`,
    values,
  );
}

function sourceObjectsById(objects: readonly HostedBookObjectRow[]): Map<string, HostedBookObjectRow> {
  const result = new Map<string, HostedBookObjectRow>();
  for (const object of objects) {
    if (!object.id || result.has(object.id)) throw new Error('Backup source object identities are invalid');
    result.set(object.id, object);
  }
  return result;
}

async function restoreSourceObjects(
  pool: pg.Pool,
  client: pg.PoolClient,
  config: ServerConfig,
  parsed: Awaited<ReturnType<typeof parseHostedBackupArchive>>,
  requiredObjectIds: ReadonlySet<string>,
  restorePrefix: string,
  stagedKeys: string[],
  publishedKeys: string[],
): Promise<ReadonlyMap<string, string>> {
  const sourceObjects = sourceObjectsById(parsed.objects);
  const objectIdMap = new Map<string, string>();
  const s3 = createS3Client(config);
  for (const archivedObjectId of requiredObjectIds) {
    const object = sourceObjects.get(archivedObjectId);
    const bytes = parsed.assetBlobs.get(archivedObjectId);
    const asset = parsed.manifest.assetBlobs.find((item) => item.storageKey === archivedObjectId);
    if (!object || !bytes || !asset || normalizedHash(object.raw_text_hash) !== asset.contentHash) {
      throw new Error(`Backup source object is incomplete: ${archivedObjectId}`);
    }
    const existing = await client.query('select id from book_objects where raw_text_hash = $1', [object.raw_text_hash]);
    if (existing.rows[0]) {
      objectIdMap.set(archivedObjectId, String(existing.rows[0].id));
      continue;
    }
    const idConflict = await client.query('select 1 from book_objects where id = $1', [archivedObjectId]);
    const targetObjectId = idConflict.rows[0] ? `book_object_${randomUUID().replaceAll('-', '')}` : archivedObjectId;
    const storageKey = `${restorePrefix}/sources/${targetObjectId}/${object.file_name}`;
    await reserveObjectDeletions(pool, [storageKey], 'backup_restore_staging');
    stagedKeys.push(storageKey);
    await putRawBookObject(s3, config, storageKey, bytes, object.content_type);
    const inserted = await client.query(
      `insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (raw_text_hash) do update set raw_text_hash = excluded.raw_text_hash
       returning id, storage_key`,
      [
        targetObjectId,
        object.raw_text_hash,
        storageKey,
        object.file_name,
        object.content_type,
        Number(object.size_bytes),
        object.created_at,
      ],
    );
    const actualId = String(inserted.rows[0].id);
    objectIdMap.set(archivedObjectId, actualId);
    if (String(inserted.rows[0].storage_key) !== storageKey) {
      await enqueueObjectDeletions(pool, [storageKey], 'backup_restore_deduplicated');
    } else {
      publishedKeys.push(storageKey);
    }
  }
  return objectIdMap;
}

async function restoreEmbeddedBookObjects(
  pool: pg.Pool,
  config: ServerConfig,
  parsed: Awaited<ReturnType<typeof parseHostedBackupArchive>>,
  resolutions: ReadonlyMap<string, HostedBackupConflictResolution | undefined>,
  copyMaps: ReadonlyMap<string, ReadonlyMap<string, string>>,
  restorePrefix: string,
  stagedKeys: string[],
  publishedKeys: string[],
): Promise<ReadonlyMap<string, string>> {
  const objects = sourceObjectsById(parsed.objects);
  const storageKeys = new Map<string, string>();
  const s3 = createS3Client(config);
  for (const row of parsed.tables.get('book_assets') ?? []) {
    if (
      (row.kind !== 'cover' && row.kind !== 'epub_resource' && row.kind !== 'document_page') ||
      row.status !== 'active'
    )
      continue;
    const archivedAssetId = String(row.id);
    const archivedBookId = String(row.book_id);
    if (resolutions.get(archivedBookId) === 'skip') continue;
    const object = objects.get(archivedAssetId);
    const bytes = parsed.assetBlobs.get(archivedAssetId);
    if (!object || object.asset_kind !== row.kind || !bytes) {
      throw new Error(`Backup embedded book asset is incomplete: ${archivedAssetId}`);
    }
    const copyMap = copyMaps.get(archivedBookId);
    const targetBookId = copyMap?.get(archivedBookId) ?? archivedBookId;
    const targetAssetId = copyMap?.get(archivedAssetId) ?? archivedAssetId;
    const folder = row.kind === 'cover' ? 'covers' : row.kind === 'document_page' ? 'pages' : 'epub';
    const storageKey = `${restorePrefix}/books/${targetBookId}/${folder}/${targetAssetId}/${object.file_name}`;
    await reserveObjectDeletions(pool, [storageKey], 'backup_restore_staging');
    stagedKeys.push(storageKey);
    await putRawBookObject(s3, config, storageKey, bytes, object.content_type);
    publishedKeys.push(storageKey);
    storageKeys.set(archivedAssetId, storageKey);
  }
  return storageKeys;
}

async function restoreUserFontObjects(
  pool: pg.Pool,
  config: ServerConfig,
  parsed: Awaited<ReturnType<typeof parseHostedBackupArchive>>,
  restorePrefix: string,
  stagedKeys: string[],
  publishedKeys: string[],
): Promise<ReadonlyMap<string, string>> {
  const objects = sourceObjectsById(parsed.objects);
  const storageKeys = new Map<string, string>();
  const s3 = createS3Client(config);
  for (const row of parsed.tables.get('user_fonts') ?? []) {
    const id = String(row.id);
    const object = objects.get(id);
    const bytes = parsed.assetBlobs.get(id);
    if (!object || object.asset_kind !== 'user_font' || !bytes) {
      throw new Error(`Backup user font is incomplete: ${id}`);
    }
    const storageKey = `${restorePrefix}/fonts/${id}/${object.file_name}`;
    await reserveObjectDeletions(pool, [storageKey], 'backup_restore_staging');
    stagedKeys.push(storageKey);
    await putRawBookObject(s3, config, storageKey, bytes, object.content_type);
    publishedKeys.push(storageKey);
    storageKeys.set(id, storageKey);
  }
  return storageKeys;
}

async function collectSupersededRestoreObjects(
  client: pg.PoolClient,
  userId: string,
  replacedBookIds: readonly string[],
  fontIds: readonly string[],
): Promise<SupersededRestoreObjects> {
  const storageKeys = new Set<string>();
  const sourceObjects = new Map<string, string>();
  if (replacedBookIds.length > 0) {
    const assets = await client.query(
      `select a.storage_key
       from book_assets a
       join library_books b on b.id = a.book_id
       where b.user_id = $1 and b.id = any($2::text[]) and a.storage_key is not null`,
      [userId, replacedBookIds],
    );
    for (const row of assets.rows) {
      if (typeof row.storage_key === 'string' && row.storage_key) storageKeys.add(row.storage_key);
    }
    const sources = await client.query(
      `select o.id, o.storage_key
       from book_objects o
       join library_books b on b.object_id = o.id
       where b.user_id = $1 and b.id = any($2::text[])`,
      [userId, replacedBookIds],
    );
    for (const row of sources.rows) {
      if (typeof row.id === 'string' && typeof row.storage_key === 'string' && row.storage_key) {
        sourceObjects.set(row.id, row.storage_key);
      }
    }
  }
  if (fontIds.length > 0) {
    const fonts = await client.query(
      `select storage_key from user_fonts where user_id = $1 and id = any($2::text[]) and storage_key is not null`,
      [userId, fontIds],
    );
    for (const row of fonts.rows) {
      if (typeof row.storage_key === 'string' && row.storage_key) storageKeys.add(row.storage_key);
    }
  }
  return { storageKeys, sourceObjects };
}

async function enqueueSupersededRestoreObjects(
  client: pg.PoolClient,
  candidates: SupersededRestoreObjects,
): Promise<void> {
  const storageKeys = new Set(candidates.storageKeys);
  for (const [objectId, storageKey] of candidates.sourceObjects) {
    const removed = await client.query(
      `delete from book_objects o
       where o.id = $1
         and not exists (select 1 from library_books b where b.object_id = o.id)
       returning o.storage_key`,
      [objectId],
    );
    if (removed.rows[0]?.storage_key === storageKey) storageKeys.add(storageKey);
  }
  await enqueueObjectDeletions(client, storageKeys, 'backup_restore_superseded');
}

async function finalizeRestoreReservations(client: pg.PoolClient, publishedKeys: readonly string[]): Promise<void> {
  if (publishedKeys.length === 0) return;
  const result = await client.query<{ storage_key: string }>(
    `select storage_key from book_objects where storage_key = any($1::text[])
     union
     select storage_key from book_assets where storage_key = any($1::text[])
     union
     select storage_key from user_fonts where storage_key = any($1::text[])`,
    [publishedKeys],
  );
  const referenced = new Set(result.rows.map((row) => row.storage_key));
  const unreferenced = publishedKeys.filter((key) => !referenced.has(key));
  await enqueueObjectDeletions(client, unreferenced, 'backup_restore_unreferenced');
  await releaseObjectDeletionReservations(
    client,
    publishedKeys.filter((key) => referenced.has(key)),
  );
}

export async function restoreHostedBackup(
  pool: pg.Pool,
  config: ServerConfig,
  archive: Uint8Array,
  options: HostedBackupRestoreOptions,
): Promise<HostedBackupRestoreResult> {
  const parsed = await parseHostedBackupArchive(archive);
  const books = bookRows(parsed);
  const bookIds = books.map((row) => String(row.id));
  const client = await pool.connect();
  const stagedKeys: string[] = [];
  const publishedKeys: string[] = [];
  const restorePrefix = `${config.defaultUserId}/backup-restores/${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('begin');
    const existing = await existingBookTitles(client, config.defaultUserId, bookIds);
    const conflicts = new Set(existing.keys());
    const resolutions = new Map(bookIds.map((bookId) => [bookId, resolutionFor(bookId, conflicts, options)] as const));
    const replacedBookIds = bookIds.filter((bookId) => resolutions.get(bookId) === 'replace');
    const fontIds = (parsed.tables.get('user_fonts') ?? [])
      .map((row) => row.id)
      .filter((value): value is string => typeof value === 'string' && Boolean(value));
    const supersededObjects = await collectSupersededRestoreObjects(
      client,
      config.defaultUserId,
      replacedBookIds,
      fontIds,
    );
    const copyMaps = new Map<string, ReadonlyMap<string, string>>();
    for (const [bookId, resolution] of resolutions) {
      if (resolution === 'copy') copyMaps.set(bookId, copyIdMap(bookId, parsed.tables));
      if (resolution === 'replace') {
        await client.query('delete from library_books where id = $1 and user_id = $2', [bookId, config.defaultUserId]);
      }
    }

    const requiredObjectIds = new Set<string>();
    for (const row of books) {
      const bookId = String(row.id);
      if (resolutions.get(bookId) === 'skip') continue;
      if (typeof row.object_id === 'string' && row.object_id) requiredObjectIds.add(row.object_id);
    }
    const objectIdMap = await restoreSourceObjects(
      pool,
      client,
      config,
      parsed,
      requiredObjectIds,
      restorePrefix,
      stagedKeys,
      publishedKeys,
    );
    const embeddedStorageKeys = await restoreEmbeddedBookObjects(
      pool,
      config,
      parsed,
      resolutions,
      copyMaps,
      restorePrefix,
      stagedKeys,
      publishedKeys,
    );
    const fontStorageKeys = await restoreUserFontObjects(
      pool,
      config,
      parsed,
      restorePrefix,
      stagedKeys,
      publishedKeys,
    );
    const activeContentRevisions = new Map<string, string>();
    const activeCoverAssets = new Map<string, string>();
    let restoredEntries = 0;

    for (const table of HOSTED_BACKUP_TABLES) {
      const rows = parsed.tables.get(table) ?? [];
      for (const original of rows) {
        const archivedBookId = rowBookId(table, original);
        if (archivedBookId && resolutions.get(archivedBookId) === 'skip') continue;
        // Superseded assets are not reachable through the hosted reader and
        // self-generated backups do not include their object bytes. Older
        // archives may still contain those metadata rows, so ignore them
        // instead of turning an otherwise valid restore into a missing-blob
        // failure.
        if (table === 'book_assets' && original.status !== 'active') continue;
        const copyMap = archivedBookId ? copyMaps.get(archivedBookId) : undefined;
        // Voice-casting artifact identities include book/content IDs in their fingerprints.
        // A copied book must rebuild them instead of persisting mechanically rekeyed artifacts.
        if (table === 'voice_casting_states' && copyMap) continue;
        const transformed = rekeyValue(original, [copyMap ?? new Map(), objectIdMap]) as Record<string, unknown>;
        if ('user_id' in transformed) transformed.user_id = config.defaultUserId;
        if (table === 'voice_casting_states') invalidateRestoredVoiceCasting(transformed);
        if (table === 'library_books') {
          const targetBookId = String(transformed.id);
          if (typeof transformed.active_content_revision_id === 'string') {
            activeContentRevisions.set(targetBookId, transformed.active_content_revision_id);
          }
          transformed.active_content_revision_id = null;
          if (typeof transformed.cover_asset_id === 'string') {
            activeCoverAssets.set(targetBookId, transformed.cover_asset_id);
          }
          transformed.cover_asset_id = null;
          if (copyMap && typeof transformed.title === 'string') transformed.title = `${transformed.title} (복사본)`;
        }
        if (
          table === 'book_assets' &&
          (original.kind === 'cover' || original.kind === 'epub_resource' || original.kind === 'document_page')
        ) {
          const storageKey = embeddedStorageKeys.get(String(original.id));
          if (!storageKey) throw new Error(`Backup embedded asset storage is missing: ${String(original.id)}`);
          transformed.storage_key = storageKey;
        }
        if (table === 'user_fonts') {
          const storageKey = fontStorageKeys.get(String(original.id));
          if (!storageKey) throw new Error(`Backup user font storage is missing: ${String(original.id)}`);
          transformed.storage_key = storageKey;
        }
        if (table === 'labeled_segments') transformed.analysis_run_id = null;
        if (table === 'user_corrections' || table === 'label_mutation_operations') {
          transformed.source_review_artifact_id = null;
        }
        await insertRow(client, table, transformed);
        restoredEntries += 1;
      }
    }
    for (const [bookId, revisionId] of activeContentRevisions) {
      await client.query(
        `update library_books set active_content_revision_id = $1, updated_at = now()
         where id = $2 and user_id = $3`,
        [revisionId, bookId, config.defaultUserId],
      );
    }
    for (const [bookId, coverAssetId] of activeCoverAssets) {
      await client.query(
        `update library_books set cover_asset_id = $1, updated_at = now()
         where id = $2 and user_id = $3`,
        [coverAssetId, bookId, config.defaultUserId],
      );
    }
    await enqueueSupersededRestoreObjects(client, supersededObjects);
    await finalizeRestoreReservations(client, publishedKeys);
    await client.query('commit');

    const skippedBooks = Array.from(resolutions.values()).filter((value) => value === 'skip').length;
    const copiedBooks = Array.from(resolutions.values()).filter((value) => value === 'copy').length;
    return {
      restoredBooks: books.length - skippedBooks,
      skippedBooks,
      copiedBooks,
      restoredEntries,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    await enqueueObjectDeletions(pool, stagedKeys, 'backup_restore_failed').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
