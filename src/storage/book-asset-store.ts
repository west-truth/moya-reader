import type { BookAssetMetadata, ParsedNovelImportAsset } from '../domain/types';
import {
  type BookCoverAssetInput,
  type ExportedBookCover,
  type GeneratedBookCoverInput,
  OriginalSourceMismatchError,
  type ExportedBookSource,
  type OriginalSourceAssetInput,
  type ReselectedBookSourceInput,
} from '../repositories/book-asset-repository';
import { hashSync } from '../domain/hash';
import { integrityHash, integrityHashVersion, persistentId128 } from '../domain/id-hash-contract';
import type { Novel } from '../domain/types';
import { openBookContentRevision } from './content-revision-read-handle';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { BOOK_ASSET_STORES, type StoredBookAsset, type StoredBookAssetBlob } from './book-asset-schema';
import { openReaderDb } from './reader-database';
import { jsonValue, queueSyncEventInTransaction } from './sync-event-store';

function assetId(contentRevisionId: string): string {
  return `source_asset_${contentRevisionId}`;
}

function blobId(contentHash: string): string {
  return `asset_blob_${contentHash}`;
}

export async function stageOriginalSourceAsset(input: OriginalSourceAssetInput): Promise<BookAssetMetadata> {
  const now = new Date().toISOString();
  const id = assetId(input.contentRevisionId);
  const storageKey = blobId(input.contentHash);
  const metadata: StoredBookAsset = {
    id,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    kind: 'source',
    provenance: input.provenance ?? 'original',
    status: 'staged',
    storageKey,
    fileName: input.fileName,
    contentType: input.contentType || 'text/plain',
    byteLength: input.blob.size,
    contentHash: input.contentHash,
    encoding: input.encoding,
    createdAt: now,
  };
  const blobRecord: StoredBookAssetBlob = {
    id: storageKey,
    contentHash: input.contentHash,
    contentType: metadata.contentType,
    byteLength: input.blob.size,
    blob: input.blob,
    createdAt: now,
  };

  const db = await openReaderDb();
  const tx = db.transaction([BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs], 'readwrite');
  const done = transactionDone(tx);
  const existingBlob = await requestToPromise<StoredBookAssetBlob | undefined>(
    tx.objectStore(BOOK_ASSET_STORES.blobs).get(storageKey),
  );
  if (!existingBlob) tx.objectStore(BOOK_ASSET_STORES.blobs).put(blobRecord);
  tx.objectStore(BOOK_ASSET_STORES.assets).put(metadata);
  await done;
  return metadata;
}

export async function cleanupStagedBookAsset(id: string): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction([BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs], 'readwrite');
  const done = transactionDone(tx);
  const assetStore = tx.objectStore(BOOK_ASSET_STORES.assets);
  const asset = await requestToPromise<StoredBookAsset | undefined>(assetStore.get(id));
  if (asset?.status === 'staged') {
    assetStore.delete(id);
    const references = await requestToPromise<number>(assetStore.index('storageKey').count(asset.storageKey));
    if (references === 0) tx.objectStore(BOOK_ASSET_STORES.blobs).delete(asset.storageKey);
  }
  await done;
}

export async function stageEmbeddedBookAssets(
  bookId: string,
  contentRevisionId: string,
  assets: readonly ParsedNovelImportAsset[],
): Promise<string[]> {
  if (assets.length === 0) return [];
  const db = await openReaderDb();
  const now = new Date().toISOString();
  const tx = db.transaction([BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs], 'readwrite');
  const done = transactionDone(tx);
  const assetStore = tx.objectStore(BOOK_ASSET_STORES.assets);
  const blobStore = tx.objectStore(BOOK_ASSET_STORES.blobs);
  for (const asset of assets) {
    if (asset.bookId !== bookId || (asset.provenance !== 'epub_embedded' && asset.provenance !== 'archive_embedded')) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error('Embedded document resource identity does not match the imported book.');
    }
    const storageKey = blobId(asset.contentHash);
    if (!(await requestToPromise<StoredBookAssetBlob | undefined>(blobStore.get(storageKey)))) {
      blobStore.put({
        id: storageKey,
        contentHash: asset.contentHash,
        contentType: asset.contentType,
        byteLength: asset.bytes.byteLength,
        blob: new Blob([asset.bytes as BlobPart], { type: asset.contentType }),
        createdAt: now,
      } satisfies StoredBookAssetBlob);
    }
    assetStore.put({
      id: asset.id,
      bookId,
      contentRevisionId,
      kind: asset.kind,
      provenance: asset.provenance,
      status: 'staged',
      storageKey,
      fileName: asset.fileName,
      contentType: asset.contentType,
      byteLength: asset.bytes.byteLength,
      contentHash: asset.contentHash,
      pageIndex: asset.pageIndex,
      createdAt: now,
    } satisfies StoredBookAsset);
  }
  await done;
  return assets.map((asset) => asset.id);
}

export async function exportEmbeddedBookAsset(
  assetId: string,
): Promise<{ metadata: BookAssetMetadata; blob: Blob } | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction([BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs], 'readonly');
  const metadata = await requestToPromise<StoredBookAsset | undefined>(
    tx.objectStore(BOOK_ASSET_STORES.assets).get(assetId),
  );
  const stored = metadata
    ? await requestToPromise<StoredBookAssetBlob | undefined>(
        tx.objectStore(BOOK_ASSET_STORES.blobs).get(metadata.storageKey),
      )
    : undefined;
  await transactionDone(tx);
  if (!metadata || metadata.status !== 'active' || !stored) return undefined;
  if (metadata.kind !== 'cover' && metadata.kind !== 'epub_resource' && metadata.kind !== 'document_page') {
    return undefined;
  }
  return { metadata, blob: stored.blob };
}

export async function getActiveSourceAsset(bookId: string): Promise<BookAssetMetadata | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ASSET_STORES.assets, 'readonly');
  const matches = await requestToPromise<StoredBookAsset[]>(
    tx.objectStore(BOOK_ASSET_STORES.assets).index('bookId_kind_status').getAll([bookId, 'source', 'active']),
  );
  await transactionDone(tx);
  return matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export async function exportBookSource(bookId: string): Promise<ExportedBookSource | undefined> {
  const metadata = await getActiveSourceAsset(bookId);
  if (!metadata) return undefined;
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ASSET_STORES.blobs, 'readonly');
  const stored = await requestToPromise<StoredBookAssetBlob | undefined>(
    tx.objectStore(BOOK_ASSET_STORES.blobs).get(metadata.storageKey),
  );
  await transactionDone(tx);
  return stored ? { metadata, blob: stored.blob } : undefined;
}

export async function getActiveBookCover(bookId: string): Promise<ExportedBookCover | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction([BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs], 'readonly');
  const assets = await requestToPromise<StoredBookAsset[]>(
    tx.objectStore(BOOK_ASSET_STORES.assets).index('bookId_kind_status').getAll([bookId, 'cover', 'active']),
  );
  const metadata = assets.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const stored = metadata
    ? await requestToPromise<StoredBookAssetBlob | undefined>(
        tx.objectStore(BOOK_ASSET_STORES.blobs).get(metadata.storageKey),
      )
    : undefined;
  await transactionDone(tx);
  return metadata && stored ? { metadata, blob: stored.blob } : undefined;
}

function coverSyncNovel(novel: Novel) {
  return {
    id: novel.id,
    title: novel.title,
    favorite: novel.favorite,
    coverAssetId: novel.coverAssetId ?? null,
    coverContentHash: novel.coverContentHash ?? null,
    coverFit: novel.coverFit ?? 'crop',
    coverPositionX: novel.coverPositionX ?? 50,
    coverPositionY: novel.coverPositionY ?? 50,
    metadataRevision: novel.metadataRevision ?? 0,
    updatedAt: novel.updatedAt,
  };
}

export async function saveBookCover(bookId: string, input: BookCoverAssetInput): Promise<BookAssetMetadata> {
  const db = await openReaderDb();
  const now = new Date().toISOString();
  const id = persistentId128('cover_asset', [bookId, input.contentHash, now]);
  const storageKey = blobId(input.contentHash);
  const metadata: StoredBookAsset = {
    id,
    bookId,
    kind: 'cover',
    provenance: 'user_supplied',
    status: 'active',
    storageKey,
    fileName: input.fileName,
    contentType: input.contentType,
    byteLength: input.blob.size,
    contentHash: input.contentHash,
    pixelWidth: input.pixelWidth,
    pixelHeight: input.pixelHeight,
    createdAt: now,
    activatedAt: now,
  };
  const tx = db.transaction(
    ['novels', BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs, 'devices', 'sync_outbox', 'sync_state'],
    'readwrite',
  );
  const done = transactionDone(tx);
  const novelStore = tx.objectStore('novels');
  const assetStore = tx.objectStore(BOOK_ASSET_STORES.assets);
  const blobStore = tx.objectStore(BOOK_ASSET_STORES.blobs);
  const novel = await requestToPromise<Novel | undefined>(novelStore.get(bookId));
  if (!novel) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('책을 찾을 수 없습니다.');
  }
  const actualRevision = novel.metadataRevision ?? 0;
  if (input.expectedMetadataRevision !== undefined && input.expectedMetadataRevision !== actualRevision) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('다른 기기에서 책 정보가 변경되었습니다.');
  }
  const previous = await requestToPromise<StoredBookAsset[]>(
    assetStore.index('bookId_kind_status').getAll([bookId, 'cover', 'active']),
  );
  const existingBlob = await requestToPromise<StoredBookAssetBlob | undefined>(blobStore.get(storageKey));
  if (!existingBlob) {
    blobStore.put({
      id: storageKey,
      contentHash: input.contentHash,
      contentType: input.contentType,
      byteLength: input.blob.size,
      blob: input.blob,
      createdAt: now,
    } satisfies StoredBookAssetBlob);
  }
  assetStore.put(metadata);
  for (const asset of previous) {
    assetStore.delete(asset.id);
    if (asset.storageKey !== storageKey) {
      const count = await requestToPromise<number>(assetStore.index('storageKey').count(asset.storageKey));
      if (count === 0) blobStore.delete(asset.storageKey);
    }
  }
  const next: Novel = {
    ...novel,
    coverAssetId: id,
    coverContentHash: input.contentHash,
    coverFit: input.fit,
    coverPositionX: input.positionX,
    coverPositionY: input.positionY,
    metadataRevision: actualRevision + 1,
    updatedAt: now,
  };
  novelStore.put(next);
  await queueSyncEventInTransaction(
    tx,
    'book_updated',
    jsonValue({ novel: coverSyncNovel(next), coverMutation: 'replace' }),
    {
      novelId: bookId,
      entityId: bookId,
    },
  );
  await done;
  return metadata;
}

export async function saveGeneratedBookCover(
  bookId: string,
  input: GeneratedBookCoverInput,
): Promise<BookAssetMetadata | undefined> {
  const db = await openReaderDb();
  const now = new Date().toISOString();
  const id = persistentId128('generated_cover_asset', [bookId, input.derivationFingerprint]);
  const storageKey = blobId(input.contentHash);
  const tx = db.transaction(['novels', BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs], 'readwrite');
  const done = transactionDone(tx);
  const novelStore = tx.objectStore('novels');
  const assetStore = tx.objectStore(BOOK_ASSET_STORES.assets);
  const blobStore = tx.objectStore(BOOK_ASSET_STORES.blobs);
  const novel = await requestToPromise<Novel | undefined>(novelStore.get(bookId));
  if (!novel) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('책을 찾을 수 없습니다.');
  }
  const active = await requestToPromise<StoredBookAsset[]>(
    assetStore.index('bookId_kind_status').getAll([bookId, 'cover', 'active']),
  );
  const protectedCover = active.find((asset) => asset.provenance !== 'generated_preview');
  const activeNovelCover = active.find((asset) => asset.id === novel.coverAssetId);
  if (protectedCover || (novel.coverAssetId && activeNovelCover?.provenance !== 'generated_preview')) {
    await done;
    return undefined;
  }
  const current = active.find((asset) => asset.id === id && asset.contentHash === input.contentHash);
  if (current) {
    if (novel.coverAssetId !== current.id || novel.coverContentHash !== current.contentHash) {
      novelStore.put({
        ...novel,
        coverAssetId: current.id,
        coverContentHash: current.contentHash,
        coverFit: 'contain',
        coverPositionX: 50,
        coverPositionY: 50,
      } satisfies Novel);
    }
    await done;
    return current;
  }
  const metadata: StoredBookAsset = {
    id,
    bookId,
    contentRevisionId: novel.activeContentRevisionId,
    kind: 'cover',
    provenance: 'generated_preview',
    status: 'active',
    storageKey,
    fileName: input.fileName,
    contentType: input.contentType,
    byteLength: input.blob.size,
    contentHash: input.contentHash,
    pixelWidth: input.pixelWidth,
    pixelHeight: input.pixelHeight,
    createdAt: now,
    activatedAt: now,
  };
  if (!(await requestToPromise<StoredBookAssetBlob | undefined>(blobStore.get(storageKey)))) {
    blobStore.put({
      id: storageKey,
      contentHash: input.contentHash,
      contentType: input.contentType,
      byteLength: input.blob.size,
      blob: input.blob,
      createdAt: now,
    } satisfies StoredBookAssetBlob);
  }
  assetStore.put(metadata);
  for (const asset of active) {
    if (asset.id === id || asset.provenance !== 'generated_preview') continue;
    assetStore.delete(asset.id);
    if (asset.storageKey !== storageKey) {
      const count = await requestToPromise<number>(assetStore.index('storageKey').count(asset.storageKey));
      if (count === 0) blobStore.delete(asset.storageKey);
    }
  }
  novelStore.put({
    ...novel,
    coverAssetId: id,
    coverContentHash: input.contentHash,
    coverFit: 'contain',
    coverPositionX: 50,
    coverPositionY: 50,
  } satisfies Novel);
  await done;
  return metadata;
}

export async function removeBookCover(bookId: string, expectedMetadataRevision?: number): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(
    ['novels', BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs, 'devices', 'sync_outbox', 'sync_state'],
    'readwrite',
  );
  const done = transactionDone(tx);
  const novelStore = tx.objectStore('novels');
  const assetStore = tx.objectStore(BOOK_ASSET_STORES.assets);
  const blobStore = tx.objectStore(BOOK_ASSET_STORES.blobs);
  const novel = await requestToPromise<Novel | undefined>(novelStore.get(bookId));
  if (!novel) {
    await done;
    throw new Error('책을 찾을 수 없습니다.');
  }
  const actualRevision = novel.metadataRevision ?? 0;
  if (expectedMetadataRevision !== undefined && expectedMetadataRevision !== actualRevision) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('다른 기기에서 책 정보가 변경되었습니다.');
  }
  const active = await requestToPromise<StoredBookAsset[]>(
    assetStore.index('bookId_kind_status').getAll([bookId, 'cover', 'active']),
  );
  if (active.length === 0 && !novel.coverAssetId) {
    await done;
    return;
  }
  for (const asset of active) {
    assetStore.delete(asset.id);
    const count = await requestToPromise<number>(assetStore.index('storageKey').count(asset.storageKey));
    if (count === 0) blobStore.delete(asset.storageKey);
  }
  const now = new Date().toISOString();
  const next: Novel = {
    ...novel,
    coverAssetId: undefined,
    coverContentHash: undefined,
    coverFit: undefined,
    coverPositionX: undefined,
    coverPositionY: undefined,
    metadataRevision: actualRevision + 1,
    updatedAt: now,
  };
  novelStore.put(next);
  await queueSyncEventInTransaction(
    tx,
    'book_updated',
    jsonValue({ novel: coverSyncNovel(next), coverMutation: 'remove' }),
    {
      novelId: bookId,
      entityId: bookId,
    },
  );
  await done;
}

export async function cacheRemoteBookCover(metadata: BookAssetMetadata, blob: Blob): Promise<void> {
  if (metadata.kind !== 'cover' || metadata.status !== 'active') throw new Error('invalid remote cover metadata');
  const db = await openReaderDb();
  const storageKey = blobId(metadata.contentHash);
  const tx = db.transaction([BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs], 'readwrite');
  const done = transactionDone(tx);
  const assetStore = tx.objectStore(BOOK_ASSET_STORES.assets);
  const blobStore = tx.objectStore(BOOK_ASSET_STORES.blobs);
  const previous = await requestToPromise<StoredBookAsset[]>(
    assetStore.index('bookId_kind_status').getAll([metadata.bookId, 'cover', 'active']),
  );
  if (!(await requestToPromise<StoredBookAssetBlob | undefined>(blobStore.get(storageKey)))) {
    blobStore.put({
      id: storageKey,
      contentHash: metadata.contentHash,
      contentType: metadata.contentType,
      byteLength: blob.size,
      blob,
      createdAt: metadata.createdAt,
    } satisfies StoredBookAssetBlob);
  }
  assetStore.put({ ...metadata, storageKey } satisfies StoredBookAsset);
  for (const asset of previous) {
    if (asset.id === metadata.id) continue;
    assetStore.delete(asset.id);
    if (asset.storageKey !== storageKey) {
      const references = await requestToPromise<number>(assetStore.index('storageKey').count(asset.storageKey));
      if (references === 0) blobStore.delete(asset.storageKey);
    }
  }
  await done;
}

export async function clearCachedRemoteBookCover(bookId: string): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction([BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs], 'readwrite');
  const done = transactionDone(tx);
  const assetStore = tx.objectStore(BOOK_ASSET_STORES.assets);
  const blobStore = tx.objectStore(BOOK_ASSET_STORES.blobs);
  const active = await requestToPromise<StoredBookAsset[]>(
    assetStore.index('bookId_kind_status').getAll([bookId, 'cover', 'active']),
  );
  for (const asset of active) {
    assetStore.delete(asset.id);
    const references = await requestToPromise<number>(assetStore.index('storageKey').count(asset.storageKey));
    if (references === 0) blobStore.delete(asset.storageKey);
  }
  await done;
}

function sourceMatches(expectedHash: string, bytes: ArrayBuffer, encoding?: string): boolean {
  const version = integrityHashVersion(expectedHash);
  if (version === 'v2-sha256-tagged') return integrityHash(bytes) === expectedHash;
  if (version === 'v1-sha256') return integrityHash(bytes).slice('sha256:'.length) === expectedHash;
  if (version !== 'v1-fnv32') return false;
  const decoder = new TextDecoder(encoding === 'euc-kr' ? 'euc-kr' : 'utf-8');
  return hashSync(decoder.decode(bytes)) === expectedHash;
}

export async function reselectOriginalBookSource(
  bookId: string,
  input: ReselectedBookSourceInput,
): Promise<BookAssetMetadata> {
  const bytes = await input.blob.arrayBuffer();
  const db = await openReaderDb();
  const readTx = db.transaction('novels', 'readonly');
  const novel = await requestToPromise<Novel | undefined>(readTx.objectStore('novels').get(bookId));
  await transactionDone(readTx);
  if (!novel) throw new Error('책을 찾을 수 없습니다.');
  if (!novel.activeContentRevisionId) throw new Error('이 책은 원본을 연결할 content revision이 없습니다.');
  if (!sourceMatches(novel.rawTextHash, bytes, novel.sourceEncoding)) throw new OriginalSourceMismatchError();

  const contentHash = integrityHash(bytes);
  return persistActiveBookSource(
    db,
    { ...novel, activeContentRevisionId: novel.activeContentRevisionId },
    {
      blob: input.blob,
      contentHash,
      fileName: input.fileName,
      contentType: input.contentType || 'text/plain',
      provenance: 'original',
      encoding: novel.sourceEncoding ?? 'auto',
    },
  );
}

async function persistActiveBookSource(
  db: IDBDatabase,
  novel: Novel & { activeContentRevisionId: string },
  input: {
    blob: Blob;
    contentHash: string;
    fileName: string;
    contentType: string;
    provenance: 'original' | 'canonical_reconstruction';
    encoding: 'utf-8' | 'euc-kr' | 'auto';
  },
): Promise<BookAssetMetadata> {
  const now = new Date().toISOString();
  const id = assetId(novel.activeContentRevisionId);
  const storageKey = blobId(input.contentHash);
  const metadata: StoredBookAsset = {
    id,
    bookId: novel.id,
    contentRevisionId: novel.activeContentRevisionId,
    kind: 'source',
    provenance: input.provenance,
    status: 'active',
    storageKey,
    fileName: input.fileName,
    contentType: input.contentType,
    byteLength: input.blob.size,
    contentHash: input.contentHash,
    encoding: input.encoding,
    createdAt: now,
    activatedAt: now,
  };
  const tx = db.transaction(['novels', BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs], 'readwrite');
  const done = transactionDone(tx);
  const assetStore = tx.objectStore(BOOK_ASSET_STORES.assets);
  const blobStore = tx.objectStore(BOOK_ASSET_STORES.blobs);
  const previous = await requestToPromise<StoredBookAsset | undefined>(assetStore.get(id));
  const existingBlob = await requestToPromise<StoredBookAssetBlob | undefined>(blobStore.get(storageKey));
  if (!existingBlob) {
    blobStore.put({
      id: storageKey,
      contentHash: input.contentHash,
      contentType: metadata.contentType,
      byteLength: input.blob.size,
      blob: input.blob,
      createdAt: now,
    } satisfies StoredBookAssetBlob);
  }
  assetStore.put(metadata);
  tx.objectStore('novels').put({
    ...novel,
    sourceAssetId: id,
    sourceProvenance: input.provenance,
    sourceByteLength: input.blob.size,
    sourceContentType: metadata.contentType,
    sourceContentHash: input.contentHash,
    sourceFileName: input.fileName,
    updatedAt: now,
  });
  if (previous?.storageKey && previous.storageKey !== storageKey) {
    const references = await requestToPromise<number>(assetStore.index('storageKey').count(previous.storageKey));
    if (references === 0) blobStore.delete(previous.storageKey);
  }
  await done;
  return metadata;
}

export async function reconstructCanonicalBookSource(bookId: string): Promise<BookAssetMetadata> {
  const db = await openReaderDb();
  const handle = await openBookContentRevision(db, bookId);
  if (!handle.contentRevisionId) throw new Error('이 책은 재구성할 active content revision이 없습니다.');
  const sections: string[] = [];
  for (const chapter of await handle.listChapters()) {
    const pages = await handle.listParagraphPages(chapter.id);
    const body = pages
      .sort((left, right) => left.pageIndex - right.pageIndex)
      .flatMap((page) => page.paragraphs)
      .sort((left, right) => left.index - right.index)
      .map((paragraph) => paragraph.text)
      .join('\n\n');
    sections.push([chapter.title.trim(), body].filter(Boolean).join('\n\n'));
  }
  const text = sections.join('\n\n\n').trim();
  if (!text) throw new Error('저장된 본문이 없어 source를 재구성할 수 없습니다.');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const bytes = await blob.arrayBuffer();
  return persistActiveBookSource(
    db,
    { ...handle.novel, activeContentRevisionId: handle.contentRevisionId },
    {
      blob,
      contentHash: integrityHash(bytes),
      fileName: `${handle.novel.title}.reconstructed.txt`,
      contentType: 'text/plain;charset=utf-8',
      provenance: 'canonical_reconstruction',
      encoding: 'utf-8',
    },
  );
}

export function deleteBookAssetsInTransaction(tx: IDBTransaction, bookId: string): void {
  const assetStore = tx.objectStore(BOOK_ASSET_STORES.assets);
  const request = assetStore.index('bookId').openCursor(bookId);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const asset = cursor.value as StoredBookAsset;
    const storageKey = asset.storageKey;
    cursor.delete();
    const countRequest = assetStore.index('storageKey').count(storageKey);
    countRequest.onsuccess = () => {
      if (countRequest.result === 0) tx.objectStore(BOOK_ASSET_STORES.blobs).delete(storageKey);
    };
    cursor.continue();
  };
}
