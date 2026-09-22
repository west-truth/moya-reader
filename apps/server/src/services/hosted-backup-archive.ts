import { createHash } from 'node:crypto';
import { BlobReader, TextReader, Uint8ArrayReader, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { openAsBlob } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { verifiedBackupStream, hashBackupBlob } from './backup-streams.js';
import { assertUploadDiskSpace } from './upload-file.js';
import { hasSecretLikeKey } from '../providers/server-provider-settings.js';

export const HOSTED_BACKUP_FORMAT = 'noveldesk-backup' as const;
export const HOSTED_BACKUP_VERSION = 1 as const;
export const MAX_HOSTED_BACKUP_ENTRIES = 100_000;
export const MAX_HOSTED_BACKUP_UNCOMPRESSED_BYTES = 256 * 1024 ** 3;

export const MAX_HOSTED_BACKUP_ARCHIVE_BYTES = 257 * 1024 ** 3;
export const MAX_BACKUP_OBJECT_BYTES = 5 * 1024 ** 3;
const MAX_JSON_BYTES = 64 * 1024 ** 2;
const MAX_METADATA_BYTES = 256 * 1024 ** 2;
const MAX_MANIFEST_BYTES = 16 * 1024 ** 2;

export const HOSTED_BACKUP_BOOK_TABLES = [
  'library_books',
  'book_assets',
  'shelf_memberships',
  'book_content_revisions',
  'chapters',
  'paragraph_pages',
  'reading_positions',
  'fixed_document_section_read_states',
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
  readonly asset_kind?: 'source' | 'source_part' | 'cover' | 'epub_resource' | 'document_page' | 'user_font';
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
  readonly assetBlobs: ReadonlyMap<string, Buffer | Blob>;
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
  loadObject: (object: HostedBookObjectRow) => Promise<Buffer | ReadableStream<Uint8Array>>,
  signal?: AbortSignal,
): HostedBackupStreamResult {
  if (!snapshot.tables.has('library_books') || !snapshot.tables.has('reader_settings')) {
    throw new Error('Hosted backup export requires the catalog and reader settings tables');
  }
  for (const [table, rows] of snapshot.tables) assertSafeHostedTableRows(table, rows);
  const jsonEntries = Array.from(snapshot.tables, ([table, rows]) => serializedEntry(tablePath(table), rows));
  jsonEntries.push(serializedEntry(objectTablePath(), snapshot.objects));
  if (jsonEntries.length + snapshot.objects.length + 1 > MAX_HOSTED_BACKUP_ENTRIES)
    throw new Error('Hosted backup export entry count is outside the supported range');
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
  if (
    Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES ||
    jsonEntries.some(({ entry }) => entry.byteLength > MAX_JSON_BYTES) ||
    jsonEntries.reduce((n, { entry }) => n + entry.byteLength, 0) > MAX_METADATA_BYTES
  )
    throw new Error('Backup metadata is too large');

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
  if (assetBlobs.some((asset) => asset.byteLength > MAX_BACKUP_OBJECT_BYTES))
    throw new Error('Backup individual object exceeds 5GiB');

  let streamController: TransformStreamDefaultController<Uint8Array> | undefined;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  const completion = (async () => {
    const zip = new ZipWriter(stream.writable, {
      bufferedWrite: false,
      zip64: true,
      level: 0,
      useWebWorkers: false,
      signal,
    });
    try {
      for (const { entry, text } of jsonEntries) await zip.add(entry.path, new TextReader(text));
      for (const [index, object] of snapshot.objects.entries()) {
        signal?.throwIfAborted();
        const input = await loadObject(object);
        const metadata = assetBlobs[index];
        const body =
          input instanceof Uint8Array
            ? new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(input);
                  controller.close();
                },
              })
            : input;
        await zip.add(metadata.path, verifiedBackupStream(body, metadata));
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

export async function parseHostedBackupArchive(
  archive: Uint8Array | Blob,
  options: { assetDirectory?: string; signal?: AbortSignal; archiveHash?: string } = {},
): Promise<ParsedHostedBackupArchive> {
  const reader = new ZipReader(archive instanceof Blob ? new BlobReader(archive) : new Uint8ArrayReader(archive), {
    useWebWorkers: false,
    signal: options.signal,
  });
  try {
    const listed: Awaited<ReturnType<typeof reader.getEntries>> = [];
    for await (const entry of reader.getEntriesGenerator()) {
      if (listed.length >= MAX_HOSTED_BACKUP_ENTRIES)
        throw new Error('Backup archive entry count is outside the supported range');
      listed.push(entry);
    }
    const entries = listed.filter((entry) => !entry.directory);
    if (entries.length === 0 || entries.length > MAX_HOSTED_BACKUP_ENTRIES)
      throw new Error('Backup archive entry count is outside the supported range');
    const paths = new Set<string>();
    let totalUncompressedBytes = 0;
    for (const entry of entries) {
      if (!safeArchivePath(entry.filename) || paths.has(entry.filename))
        throw new Error(`Unsafe or duplicate backup path: ${entry.filename}`);
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0)
        throw new Error('Backup entry size is invalid');
      paths.add(entry.filename);
      totalUncompressedBytes += entry.uncompressedSize;
    }
    if (totalUncompressedBytes > MAX_HOSTED_BACKUP_UNCOMPRESSED_BYTES)
      throw new Error('Backup archive is too large after extraction');
    if (!options.assetDirectory && totalUncompressedBytes > 512 * 1024 ** 2)
      throw new Error('Large backup restore requires disk staging');
    if (options.assetDirectory) await assertUploadDiskSpace(options.assetDirectory, totalUncompressedBytes);

    // Metadata stays bounded in memory; binary assets use independent generated disk names.
    async function extract(
      entry: (typeof entries)[number],
      limit: number,
      expected?: HostedBackupEntry,
      file?: string,
    ) {
      if (!entry.getData || entry.uncompressedSize > limit) throw new Error('Backup entry is too large');
      const chunks: Uint8Array[] = [];
      let length = 0;
      const hash = createHash('sha256');
      const handle = file ? await open(file, 'wx', 0o600) : undefined;
      try {
        await entry.getData(
          new WritableStream<Uint8Array>({
            async write(chunk) {
              length += chunk.byteLength;
              if (length > limit || length > entry.uncompressedSize)
                throw new Error('Backup entry exceeds its declared size');
              hash.update(chunk);
              if (handle) {
                let offset = 0;
                while (offset < chunk.byteLength) {
                  const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
                  if (!bytesWritten) throw new Error('Backup disk write failed');
                  offset += bytesWritten;
                }
              } else chunks.push(chunk);
            },
          }),
          { checkSignature: true, signal: options.signal },
        );
        const digest = `sha256:${hash.digest('hex')}`;
        if (
          length !== entry.uncompressedSize ||
          (expected && (length !== expected.byteLength || digest !== expected.contentHash))
        )
          throw new Error(`Backup entry integrity check failed: ${entry.filename}`);
      } finally {
        await handle?.close();
      }
      return file ? await openAsBlob(file) : Buffer.concat(chunks, length);
    }
    const manifestEntry = entries.find((entry) => entry.filename === 'manifest.json');
    if (!manifestEntry) throw new Error('Backup manifest is missing');
    const manifestBytes = (await extract(manifestEntry, MAX_MANIFEST_BYTES)) as Buffer;
    const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')));
    const expectedByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    if (expectedByPath.size !== manifest.entries.length || manifest.entries.length !== entries.length - 1)
      throw new Error('Backup manifest entry list does not match the archive');
    const assetsByPath = new Map(manifest.assetBlobs.map((asset) => [asset.path, asset]));
    if (
      assetsByPath.size !== manifest.assetBlobs.length ||
      new Set(manifest.assetBlobs.map((a) => a.storageKey)).size !== manifest.assetBlobs.length
    )
      throw new Error('Backup asset identities are duplicated');
    const tables = new Map<HostedBackupTableName, Record<string, unknown>[]>();
    const assetBlobs = new Map<string, Buffer | Blob>();
    let objects: HostedBookObjectRow[] = [];
    let metadataBytes = 0;
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (entry.filename === 'manifest.json') continue;
      const expected = expectedByPath.get(entry.filename);
      if (
        !expected ||
        expected.byteLength !== entry.uncompressedSize ||
        !Number.isSafeInteger(expected.byteLength) ||
        expected.byteLength < 0 ||
        !/^sha256:[0-9a-f]{64}$/.test(expected.contentHash)
      )
        throw new Error(`Unlisted or invalid backup entry: ${entry.filename}`);
      const asset = assetsByPath.get(entry.filename);
      if (asset) {
        if (asset.contentHash !== expected.contentHash || asset.byteLength !== expected.byteLength)
          throw new Error(`Backup asset metadata mismatch: ${entry.filename}`);
        const file = options.assetDirectory ? path.join(options.assetDirectory, `asset-${assetBlobs.size}`) : undefined;
        assetBlobs.set(asset.storageKey, await extract(entry, MAX_BACKUP_OBJECT_BYTES, expected, file));
        continue;
      }
      metadataBytes += entry.uncompressedSize;
      if (metadataBytes > MAX_METADATA_BYTES) throw new Error('Backup metadata is too large');
      const bytes = (await extract(entry, MAX_JSON_BYTES, expected)) as Buffer;
      if (entry.filename === objectTablePath()) {
        objects = recordArray(JSON.parse(bytes.toString('utf8')), 'Hosted book object table') as HostedBookObjectRow[];
      } else if (entry.filename.startsWith('hosted/tables/') && entry.filename.endsWith('.json')) {
        const name = entry.filename.slice('hosted/tables/'.length, -'.json'.length) as HostedBackupTableName;
        if (!HOSTED_BACKUP_TABLES.includes(name))
          throw new Error(`Backup contains an unsupported hosted table: ${name}`);
        const rows = recordArray(JSON.parse(bytes.toString('utf8')), `Hosted table ${name}`);
        assertSafeHostedTableRows(name, rows);
        tables.set(name, rows);
      } else throw new Error(`Unlisted backup entry: ${entry.filename}`);
    }
    if (!tables.has('library_books') || !tables.has('reader_settings'))
      throw new Error('Hosted backup catalog or settings are missing');
    if (
      assetBlobs.size !== manifest.assetBlobs.length ||
      objects.length !== manifest.assetBlobs.length ||
      new Set(objects.map((o) => o.id)).size !== objects.length
    )
      throw new Error('Hosted backup source asset list is incomplete');
    const assetsById = new Map(manifest.assetBlobs.map((a) => [a.storageKey, a]));
    for (const object of objects) {
      const asset = assetsById.get(object.id);
      if (
        !asset ||
        normalizedSha256(object.raw_text_hash) !== asset.contentHash ||
        Number(object.size_bytes) !== asset.byteLength
      )
        throw new Error('Hosted backup object metadata mismatch');
    }
    return {
      manifest,
      tables,
      objects,
      assetBlobs,
      archiveHash:
        options.archiveHash ??
        (archive instanceof Blob ? await hashBackupBlob(archive, options.signal) : taggedSha256(archive)),
      totalUncompressedBytes,
    };
  } finally {
    await reader.close();
  }
}
