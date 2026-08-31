import type { Novel, ParagraphPage } from '../domain/types';
import { sha256 } from '../domain/hash';
import type {
  BackupConflictResolution,
  BackupInspection,
  BackupManifestAssetBlob,
  BackupManifestEntry,
  BackupManifestV1,
  BackupRepository,
  BackupRestoreOptions,
  BackupRestoreResult,
} from '../repositories/backup-repository';
import { BACKUP_RESTORE_RUNS_STORE, type BackupRestoreRunRecord } from './backup-schema';
import { BOOK_ASSET_STORES, type StoredBookAssetBlob } from './book-asset-schema';
import { BOOK_DATA_STORES, bookDataIndexName } from './book-data-cleanup';
import { READER_PERSONALIZATION_STORES } from './reader-personalization-schema';
import {
  contentDomainHeadId,
  putParagraphSearchRowsForPage,
  type RevisionParagraphPageRow,
} from './content-revision-store';
import { revisionScopedStorageId } from './content-revisions';
import { CONTENT_REVISION_STORES } from './content-revision-migration';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb, type ReaderStoreName } from './reader-database';
import { SPEAKER_ATTRIBUTION_STORES } from './speaker-attribution-schema';
import { SPEAKER_WORKFLOW_STORES } from './speaker-workflow-schema';
import { TEMPORAL_CHARACTER_MEMORY_STORES } from './temporal-character-memory-schema';
import { VOICE_CASTING_STORES } from './voice-casting-schema';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';

const BACKUP_FORMAT = 'noveldesk-backup' as const;
const BACKUP_VERSION = 1 as const;
const APP_VERSION = '0.1.0';
const MAX_ARCHIVE_ENTRIES = 500;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

const BACKUP_JSON_STORES: readonly ReaderStoreName[] = [
  'novels',
  'book_content_revisions',
  'book_content_chapters',
  'book_content_paragraphs',
  'book_content_paragraph_pages',
  'book_content_domain_heads',
  'chapters',
  'paragraphs',
  'paragraph_pages',
  'bookmarks',
  'highlights',
  'notes',
  'settings',
  'segments',
  'characters',
  'character_relations',
  'voice_profiles',
  'voice_product_states',
  VOICE_CASTING_STORES.states,
  'corrections',
  'reading_positions',
  DOCUMENT_LISTENING_STORES.listeningPositions,
  DOCUMENT_LISTENING_STORES.documentAnnotations,
  DOCUMENT_LISTENING_STORES.documentTextOrderOverrides,
  DOCUMENT_LISTENING_STORES.comicProfiles,
  DOCUMENT_LISTENING_STORES.spokenTextRules,
  'native_analysis_provenance',
  'label_mutation_receipts',
  'label_mutation_invalidations',
  'label_reanalysis_plans',
  'character_facts_v2',
  'character_mentions_v2',
  'character_address_terms_v2',
  'character_speech_traits_v2',
  'character_relation_facts_v2',
  'character_evidence_v2',
  'character_merge_candidates_v2',
  'character_id_redirects_v2',
  'character_identity_receipts_v2',
  'chapter_structure_receipts',
  'chapter_structure_review',
  ...Object.values(SPEAKER_ATTRIBUTION_STORES),
  ...Object.values(TEMPORAL_CHARACTER_MEMORY_STORES),
  ...Object.values(SPEAKER_WORKFLOW_STORES),
  'shelves',
  'shelf_memberships',
  'library_operation_receipts',
  BOOK_ASSET_STORES.assets,
  READER_PERSONALIZATION_STORES.fonts,
  READER_PERSONALIZATION_STORES.sessions,
];

const COPY_REBUILD_STORES = new Set<string>([
  VOICE_CASTING_STORES.states,
  ...Object.values(SPEAKER_ATTRIBUTION_STORES),
  ...Object.values(TEMPORAL_CHARACTER_MEMORY_STORES),
  ...Object.values(SPEAKER_WORKFLOW_STORES),
]);

interface ParsedBackupArchive {
  manifest: BackupManifestV1;
  jsonStores: Map<string, Record<string, unknown>[]>;
  assetBlobs: Map<string, Blob>;
  archiveHash: string;
  totalUncompressedBytes: number;
}

function taggedHash(hash: string): string {
  return hash.startsWith('sha256:') ? hash : `sha256:${hash}`;
}

async function hashText(value: string): Promise<string> {
  return taggedHash(await sha256(value));
}

async function hashBlob(value: Blob): Promise<string> {
  return taggedHash(await sha256((await value.arrayBuffer()) as ArrayBuffer));
}

function safeArchivePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.includes('\\') || path.includes('\0')) {
    return false;
  }
  return !path.split('/').some((part) => part === '..' || part === '');
}

function recordBookId(record: Record<string, unknown>): string | undefined {
  const value = record.novelId ?? record.bookId ?? record.book_id;
  return typeof value === 'string' && value ? value : undefined;
}

function recordBookIdForStore(storeName: string, record: Record<string, unknown>): string | undefined {
  if (storeName === 'novels') return typeof record.id === 'string' ? record.id : undefined;
  return recordBookId(record);
}

function collectRecordIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectRecordIds(item, ids));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      ['id', 'storageId', 'operationId', 'draftId', 'workflowId', 'jobId'].includes(key) &&
      typeof child === 'string' &&
      child
    ) {
      ids.add(child);
    }
    collectRecordIds(child, ids);
  }
}

function rekeyValue(value: unknown, idMap: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return idMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rekeyValue(item, idMap));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, rekeyValue(child, idMap)]),
  );
}

function copyIdMap(
  bookId: string,
  recordsByStore: ReadonlyMap<string, Record<string, unknown>[]>,
): ReadonlyMap<string, string> {
  const suffix = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 10) ?? Date.now().toString(36);
  const ids = new Set<string>([bookId]);
  for (const [storeName, records] of recordsByStore) {
    records
      .filter((record) => recordBookIdForStore(storeName, record) === bookId)
      .forEach((record) => collectRecordIds(record, ids));
  }
  const mapped = new Map(Array.from(ids, (id) => [id, `${id}__copy_${suffix}`]));
  for (const [storeName, records] of recordsByStore) {
    for (const record of records) {
      if (recordBookIdForStore(storeName, record) !== bookId) continue;
      // Lookup keys are derived from the copied identities, not an arbitrary suffix on the old key.
      if (
        typeof record.storageId === 'string' &&
        typeof record.contentRevisionId === 'string' &&
        typeof record.id === 'string'
      ) {
        mapped.set(
          record.storageId,
          revisionScopedStorageId(
            mapped.get(record.contentRevisionId) ?? record.contentRevisionId,
            mapped.get(record.id) ?? record.id,
          ),
        );
      }
      if (
        storeName === CONTENT_REVISION_STORES.heads &&
        typeof record.id === 'string' &&
        typeof record.domainId === 'string' &&
        (record.entityType === 'chapter' || record.entityType === 'paragraph')
      ) {
        mapped.set(record.id, contentDomainHeadId(record.entityType, mapped.get(record.domainId) ?? record.domainId));
      }
    }
  }
  return mapped;
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) && value.every((item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
  );
}

function validateManifest(value: unknown): BackupManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Backup manifest is invalid');
  const manifest = value as Partial<BackupManifestV1>;
  if (manifest.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION) {
    throw new Error('Unsupported backup manifest version');
  }
  if (!Array.isArray(manifest.books) || !Array.isArray(manifest.entries) || !Array.isArray(manifest.assetBlobs)) {
    throw new Error('Backup manifest lists are invalid');
  }
  return manifest as BackupManifestV1;
}

function zipStorePath(storeName: string): string {
  return `stores/${storeName}.json`;
}

function assetEntryPath(storageKey: string): string {
  return `assets/${encodeURIComponent(storageKey)}.bin`;
}

async function readAllBackupStores(): Promise<{
  stores: Map<string, Record<string, unknown>[]>;
  blobs: StoredBookAssetBlob[];
}> {
  const db = await openReaderDb();
  const availableStores = BACKUP_JSON_STORES.filter((name) => db.objectStoreNames.contains(name));
  const transactionNames = [...availableStores, BOOK_ASSET_STORES.blobs];
  const tx = db.transaction(transactionNames, 'readonly');
  const storeEntries = await Promise.all(
    availableStores.map(async (name) => {
      const rows = await requestToPromise<Record<string, unknown>[]>(tx.objectStore(name).getAll());
      return [name, rows] as const;
    }),
  );
  const blobs = await requestToPromise<StoredBookAssetBlob[]>(tx.objectStore(BOOK_ASSET_STORES.blobs).getAll());
  await transactionDone(tx);
  return { stores: new Map(storeEntries), blobs };
}

async function getAllStoredNovels(): Promise<Novel[]> {
  const db = await openReaderDb();
  const tx = db.transaction('novels', 'readonly');
  const novels = await requestToPromise<Novel[]>(tx.objectStore('novels').getAll());
  await transactionDone(tx);
  return novels;
}

async function deleteByBookIndex(tx: IDBTransaction, storeName: string, indexName: string, bookId: string) {
  const store = tx.objectStore(storeName);
  await new Promise<void>((resolve, reject) => {
    const request = store.index(indexName).openCursor(IDBKeyRange.only(bookId));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });
}

async function deleteExistingBookData(tx: IDBTransaction, bookId: string): Promise<void> {
  tx.objectStore('novels').delete(bookId);
  await Promise.all(
    BOOK_DATA_STORES.map((storeName) => deleteByBookIndex(tx, storeName, bookDataIndexName(storeName), bookId)),
  );
  await deleteByBookIndex(tx, BOOK_ASSET_STORES.assets, 'bookId', bookId);
}

async function garbageCollectAssetBlobs(tx: IDBTransaction): Promise<void> {
  const [assets, fonts, blobs] = await Promise.all([
    requestToPromise<Array<{ storageKey: string }>>(tx.objectStore(BOOK_ASSET_STORES.assets).getAll()),
    requestToPromise<Array<{ storageKey: string }>>(tx.objectStore(READER_PERSONALIZATION_STORES.fonts).getAll()),
    requestToPromise<StoredBookAssetBlob[]>(tx.objectStore(BOOK_ASSET_STORES.blobs).getAll()),
  ]);
  const referenced = new Set([...assets, ...fonts].map((asset) => asset.storageKey));
  const store = tx.objectStore(BOOK_ASSET_STORES.blobs);
  blobs.filter((blob) => !referenced.has(blob.id)).forEach((blob) => store.delete(blob.id));
}

function restoreRunId(): string {
  return `backup_restore_${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

export class IndexedDbBackupRepository implements BackupRepository {
  private readonly archiveCache = new WeakMap<Blob, Promise<ParsedBackupArchive>>();

  async exportBackup(): Promise<{ blob: Blob; manifest: BackupManifestV1 }> {
    const { BlobReader, BlobWriter, TextReader, ZipWriter } = await import('@zip.js/zip.js');
    const snapshot = await readAllBackupStores();
    const entries: BackupManifestEntry[] = [];
    const assetBlobs: BackupManifestAssetBlob[] = [];
    const writer = new BlobWriter('application/zip');
    const zip = new ZipWriter(writer, { bufferedWrite: true });

    for (const [storeName, records] of snapshot.stores) {
      const path = zipStorePath(storeName);
      const text = JSON.stringify(records);
      entries.push({
        path,
        contentHash: await hashText(text),
        byteLength: new Blob([text]).size,
        contentType: 'application/json',
      });
      await zip.add(path, new TextReader(text));
    }

    for (const stored of snapshot.blobs) {
      const path = assetEntryPath(stored.id);
      const contentHash = await hashBlob(stored.blob);
      entries.push({
        path,
        contentHash,
        byteLength: stored.blob.size,
        contentType: stored.contentType,
      });
      assetBlobs.push({
        storageKey: stored.id,
        path,
        contentHash,
        byteLength: stored.blob.size,
        contentType: stored.contentType,
        createdAt: stored.createdAt,
      });
      await zip.add(path, new BlobReader(stored.blob));
    }

    const novels = (snapshot.stores.get('novels') ?? []) as unknown as Novel[];
    const manifest: BackupManifestV1 = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      books: novels.map((novel) => ({
        id: novel.id,
        format: novel.format ?? 'txt',
        activeContentRevisionId: novel.activeContentRevisionId,
        title: novel.title,
      })),
      entries,
      assetBlobs,
    };
    await zip.add('manifest.json', new TextReader(JSON.stringify(manifest, null, 2)));
    await zip.close();
    return { blob: await writer.getData(), manifest };
  }

  async inspectBackup(archive: Blob): Promise<BackupInspection> {
    const parsed = await this.readArchive(archive);
    const existing = new Map((await getAllStoredNovels()).map((novel) => [novel.id, novel]));
    return {
      manifest: parsed.manifest,
      conflicts: parsed.manifest.books.flatMap((book) => {
        const current = existing.get(book.id);
        return current ? [{ bookId: book.id, title: book.title, existingTitle: current.title }] : [];
      }),
      archiveByteLength: archive.size,
      totalUncompressedBytes: parsed.totalUncompressedBytes,
      warnings: parsed.manifest.books.some((book) => !book.activeContentRevisionId)
        ? ['일부 기존 책은 active content revision 정보가 없어 legacy 저장 형식으로 복원됩니다.']
        : [],
    };
  }

  async restoreBackup(archive: Blob, options: BackupRestoreOptions): Promise<BackupRestoreResult> {
    const parsed = await this.readArchive(archive);
    const inspection = await this.inspectBackup(archive);
    const conflictIds = new Set(inspection.conflicts.map((conflict) => conflict.bookId));
    const resolutions = new Map<string, BackupConflictResolution>();
    for (const conflict of inspection.conflicts) {
      resolutions.set(
        conflict.bookId,
        options.conflictResolutions?.[conflict.bookId] ?? options.defaultConflictResolution,
      );
    }
    const copyMaps = new Map<string, ReadonlyMap<string, string>>();
    for (const [bookId, resolution] of resolutions) {
      if (resolution === 'copy') copyMaps.set(bookId, copyIdMap(bookId, parsed.jsonStores));
    }

    const restoredStores = new Map<string, Record<string, unknown>[]>();
    for (const [storeName, records] of parsed.jsonStores) {
      const restored = records.flatMap((record) => {
        const bookId = recordBookIdForStore(storeName, record);
        if (!bookId || !conflictIds.has(bookId)) return [record];
        const resolution = resolutions.get(bookId) ?? options.defaultConflictResolution;
        if (resolution === 'skip') return [];
        if (resolution !== 'copy') return [record];
        if (COPY_REBUILD_STORES.has(storeName)) return [];
        const copied = rekeyValue(record, copyMaps.get(bookId)!) as Record<string, unknown>;
        if (storeName === 'novels' && typeof copied.title === 'string') copied.title = `${copied.title} (복사본)`;
        return [copied];
      });
      restoredStores.set(storeName, restored);
    }

    const restoredAssets = [
      ...(restoredStores.get(BOOK_ASSET_STORES.assets) ?? []),
      ...(restoredStores.get(READER_PERSONALIZATION_STORES.fonts) ?? []),
    ];
    const requiredStorageKeys = new Set(
      restoredAssets
        .map((asset) => asset.storageKey)
        .filter((storageKey): storageKey is string => typeof storageKey === 'string'),
    );
    const restoredBlobs = parsed.manifest.assetBlobs.filter((asset) => requiredStorageKeys.has(asset.storageKey));
    const runId = restoreRunId();
    const now = new Date().toISOString();
    const run: BackupRestoreRunRecord = {
      id: runId,
      status: 'validated',
      manifestVersion: parsed.manifest.version,
      archiveHash: parsed.archiveHash,
      archiveByteLength: archive.size,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveRestoreRun(run);

    const db = await openReaderDb();
    const storeNames = Array.from(
      new Set<string>([
        'novels',
        'settings',
        ...BOOK_DATA_STORES,
        ...restoredStores.keys(),
        'paragraph_search',
        'book_content_paragraph_search',
        BOOK_ASSET_STORES.assets,
        BOOK_ASSET_STORES.blobs,
        READER_PERSONALIZATION_STORES.fonts,
        READER_PERSONALIZATION_STORES.sessions,
        BACKUP_RESTORE_RUNS_STORE,
      ]),
    ).filter((name) => db.objectStoreNames.contains(name));
    const tx = db.transaction(storeNames, 'readwrite');
    const done = transactionDone(tx);
    try {
      tx.objectStore(BACKUP_RESTORE_RUNS_STORE).put({
        ...run,
        status: 'applying',
        updatedAt: new Date().toISOString(),
      });
      const replaceBookIds = Array.from(resolutions)
        .filter(([, resolution]) => resolution === 'replace')
        .map(([bookId]) => bookId);
      for (const bookId of replaceBookIds) await deleteExistingBookData(tx, bookId);

      for (const [storeName, records] of restoredStores) {
        if (!tx.objectStoreNames.contains(storeName)) continue;
        const store = tx.objectStore(storeName);
        records.forEach((record) => {
          if (storeName === 'book_content_paragraph_pages') {
            const page = record as unknown as RevisionParagraphPageRow;
            store.put({ ...page, paragraphIds: page.paragraphs.map((paragraph) => paragraph.id) });
            return;
          }
          store.put(record);
        });
      }
      for (const metadata of restoredBlobs) {
        const blob = parsed.assetBlobs.get(metadata.storageKey);
        if (!blob) throw new Error(`Backup asset ${metadata.storageKey} is missing`);
        tx.objectStore(BOOK_ASSET_STORES.blobs).put({
          id: metadata.storageKey,
          contentHash: metadata.contentHash,
          contentType: metadata.contentType,
          byteLength: metadata.byteLength,
          blob,
          createdAt: metadata.createdAt,
        } satisfies StoredBookAssetBlob);
      }

      const legacySearchStore = tx.objectStore('paragraph_search');
      (restoredStores.get('paragraph_pages') ?? []).forEach((page) =>
        putParagraphSearchRowsForPage(legacySearchStore, page as unknown as ParagraphPage),
      );
      await garbageCollectAssetBlobs(tx);

      const copiedBooks = Array.from(resolutions.values()).filter((resolution) => resolution === 'copy').length;
      const skippedBooks = Array.from(resolutions.values()).filter((resolution) => resolution === 'skip').length;
      const result: BackupRestoreResult = {
        restoredBooks: parsed.manifest.books.length - skippedBooks,
        skippedBooks,
        copiedBooks,
        restoredEntries: Array.from(restoredStores.values()).reduce((sum, records) => sum + records.length, 0),
      };
      tx.objectStore(BACKUP_RESTORE_RUNS_STORE).put({
        ...run,
        status: 'completed',
        summary: {
          restoredBooks: result.restoredBooks,
          skippedBooks: result.skippedBooks,
          copiedBooks: result.copiedBooks,
          restoredEntries: result.restoredEntries,
        },
        updatedAt: new Date().toISOString(),
      } satisfies BackupRestoreRunRecord);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction can already be aborted by IndexedDB.
      }
      await done.catch(() => undefined);
      await this.saveRestoreRun({
        ...run,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  private readArchive(archive: Blob): Promise<ParsedBackupArchive> {
    const cached = this.archiveCache.get(archive);
    if (cached) return cached;
    const pending = this.parseArchive(archive);
    this.archiveCache.set(archive, pending);
    return pending;
  }

  private async parseArchive(archive: Blob): Promise<ParsedBackupArchive> {
    const { BlobReader, BlobWriter, TextWriter, ZipReader } = await import('@zip.js/zip.js');
    const reader = new ZipReader(new BlobReader(archive));
    try {
      const entries = (await reader.getEntries()).filter((entry) => !entry.directory);
      if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
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
      if (totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('Backup archive is too large after extraction');
      }
      const manifestEntry = entries.find((entry) => entry.filename === 'manifest.json');
      if (!manifestEntry?.getData) throw new Error('Backup manifest is missing');
      const manifest = validateManifest(JSON.parse(await manifestEntry.getData(new TextWriter())));
      const listedEntries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
      if (listedEntries.size !== manifest.entries.length || manifest.entries.length !== entries.length - 1) {
        throw new Error('Backup manifest entry list does not match the archive');
      }
      const jsonStores = new Map<string, Record<string, unknown>[]>();
      const assetBlobs = new Map<string, Blob>();
      const assetByPath = new Map(manifest.assetBlobs.map((asset) => [asset.path, asset]));

      for (const entry of entries) {
        if (entry.filename === 'manifest.json') continue;
        const expected = listedEntries.get(entry.filename);
        if (!expected || !entry.getData) throw new Error(`Unlisted backup entry: ${entry.filename}`);
        const blob = await entry.getData(new BlobWriter(expected.contentType));
        if (blob.size !== expected.byteLength || (await hashBlob(blob)) !== expected.contentHash) {
          throw new Error(`Backup entry integrity check failed: ${entry.filename}`);
        }
        if (entry.filename.startsWith('stores/') && entry.filename.endsWith('.json')) {
          const storeName = entry.filename.slice('stores/'.length, -'.json'.length);
          if (!BACKUP_JSON_STORES.includes(storeName as ReaderStoreName)) {
            throw new Error(`Backup contains an unsupported store: ${storeName}`);
          }
          const records = JSON.parse(await blob.text()) as unknown;
          if (!isRecordArray(records)) throw new Error(`Backup store ${storeName} is invalid`);
          jsonStores.set(storeName, records);
          continue;
        }
        const asset = assetByPath.get(entry.filename);
        if (!asset || asset.contentHash !== expected.contentHash || asset.byteLength !== expected.byteLength) {
          throw new Error(`Backup asset metadata mismatch: ${entry.filename}`);
        }
        assetBlobs.set(asset.storageKey, blob);
      }
      if (!jsonStores.has('novels')) throw new Error('Backup novel catalog is missing');
      if (assetBlobs.size !== manifest.assetBlobs.length) throw new Error('Backup asset list is incomplete');
      return {
        manifest,
        jsonStores,
        assetBlobs,
        archiveHash: await hashBlob(archive),
        totalUncompressedBytes,
      };
    } finally {
      await reader.close();
    }
  }

  private async saveRestoreRun(run: BackupRestoreRunRecord): Promise<void> {
    const db = await openReaderDb();
    const tx = db.transaction(BACKUP_RESTORE_RUNS_STORE, 'readwrite');
    tx.objectStore(BACKUP_RESTORE_RUNS_STORE).put(run);
    await transactionDone(tx);
  }
}
