import { createHash } from 'node:crypto';
import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { hasSecretLikeKey } from '../providers/server-provider-settings.js';

export const HOSTED_BACKUP_FORMAT = 'noveldesk-backup' as const;
export const HOSTED_BACKUP_VERSION = 1 as const;
export const MAX_HOSTED_BACKUP_ENTRIES = 1_000;
export const MAX_HOSTED_BACKUP_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

export const HOSTED_BACKUP_BOOK_TABLES = [
  'library_books',
  'book_assets',
  'shelf_memberships',
  'book_content_revisions',
  'chapters',
  'paragraph_pages',
  'reading_positions',
  'bookmarks',
  'highlights',
  'notes',
  'characters',
  'character_relations',
  'voice_profiles',
  'voice_casting_states',
  'voice_product_preferences',
  'pronunciation_profiles',
  'labeled_segments',
  'user_corrections',
  'character_evidence_v2',
  'character_facts_v2',
  'character_mentions_v2',
  'character_address_terms_v2',
  'character_speech_traits_v2',
  'character_relation_facts_v2',
  'character_merge_candidates_v2',
  'character_id_redirects_v2',
  'character_identity_operation_receipts_v2',
  'label_mutation_operations',
  'label_mutation_invalidations',
  'label_reanalysis_plans',
  'chapter_structure_receipts',
  'chapter_structure_review_items',
  'reading_session_events',
] as const;

export const HOSTED_BACKUP_GLOBAL_TABLES = [
  'shelves',
  'reader_settings',
  'library_operation_receipts',
  'user_fonts',
] as const;
export const HOSTED_BACKUP_TABLES = [
  'shelves',
  ...HOSTED_BACKUP_BOOK_TABLES,
  'reader_settings',
  'library_operation_receipts',
  'user_fonts',
] as const;

export type HostedBackupTableName = (typeof HOSTED_BACKUP_TABLES)[number];

export interface HostedBackupEntry {
  readonly path: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly contentType: string;
}

export interface HostedBackupBook {
  readonly id: string;
  readonly format: string;
  readonly activeContentRevisionId?: string;
  readonly title: string;
}

export interface HostedBackupAsset {
  readonly storageKey: string;
  readonly path: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly createdAt: string;
}

export interface HostedBackupManifestV1 {
  readonly format: typeof HOSTED_BACKUP_FORMAT;
  readonly version: typeof HOSTED_BACKUP_VERSION;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly books: HostedBackupBook[];
  readonly entries: HostedBackupEntry[];
  readonly assetBlobs: HostedBackupAsset[];
  readonly backend: 'hosted';
}

export interface HostedBookObjectRow extends Record<string, unknown> {
  readonly id: string;
  readonly raw_text_hash: string;
  readonly storage_key: string;
  readonly file_name: string;
  readonly content_type: string;
  readonly size_bytes: number | string;
  readonly created_at: string | Date;
  readonly asset_kind?: 'source' | 'cover' | 'epub_resource' | 'document_page' | 'user_font';
}

export interface HostedBackupSnapshot {
  readonly tables: ReadonlyMap<HostedBackupTableName, readonly Record<string, unknown>[]>;
  readonly objects: readonly HostedBookObjectRow[];
  readonly books: readonly HostedBackupBook[];
  readonly exportedAt: string;
  readonly appVersion: string;
}

export interface HostedBackupStreamResult {
  readonly manifest: HostedBackupManifestV1;
  readonly readable: ReadableStream<Uint8Array>;
  readonly completion: Promise<void>;
}

export interface ParsedHostedBackupArchive {
  readonly manifest: HostedBackupManifestV1;
  readonly tables: ReadonlyMap<HostedBackupTableName, Record<string, unknown>[]>;
  readonly objects: readonly HostedBookObjectRow[];
  readonly assetBlobs: ReadonlyMap<string, Buffer>;
  readonly archiveHash: string;
  readonly totalUncompressedBytes: number;
}

function taggedSha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizedSha256(value: string): string {
  if (/^sha256:[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(value)) return `sha256:${value.toLowerCase()}`;
  throw new Error('Hosted source object does not have a verifiable SHA-256 hash');
}

function tablePath(table: HostedBackupTableName): string {
  return `hosted/tables/${table}.json`;
}

function objectTablePath(): string {
  return 'hosted/book_objects.json';
}

function assetPath(objectId: string): string {
  return `assets/${encodeURIComponent(objectId)}.bin`;
}

function safeArchivePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.includes('\\') || path.includes('\0')) {
    return false;
  }
  return !path.split('/').some((part) => !part || part === '..');
}

function recordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error(`${label} is not a record array`);
  }
  return value as Record<string, unknown>[];
}

function assertSafeHostedTableRows(table: HostedBackupTableName, rows: readonly Record<string, unknown>[]): void {
  if (table === 'voice_casting_states' && hasSecretLikeKey(rows)) {
    throw new Error('Hosted voice casting backup contains secret-like keys or values');
  }
}

function validateManifest(value: unknown): HostedBackupManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Backup manifest is invalid');
  const manifest = value as Partial<HostedBackupManifestV1>;
  if (
    manifest.format !== HOSTED_BACKUP_FORMAT ||
    manifest.version !== HOSTED_BACKUP_VERSION ||
    manifest.backend !== 'hosted'
  ) {
    throw new Error('Unsupported hosted backup manifest');
  }
  if (!Array.isArray(manifest.books) || !Array.isArray(manifest.entries) || !Array.isArray(manifest.assetBlobs)) {
    throw new Error('Backup manifest lists are invalid');
  }
  return manifest as HostedBackupManifestV1;
}

function serializedEntry(path: string, value: unknown): { entry: HostedBackupEntry; text: string } {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  return {
    text,
    entry: { path, contentHash: taggedSha256(text), byteLength: bytes, contentType: 'application/json' },
  };
}

export function createHostedBackupStream(
  snapshot: HostedBackupSnapshot,
  loadObject: (object: HostedBookObjectRow) => Promise<Buffer>,
): HostedBackupStreamResult {
  if (!snapshot.tables.has('library_books') || !snapshot.tables.has('reader_settings')) {
    throw new Error('Hosted backup export requires the catalog and reader settings tables');
  }
  for (const [table, rows] of snapshot.tables) assertSafeHostedTableRows(table, rows);
  const jsonEntries = Array.from(snapshot.tables, ([table, rows]) => serializedEntry(tablePath(table), rows));
  jsonEntries.push(serializedEntry(objectTablePath(), snapshot.objects));
  const assetBlobs = snapshot.objects.map(
    (object) =>
      ({
        storageKey: object.id,
        path: assetPath(object.id),
        contentHash: normalizedSha256(object.raw_text_hash),
        byteLength: Number(object.size_bytes),
        contentType: object.content_type || 'application/octet-stream',
        createdAt: new Date(object.created_at).toISOString(),
      }) satisfies HostedBackupAsset,
  );
  const entries: HostedBackupEntry[] = [
    ...jsonEntries.map(({ entry }) => entry),
    ...assetBlobs.map(({ path, contentHash, byteLength, contentType }) => ({
      path,
      contentHash,
      byteLength,
      contentType,
    })),
  ];
  const manifest: HostedBackupManifestV1 = {
    format: HOSTED_BACKUP_FORMAT,
    version: HOSTED_BACKUP_VERSION,
    exportedAt: snapshot.exportedAt,
    appVersion: snapshot.appVersion,
    books: [...snapshot.books],
    entries,
    assetBlobs,
    backend: 'hosted',
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  const paths = new Set<string>();
  let totalUncompressedBytes = Buffer.byteLength(manifestText);
  for (const entry of entries) {
    if (!safeArchivePath(entry.path) || paths.has(entry.path)) {
      throw new Error(`Unsafe or duplicate hosted backup export path: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      throw new Error(`Hosted backup export entry size is invalid: ${entry.path}`);
    }
    paths.add(entry.path);
    totalUncompressedBytes += entry.byteLength;
  }
  // The parser counts manifest.json as an archive entry, even though it is not
  // listed inside manifest.entries. Reject snapshots that our own restore path
  // would refuse before any response bytes are streamed to the caller.
  if (entries.length + 1 > MAX_HOSTED_BACKUP_ENTRIES) {
    throw new Error('Hosted backup export entry count is outside the supported range');
  }
  if (totalUncompressedBytes > MAX_HOSTED_BACKUP_UNCOMPRESSED_BYTES) {
    throw new Error('Hosted backup export is too large to restore');
  }

  let streamController: TransformStreamDefaultController<Uint8Array> | undefined;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  const completion = (async () => {
    const zip = new ZipWriter(stream.writable, { bufferedWrite: false, zip64: true });
    try {
      for (const { entry, text } of jsonEntries) await zip.add(entry.path, new TextReader(text));
      for (const [index, object] of snapshot.objects.entries()) {
        const bytes = await loadObject(object);
        const metadata = assetBlobs[index];
        if (bytes.byteLength !== metadata.byteLength || taggedSha256(bytes) !== metadata.contentHash) {
          throw new Error(`Hosted asset integrity check failed: ${object.id}`);
        }
        await zip.add(metadata.path, new Uint8ArrayReader(bytes));
      }
      await zip.add('manifest.json', new TextReader(manifestText));
      await zip.close();
    } catch (error) {
      streamController?.error(error);
      throw error;
    }
  })();
  return { manifest, readable: stream.readable, completion };
}

export async function parseHostedBackupArchive(archive: Uint8Array): Promise<ParsedHostedBackupArchive> {
  const reader = new ZipReader(new Uint8ArrayReader(archive));
  try {
    const entries = (await reader.getEntries()).filter((entry) => !entry.directory);
    if (entries.length === 0 || entries.length > MAX_HOSTED_BACKUP_ENTRIES) {
      throw new Error('Backup archive entry count is outside the supported range');
    }
    const paths = new Set<string>();
    let totalUncompressedBytes = 0;
    for (const entry of entries) {
      if (!safeArchivePath(entry.filename) || paths.has(entry.filename)) {
        throw new Error(`Unsafe or duplicate backup path: ${entry.filename}`);
      }
      paths.add(entry.filename);
      totalUncompressedBytes += Number(entry.uncompressedSize ?? 0);
    }
    if (totalUncompressedBytes > MAX_HOSTED_BACKUP_UNCOMPRESSED_BYTES) {
      throw new Error('Backup archive is too large after extraction');
    }

    const manifestEntry = entries.find((entry) => entry.filename === 'manifest.json');
    if (!manifestEntry?.getData) throw new Error('Backup manifest is missing');
    const manifest = validateManifest(JSON.parse(await manifestEntry.getData(new TextWriter())));
    const expectedByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    if (expectedByPath.size !== manifest.entries.length || manifest.entries.length !== entries.length - 1) {
      throw new Error('Backup manifest entry list does not match the archive');
    }

    const tables = new Map<HostedBackupTableName, Record<string, unknown>[]>();
    const assetsByPath = new Map(manifest.assetBlobs.map((asset) => [asset.path, asset]));
    const assetBlobs = new Map<string, Buffer>();
    let objects: HostedBookObjectRow[] = [];
    for (const entry of entries) {
      if (entry.filename === 'manifest.json') continue;
      const expected = expectedByPath.get(entry.filename);
      if (!expected || !entry.getData) throw new Error(`Unlisted backup entry: ${entry.filename}`);
      const bytes = Buffer.from(await entry.getData(new Uint8ArrayWriter()));
      if (bytes.byteLength !== expected.byteLength || taggedSha256(bytes) !== expected.contentHash) {
        throw new Error(`Backup entry integrity check failed: ${entry.filename}`);
      }
      if (entry.filename === objectTablePath()) {
        objects = recordArray(JSON.parse(bytes.toString('utf8')), 'Hosted book object table') as HostedBookObjectRow[];
        continue;
      }
      if (entry.filename.startsWith('hosted/tables/') && entry.filename.endsWith('.json')) {
        const name = entry.filename.slice('hosted/tables/'.length, -'.json'.length);
        if (!HOSTED_BACKUP_TABLES.includes(name as HostedBackupTableName)) {
          throw new Error(`Backup contains an unsupported hosted table: ${name}`);
        }
        const table = name as HostedBackupTableName;
        const rows = recordArray(JSON.parse(bytes.toString('utf8')), `Hosted table ${name}`);
        assertSafeHostedTableRows(table, rows);
        tables.set(table, rows);
        continue;
      }
      const asset = assetsByPath.get(entry.filename);
      if (!asset || asset.contentHash !== expected.contentHash || asset.byteLength !== expected.byteLength) {
        throw new Error(`Backup asset metadata mismatch: ${entry.filename}`);
      }
      assetBlobs.set(asset.storageKey, bytes);
    }
    if (!tables.has('library_books') || !tables.has('reader_settings')) {
      throw new Error('Hosted backup catalog or settings are missing');
    }
    if (assetBlobs.size !== manifest.assetBlobs.length || objects.length !== manifest.assetBlobs.length) {
      throw new Error('Hosted backup source asset list is incomplete');
    }
    return {
      manifest,
      tables,
      objects,
      assetBlobs,
      archiveHash: taggedSha256(archive),
      totalUncompressedBytes,
    };
  } finally {
    await reader.close();
  }
}
