import type {
  Bookmark,
  Chapter,
  Novel,
  Paragraph,
  ParagraphPage,
  ReaderHighlight,
  ReaderNote,
  ReadingPosition,
  LabeledSegment,
  UserCorrection,
} from '../domain/types';
import type { ChapterStructureReviewItem } from '../repositories/chapter-structure-repository';
import { CHAPTER_STRUCTURE_STORES } from './chapter-structure-schema';
import type { SyncOutboxItem, SyncState } from '../sync/types';
import {
  assertContentRevisionBase,
  type BookContentRevisionRecord,
  type BookContentRevisionSource,
  ContentRevisionConflictError,
  type ContentRevisionExpectedCounts,
  createAppendDeltaContentRevisionComposition,
  createContentRevisionId,
  revisionScopedStorageId,
  type StoredContentRevisionCounts,
  validateStoredContentRevisionCounts,
} from './content-revisions';
import { CONTENT_REVISION_STORES } from './content-revision-migration';
import { READER_ANCHOR_QUARANTINE_STORE, type ReaderAnchorQuarantineRecord } from './reader-anchor-quarantine';
import { BOOK_ASSET_STORES, type StoredBookAsset } from './book-asset-schema';
import { activateEmbeddedAssetsInTransaction, activateSourceAssetInTransaction } from './book-asset-transaction';

export interface StoredParagraphRef extends Paragraph {
  pageIndex?: number;
  textStorageMode?: 'page';
}

export interface ParagraphSearchRow {
  id: string;
  novelId: string;
  chapterId: string;
  paragraphId: string;
  pageId: string;
  pageIndex: number;
  paragraphIndex: number;
  /**
   * Legacy rows persist this lowercase copy. New rows derive it while scanning
   * so the body is not stored twice solely for case-insensitive search.
   */
  textLower?: string;
  paragraph: Paragraph;
}

export interface RevisionScopedRow {
  storageId: string;
  contentRevisionId: string;
}

export interface RevisionChapterRow extends Chapter, RevisionScopedRow {}
export interface RevisionParagraphRefRow extends StoredParagraphRef, RevisionScopedRow {}
export interface RevisionParagraphPageRow extends ParagraphPage, RevisionScopedRow {
  /** New page-canonical rows expose paragraph lookup without one metadata row per paragraph. */
  paragraphIds?: string[];
}
export interface RevisionParagraphSearchRow extends ParagraphSearchRow, RevisionScopedRow {}

export type ContentDomainEntity = 'chapter' | 'paragraph';

export interface ContentDomainHead {
  id: string;
  entityType: ContentDomainEntity;
  domainId: string;
  novelId: string;
  contentRevisionId: string;
}

export interface ContentActivationReaderPlan {
  expectedSyncNextSequence?: number;
  nextSyncSequence?: number;
  readingPosition?: ReadingPosition;
  deleteReadingPosition?: boolean;
  bookmarks: Bookmark[];
  highlights: ReaderHighlight[];
  notes: ReaderNote[];
  outboxItems: SyncOutboxItem[];
  deleteBookmarkIds?: string[];
  deleteHighlightIds?: string[];
  deleteNoteIds?: string[];
  deleteOutboxItemIds?: string[];
  quarantineRecords?: ReaderAnchorQuarantineRecord[];
  segments?: LabeledSegment[];
  deleteSegmentIds?: string[];
  corrections?: UserCorrection[];
  deleteCorrectionIds?: string[];
  structureReviewItems?: ChapterStructureReviewItem[];
  clearVoiceProductState?: boolean;
}

type ReaderManagedNovelState = Pick<
  Novel,
  | 'lastReadChapterId'
  | 'lastReadChapterIndex'
  | 'lastReadParagraphId'
  | 'lastReadOffset'
  | 'lastReadProgress'
  | 'readingSeconds'
  | 'lastReadAt'
  | 'favorite'
>;

type UserManagedNovelMetadata = Pick<
  Novel,
  | 'cloudVaultBookId'
  | 'title'
  | 'author'
  | 'seriesTitle'
  | 'seriesIndex'
  | 'tags'
  | 'description'
  | 'language'
  | 'readingDirection'
  | 'coverAssetId'
  | 'coverContentHash'
  | 'coverFit'
  | 'coverPositionX'
  | 'coverPositionY'
  | 'coverUpdatedAt'
  | 'coverRemovedAt'
  | 'coverSeed'
  | 'metadataRevision'
  | 'deletedAt'
  | 'deletedByDeviceId'
>;

type MutableNovelMetadata = ReaderManagedNovelState & UserManagedNovelMetadata;

interface StoredBookContentRevisionRecord extends BookContentRevisionRecord {
  baseMutableMetadata?: MutableNovelMetadata;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function deleteByIndexInTransaction(
  tx: IDBTransaction,
  storeName: string,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
): void {
  const store = tx.objectStore(storeName);
  const request = store.index(indexName).openKeyCursor(query);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    store.delete(cursor.primaryKey);
    cursor.continue();
  };
}

function deleteStagedAssetsForRevisionInTransaction(tx: IDBTransaction, contentRevisionId: string): void {
  const assetStore = tx.objectStore(BOOK_ASSET_STORES.assets);
  const blobStore = tx.objectStore(BOOK_ASSET_STORES.blobs);
  const request = assetStore.index('contentRevisionId').openCursor(contentRevisionId);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const asset = cursor.value as StoredBookAsset;
    if (asset.status === 'staged') {
      cursor.delete();
      const countRequest = assetStore.index('storageKey').count(asset.storageKey);
      countRequest.onsuccess = () => {
        if (countRequest.result === 0) blobStore.delete(asset.storageKey);
      };
    }
    cursor.continue();
  };
}

function chunked<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += safeSize) {
    chunks.push(items.slice(start, start + safeSize));
  }
  return chunks;
}

export function storedNovel(novel: Novel): Novel {
  return { ...novel, rawText: '', normalizedText: '' };
}

export function storedChapter(chapter: Chapter): Chapter {
  return { ...chapter, normalizedText: '' };
}

function novelForContentActivation(
  input: Novel,
  current: Novel | undefined,
  contentRevisionId: string,
  _base: MutableNovelMetadata | undefined,
  _localImport: boolean,
): Novel {
  const imported = { ...input, activeContentRevisionId: contentRevisionId };
  if (!current) return storedNovel(imported);
  // A content replacement owns body-derived fields (format, hashes, counts and
  // source filename), while library metadata and reader state are owned by the
  // user. Keep those user-owned values unless an explicit metadata/cover
  // mutation applies them through its own revision-checked transaction.
  return storedNovel({
    ...imported,
    cloudVaultBookId: current.cloudVaultBookId,
    title: current.title,
    author: current.author,
    seriesTitle: current.seriesTitle,
    seriesIndex: current.seriesIndex,
    tags: current.tags ? [...current.tags] : undefined,
    description: current.description,
    language: current.language,
    readingDirection: current.readingDirection,
    coverAssetId: current.coverAssetId,
    coverContentHash: current.coverContentHash,
    coverFit: current.coverFit,
    coverPositionX: current.coverPositionX,
    coverPositionY: current.coverPositionY,
    coverUpdatedAt: current.coverUpdatedAt,
    coverRemovedAt: current.coverRemovedAt,
    coverSeed: current.coverSeed,
    metadataRevision: current.metadataRevision,
    deletedAt: current.deletedAt,
    deletedByDeviceId: current.deletedByDeviceId,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt > input.updatedAt ? current.updatedAt : input.updatedAt,
    lastReadChapterId: current.lastReadChapterId,
    lastReadChapterIndex: current.lastReadChapterIndex,
    lastReadParagraphId: current.lastReadParagraphId,
    lastReadOffset: current.lastReadOffset,
    lastReadProgress: current.lastReadProgress,
    readingSeconds: current.readingSeconds,
    lastReadAt: current.lastReadAt,
    favorite: current.favorite,
    // Keep the previous source pointer unless this activation explicitly
    // staged a replacement; the activation step below installs that new source
    // atomically when one is present.
    sourceAssetId: current.sourceAssetId,
    sourceProvenance: current.sourceProvenance,
    sourceByteLength: current.sourceByteLength,
    sourceContentType: current.sourceContentType,
    sourceContentHash: current.sourceContentHash,
  });
}

function mutableNovelMetadata(novel: Novel): MutableNovelMetadata {
  return {
    cloudVaultBookId: novel.cloudVaultBookId,
    title: novel.title,
    author: novel.author,
    seriesTitle: novel.seriesTitle,
    seriesIndex: novel.seriesIndex,
    tags: novel.tags ? [...novel.tags] : undefined,
    description: novel.description,
    language: novel.language,
    readingDirection: novel.readingDirection,
    coverAssetId: novel.coverAssetId,
    coverContentHash: novel.coverContentHash,
    coverFit: novel.coverFit,
    coverPositionX: novel.coverPositionX,
    coverPositionY: novel.coverPositionY,
    coverUpdatedAt: novel.coverUpdatedAt,
    coverRemovedAt: novel.coverRemovedAt,
    coverSeed: novel.coverSeed,
    metadataRevision: novel.metadataRevision,
    deletedAt: novel.deletedAt,
    deletedByDeviceId: novel.deletedByDeviceId,
    lastReadChapterId: novel.lastReadChapterId,
    lastReadChapterIndex: novel.lastReadChapterIndex,
    lastReadParagraphId: novel.lastReadParagraphId,
    lastReadOffset: novel.lastReadOffset,
    lastReadProgress: novel.lastReadProgress,
    readingSeconds: novel.readingSeconds,
    lastReadAt: novel.lastReadAt,
    favorite: novel.favorite,
  };
}

export function pageBackedParagraphRef(paragraph: Paragraph, pageIndex: number): StoredParagraphRef {
  return { ...paragraph, pageIndex, text: '', textStorageMode: 'page' };
}

function paragraphSearchRowId(page: ParagraphPage, paragraph: Paragraph): string {
  return `search_${page.id}_${paragraph.index}`;
}

export function paragraphSearchRow(page: ParagraphPage, paragraph: Paragraph): ParagraphSearchRow {
  return {
    id: paragraphSearchRowId(page, paragraph),
    novelId: paragraph.novelId,
    chapterId: paragraph.chapterId,
    paragraphId: paragraph.id,
    pageId: page.id,
    pageIndex: page.pageIndex,
    paragraphIndex: paragraph.index,
    paragraph,
  };
}

export function putParagraphSearchRowsForPage(store: IDBObjectStore, page: ParagraphPage): void {
  page.paragraphs.forEach((paragraph) => store.put(paragraphSearchRow(page, paragraph)));
}

function revisionChapterRow(contentRevisionId: string, chapter: Chapter): RevisionChapterRow {
  return {
    ...storedChapter(chapter),
    storageId: revisionScopedStorageId(contentRevisionId, chapter.id),
    contentRevisionId,
  };
}

function revisionParagraphPageRow(contentRevisionId: string, page: ParagraphPage): RevisionParagraphPageRow {
  return {
    ...page,
    paragraphIds: page.paragraphs.map((paragraph) => paragraph.id),
    storageId: revisionScopedStorageId(contentRevisionId, page.id),
    contentRevisionId,
  };
}

export function revisionParagraphSearchRow(
  contentRevisionId: string,
  page: ParagraphPage,
  paragraph: Paragraph,
): RevisionParagraphSearchRow {
  const row = paragraphSearchRow(page, paragraph);
  return {
    ...row,
    storageId: revisionScopedStorageId(contentRevisionId, row.id),
    contentRevisionId,
  };
}

export function chapterFromRevisionRow(row: RevisionChapterRow): Chapter {
  const { storageId: _storageId, contentRevisionId: _contentRevisionId, ...chapter } = row;
  return chapter;
}

export function paragraphFromRevisionRow(row: RevisionParagraphRefRow): StoredParagraphRef {
  const { storageId: _storageId, contentRevisionId: _contentRevisionId, ...paragraph } = row;
  return paragraph;
}

export function pageFromRevisionRow(row: RevisionParagraphPageRow): ParagraphPage {
  const { storageId: _storageId, contentRevisionId: _contentRevisionId, paragraphIds: _paragraphIds, ...page } = row;
  return page;
}

export function searchRowFromRevisionRow(row: RevisionParagraphSearchRow): ParagraphSearchRow {
  const { storageId: _storageId, contentRevisionId: _contentRevisionId, ...searchRow } = row;
  return searchRow;
}

export function contentDomainHeadId(entityType: ContentDomainEntity, domainId: string): string {
  return JSON.stringify([entityType, domainId]);
}

export async function createStagingContentRevision(
  db: IDBDatabase,
  input: {
    novel: Novel;
    source: BookContentRevisionSource;
    sourceRevision?: string;
    sourceHash?: string;
    expected: ContentRevisionExpectedCounts;
    expectedBaseActiveContentRevisionId?: string;
    appendDelta?: {
      baseRevision: BookContentRevisionRecord;
      logicalCounts: StoredContentRevisionCounts;
    };
  },
): Promise<BookContentRevisionRecord> {
  const tx = db.transaction(['novels', CONTENT_REVISION_STORES.revisions], 'readwrite');
  const currentNovel = await requestToPromise<Novel | undefined>(tx.objectStore('novels').get(input.novel.id));
  if (
    input.expectedBaseActiveContentRevisionId !== undefined &&
    currentNovel?.activeContentRevisionId !== input.expectedBaseActiveContentRevisionId
  ) {
    tx.abort();
    throw new ContentRevisionConflictError('active content revision changed before replacement staging');
  }
  if (
    input.appendDelta &&
    (input.appendDelta.baseRevision.novelId !== input.novel.id ||
      input.appendDelta.baseRevision.id !== currentNovel?.activeContentRevisionId ||
      input.appendDelta.baseRevision.status !== 'active')
  ) {
    tx.abort();
    throw new ContentRevisionConflictError('active content revision changed before append staging');
  }
  const revisionId = createContentRevisionId();
  const revision: StoredBookContentRevisionRecord = {
    id: revisionId,
    novelId: input.novel.id,
    status: 'staging',
    source: input.source,
    sourceRevision: input.sourceRevision,
    sourceHash: input.sourceHash,
    normalizedHash: input.novel.normalizedTextHash || undefined,
    baseActiveRevisionId: currentNovel?.activeContentRevisionId,
    baseNovelPresent: Boolean(currentNovel),
    baseMutableMetadata: currentNovel ? mutableNovelMetadata(currentNovel) : undefined,
    expected: input.expected,
    composition: input.appendDelta
      ? createAppendDeltaContentRevisionComposition({
          revisionId,
          baseRevision: input.appendDelta.baseRevision,
          logicalCounts: input.appendDelta.logicalCounts,
        })
      : undefined,
    stagedCounts: {
      chapterCount: 0,
      pageCount: 0,
      paragraphCount: 0,
      paragraphRefCount: 0,
      searchRowCount: 0,
    },
    createdAt: new Date().toISOString(),
  };
  tx.objectStore(CONTENT_REVISION_STORES.revisions).put(revision);
  await transactionDone(tx);
  return revision;
}

export async function saveStagedContentChapters(
  db: IDBDatabase,
  contentRevisionId: string,
  chapters: Chapter[],
  options: { batchSize: number; throwIfCancelled(): void },
): Promise<number> {
  let chaptersWritten = 0;
  for (const batch of chunked(chapters, options.batchSize)) {
    options.throwIfCancelled();
    const tx = db.transaction([CONTENT_REVISION_STORES.revisions, CONTENT_REVISION_STORES.chapters], 'readwrite');
    const done = transactionDone(tx);
    try {
      const revisionStore = tx.objectStore(CONTENT_REVISION_STORES.revisions);
      const revision = await requestToPromise<StoredBookContentRevisionRecord | undefined>(
        revisionStore.get(contentRevisionId),
      );
      if (!revision || revision.status !== 'staging') {
        throw new Error(`Content revision ${contentRevisionId} is not staging`);
      }
      const store = tx.objectStore(CONTENT_REVISION_STORES.chapters);
      batch.forEach((chapter) => store.put(revisionChapterRow(contentRevisionId, chapter)));
      if (revision.stagedCounts) {
        revisionStore.put({
          ...revision,
          stagedCounts: {
            ...revision.stagedCounts,
            chapterCount: revision.stagedCounts.chapterCount + batch.length,
          },
        } satisfies StoredBookContentRevisionRecord);
      }
      await done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction may already have aborted because of a failed request.
      }
      await done.catch(() => undefined);
      throw error;
    }
    chaptersWritten += batch.length;
    options.throwIfCancelled();
  }
  return chaptersWritten;
}

export async function saveStagedContentPageBatch(
  db: IDBDatabase,
  contentRevisionId: string,
  pages: ParagraphPage[],
): Promise<void> {
  if (!pages.length) return;
  const tx = db.transaction([CONTENT_REVISION_STORES.revisions, CONTENT_REVISION_STORES.pages], 'readwrite');
  const done = transactionDone(tx);
  try {
    const revisionStore = tx.objectStore(CONTENT_REVISION_STORES.revisions);
    const revision = await requestToPromise<StoredBookContentRevisionRecord | undefined>(
      revisionStore.get(contentRevisionId),
    );
    if (!revision || revision.status !== 'staging') {
      throw new Error(`Content revision ${contentRevisionId} is not staging`);
    }
    const pageStore = tx.objectStore(CONTENT_REVISION_STORES.pages);
    let paragraphCount = 0;
    pages.forEach((page) => {
      pageStore.put(revisionParagraphPageRow(contentRevisionId, page));
      paragraphCount += page.paragraphs.length;
    });
    if (revision.stagedCounts) {
      revisionStore.put({
        ...revision,
        stagedCounts: {
          chapterCount: revision.stagedCounts.chapterCount,
          pageCount: revision.stagedCounts.pageCount + pages.length,
          paragraphCount: revision.stagedCounts.paragraphCount + paragraphCount,
          paragraphRefCount: revision.stagedCounts.paragraphRefCount + paragraphCount,
          searchRowCount: revision.stagedCounts.searchRowCount + paragraphCount,
        },
      } satisfies StoredBookContentRevisionRecord);
    }
    await done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have aborted because of a failed request.
    }
    await done.catch(() => undefined);
    throw error;
  }
}

export async function cleanupStagingContentRevision(db: IDBDatabase, contentRevisionId: string): Promise<void> {
  const tx = db.transaction(
    [...Object.values(CONTENT_REVISION_STORES), BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs],
    'readwrite',
  );
  const revisionStore = tx.objectStore(CONTENT_REVISION_STORES.revisions);
  const revision = await requestToPromise<BookContentRevisionRecord | undefined>(revisionStore.get(contentRevisionId));
  if (revision?.status === 'staging') {
    deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.chapters, 'contentRevisionId', contentRevisionId);
    deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.paragraphs, 'contentRevisionId', contentRevisionId);
    deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.pages, 'contentRevisionId', contentRevisionId);
    deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.search, 'contentRevisionId', contentRevisionId);
    deleteStagedAssetsForRevisionInTransaction(tx, contentRevisionId);
    revisionStore.delete(contentRevisionId);
  }
  await transactionDone(tx);
}

const DEFAULT_STALE_IMPORT_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_STALE_IMPORT_BATCH_SIZE = 8;

export interface StaleImportCleanupReport {
  readonly revisionsRemoved: number;
  readonly orphanedAssetsRemoved: number;
}

function createdBefore(createdAt: string, cutoff: number): boolean {
  const value = Date.parse(createdAt);
  return Number.isFinite(value) && value <= cutoff;
}

async function collectStaleRevisionIds(db: IDBDatabase, cutoff: number, limit: number): Promise<string[]> {
  const tx = db.transaction(CONTENT_REVISION_STORES.revisions, 'readonly');
  const ids: string[] = [];
  const request = tx
    .objectStore(CONTENT_REVISION_STORES.revisions)
    .index('status')
    .openCursor(IDBKeyRange.only('staging'));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor || ids.length >= limit) return;
    const revision = cursor.value as BookContentRevisionRecord;
    if (createdBefore(revision.createdAt, cutoff)) ids.push(revision.id);
    cursor.continue();
  };
  await transactionDone(tx);
  return ids;
}

async function removeStaleRevision(db: IDBDatabase, contentRevisionId: string, cutoff: number): Promise<boolean> {
  const tx = db.transaction(
    ['novels', ...Object.values(CONTENT_REVISION_STORES), BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs],
    'readwrite',
  );
  const revisionStore = tx.objectStore(CONTENT_REVISION_STORES.revisions);
  const revision = await requestToPromise<BookContentRevisionRecord | undefined>(revisionStore.get(contentRevisionId));
  const novel = revision
    ? await requestToPromise<Novel | undefined>(tx.objectStore('novels').get(revision.novelId))
    : undefined;
  if (
    !revision ||
    revision.status !== 'staging' ||
    !createdBefore(revision.createdAt, cutoff) ||
    novel?.activeContentRevisionId === contentRevisionId
  ) {
    await transactionDone(tx);
    return false;
  }
  deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.chapters, 'contentRevisionId', contentRevisionId);
  deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.paragraphs, 'contentRevisionId', contentRevisionId);
  deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.pages, 'contentRevisionId', contentRevisionId);
  deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.search, 'contentRevisionId', contentRevisionId);
  deleteStagedAssetsForRevisionInTransaction(tx, contentRevisionId);
  revisionStore.delete(contentRevisionId);
  await transactionDone(tx);
  return true;
}

async function collectOrphanedStagedAssetIds(db: IDBDatabase, cutoff: number, limit: number): Promise<string[]> {
  const tx = db.transaction([CONTENT_REVISION_STORES.revisions, BOOK_ASSET_STORES.assets], 'readonly');
  const revisionStore = tx.objectStore(CONTENT_REVISION_STORES.revisions);
  const ids: string[] = [];
  const request = tx.objectStore(BOOK_ASSET_STORES.assets).index('status').openCursor(IDBKeyRange.only('staged'));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor || ids.length >= limit) return;
    const asset = cursor.value as StoredBookAsset;
    if (!createdBefore(asset.createdAt, cutoff)) {
      cursor.continue();
      return;
    }
    const revisionRequest = asset.contentRevisionId ? revisionStore.get(asset.contentRevisionId) : undefined;
    if (!revisionRequest) {
      ids.push(asset.id);
      cursor.continue();
      return;
    }
    revisionRequest.onsuccess = () => {
      const revision = revisionRequest.result as BookContentRevisionRecord | undefined;
      if (!revision || revision.status !== 'staging') ids.push(asset.id);
      cursor.continue();
    };
    revisionRequest.onerror = () => tx.abort();
  };
  await transactionDone(tx);
  return ids;
}

async function removeOrphanedStagedAsset(db: IDBDatabase, assetId: string, cutoff: number): Promise<boolean> {
  const tx = db.transaction(
    [CONTENT_REVISION_STORES.revisions, BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs],
    'readwrite',
  );
  const assetStore = tx.objectStore(BOOK_ASSET_STORES.assets);
  const asset = await requestToPromise<StoredBookAsset | undefined>(assetStore.get(assetId));
  const revision = asset?.contentRevisionId
    ? await requestToPromise<BookContentRevisionRecord | undefined>(
        tx.objectStore(CONTENT_REVISION_STORES.revisions).get(asset.contentRevisionId),
      )
    : undefined;
  if (
    !asset ||
    asset.status !== 'staged' ||
    !createdBefore(asset.createdAt, cutoff) ||
    revision?.status === 'staging'
  ) {
    await transactionDone(tx);
    return false;
  }
  assetStore.delete(asset.id);
  const references = await requestToPromise<number>(assetStore.index('storageKey').count(asset.storageKey));
  if (references === 0) tx.objectStore(BOOK_ASSET_STORES.blobs).delete(asset.storageKey);
  await transactionDone(tx);
  return true;
}

/**
 * Removes a small, age-gated batch of import artifacts left behind by a tab or
 * process crash. Active/recent staging rows are rechecked in the write
 * transaction and are never selected solely because they are inactive.
 */
export async function cleanupStaleImportArtifacts(
  db: IDBDatabase,
  options: { readonly now?: number; readonly olderThanMs?: number; readonly limit?: number } = {},
): Promise<StaleImportCleanupReport> {
  const now = options.now ?? Date.now();
  const olderThanMs = Math.max(60_000, options.olderThanMs ?? DEFAULT_STALE_IMPORT_AGE_MS);
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_STALE_IMPORT_BATCH_SIZE));
  const cutoff = now - olderThanMs;
  const staleRevisionIds = await collectStaleRevisionIds(db, cutoff, limit);
  let revisionsRemoved = 0;
  for (const id of staleRevisionIds) {
    if (await removeStaleRevision(db, id, cutoff)) revisionsRemoved += 1;
  }
  const orphanedAssetIds = await collectOrphanedStagedAssetIds(db, cutoff, limit);
  let orphanedAssetsRemoved = 0;
  for (const id of orphanedAssetIds) {
    if (await removeOrphanedStagedAsset(db, id, cutoff)) orphanedAssetsRemoved += 1;
  }
  return { revisionsRemoved, orphanedAssetsRemoved };
}

function upsertChapterDomainHeadsInTransaction(
  tx: IDBTransaction,
  contentRevisionId: string,
  shouldCancel?: () => boolean,
): void {
  const abortIfCancelled = () => {
    if (!shouldCancel?.()) return false;
    tx.abort();
    return true;
  };
  const headStore = tx.objectStore(CONTENT_REVISION_STORES.heads);
  const request = tx
    .objectStore(CONTENT_REVISION_STORES.chapters)
    .index('contentRevisionId')
    .openCursor(contentRevisionId);
  request.onsuccess = () => {
    if (abortIfCancelled()) return;
    const cursor = request.result;
    if (!cursor) return;
    const row = cursor.value as RevisionScopedRow & { id: string; novelId: string };
    const head: ContentDomainHead = {
      id: contentDomainHeadId('chapter', row.id),
      entityType: 'chapter',
      domainId: row.id,
      novelId: row.novelId,
      contentRevisionId,
    };
    headStore.put(head);
    cursor.continue();
  };
}

function loadStagingRevisionAndCounts(
  tx: IDBTransaction,
  contentRevisionId: string,
): Promise<{
  revision?: StoredBookContentRevisionRecord;
  counts?: StoredContentRevisionCounts;
}> {
  const revisionStore = tx.objectStore(CONTENT_REVISION_STORES.revisions);
  const request = revisionStore.get(contentRevisionId);
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const revision = request.result as StoredBookContentRevisionRecord | undefined;
      if (!revision || revision.stagedCounts) {
        resolve({ revision, counts: revision?.stagedCounts });
        return;
      }
      // Compatibility fallback for staging rows created before stagedCounts was introduced
      // and for focused callers that deliberately construct a legacy revision record.
      Promise.all([
        requestToPromise<number>(
          tx.objectStore(CONTENT_REVISION_STORES.chapters).index('contentRevisionId').count(contentRevisionId),
        ),
        requestToPromise<number>(
          tx.objectStore(CONTENT_REVISION_STORES.paragraphs).index('contentRevisionId').count(contentRevisionId),
        ),
        requestToPromise<number>(
          tx.objectStore(CONTENT_REVISION_STORES.pages).index('contentRevisionId').count(contentRevisionId),
        ),
        requestToPromise<number>(
          tx.objectStore(CONTENT_REVISION_STORES.search).index('contentRevisionId').count(contentRevisionId),
        ),
      ]).then(
        ([chapterCount, paragraphRefCount, pageCount, searchRowCount]) =>
          resolve({
            revision,
            counts: {
              chapterCount,
              pageCount,
              paragraphCount: paragraphRefCount,
              paragraphRefCount,
              searchRowCount,
            },
          }),
        reject,
      );
    };
  });
}

export async function activateStagedContentRevision(
  db: IDBDatabase,
  input: {
    revision: BookContentRevisionRecord;
    actual: StoredContentRevisionCounts;
    novel: Novel;
    readerPlan?: ContentActivationReaderPlan;
    queueBookImported?: (tx: IDBTransaction, novel: Novel) => Promise<void>;
    shouldCancel?: () => boolean;
    sourceAssetId?: string;
    embeddedAssetIds?: readonly string[];
    preserveExistingEmbeddedAssets?: boolean;
    preserveExistingCover?: boolean;
  },
): Promise<void> {
  const tx = db.transaction(
    [
      'novels',
      ...Object.values(CONTENT_REVISION_STORES),
      'reading_positions',
      'bookmarks',
      'highlights',
      'notes',
      'devices',
      'sync_outbox',
      'sync_state',
      READER_ANCHOR_QUARANTINE_STORE,
      ...(input.readerPlan?.segments || input.readerPlan?.deleteSegmentIds ? ['segments'] : []),
      ...(input.readerPlan?.corrections || input.readerPlan?.deleteCorrectionIds ? ['corrections'] : []),
      ...(input.readerPlan?.structureReviewItems ? [CHAPTER_STRUCTURE_STORES.review] : []),
      ...(input.readerPlan?.clearVoiceProductState ? ['voice_product_states'] : []),
      ...(input.sourceAssetId || input.embeddedAssetIds?.length
        ? [BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs]
        : []),
    ],
    'readwrite',
  );
  const done = transactionDone(tx);
  try {
    if (input.shouldCancel?.()) throw new DOMException('Import cancelled', 'AbortError');
    const revisionStore = tx.objectStore(CONTENT_REVISION_STORES.revisions);
    const [currentNovel, currentSyncState, loadedRevision] = await Promise.all([
      requestToPromise<Novel | undefined>(tx.objectStore('novels').get(input.novel.id)),
      requestToPromise<SyncState | undefined>(tx.objectStore('sync_state').get('sync-state')),
      loadStagingRevisionAndCounts(tx, input.revision.id),
    ]);
    const storedRevision = loadedRevision.revision;
    if (!storedRevision || storedRevision.status !== 'staging') {
      throw new Error(`Content revision ${input.revision.id} is not staging`);
    }
    assertContentRevisionBase(storedRevision, currentNovel);
    if (
      input.readerPlan?.expectedSyncNextSequence !== undefined &&
      (currentSyncState?.nextSequence ?? 1) !== input.readerPlan.expectedSyncNextSequence
    ) {
      throw new ContentRevisionConflictError('Reader state changed after remote content activation was prepared');
    }
    const storedCounts = loadedRevision.counts;
    if (!storedCounts) throw new Error(`Content revision ${input.revision.id} has no staged counts`);
    validateStoredContentRevisionCounts(input.actual, storedCounts);

    let nextNovel = novelForContentActivation(
      input.novel,
      currentNovel,
      storedRevision.id,
      storedRevision.baseMutableMetadata,
      storedRevision.source === 'local_import',
    );
    if ((input.preserveExistingEmbeddedAssets || input.preserveExistingCover) && currentNovel) {
      nextNovel = {
        ...nextNovel,
        coverAssetId: currentNovel.coverAssetId,
        coverContentHash: currentNovel.coverContentHash,
        coverFit: currentNovel.coverFit,
        coverPositionX: currentNovel.coverPositionX,
        coverPositionY: currentNovel.coverPositionY,
      };
    }
    if (input.readerPlan?.readingPosition) {
      nextNovel = {
        ...nextNovel,
        lastReadChapterId: input.readerPlan.readingPosition.chapterId,
        lastReadChapterIndex: input.novel.lastReadChapterIndex,
        lastReadParagraphId: input.readerPlan.readingPosition.paragraphId,
        lastReadOffset: input.readerPlan.readingPosition.scrollTop,
        lastReadProgress: input.novel.lastReadProgress,
      };
    } else if (input.readerPlan?.deleteReadingPosition) {
      nextNovel = {
        ...nextNovel,
        lastReadChapterId: undefined,
        lastReadChapterIndex: undefined,
        lastReadParagraphId: undefined,
        lastReadOffset: 0,
        lastReadProgress: 0,
      };
    }
    const activatedAt = new Date().toISOString();
    if (input.sourceAssetId) {
      const asset = await activateSourceAssetInTransaction(tx, {
        assetId: input.sourceAssetId,
        bookId: input.novel.id,
        contentRevisionId: storedRevision.id,
        activatedAt,
      });
      nextNovel = {
        ...nextNovel,
        sourceAssetId: asset.id,
        sourceProvenance: asset.provenance,
        sourceByteLength: asset.byteLength,
        sourceContentType: asset.contentType,
        sourceContentHash: asset.contentHash,
      };
    }
    if (input.embeddedAssetIds?.length) {
      const { assets, preservedCover } = await activateEmbeddedAssetsInTransaction(tx, {
        assetIds: input.embeddedAssetIds,
        bookId: input.novel.id,
        contentRevisionId: storedRevision.id,
        activatedAt,
        preserveExisting: input.preserveExistingEmbeddedAssets,
        preserveExistingCover: input.preserveExistingCover,
      });
      const cover = preservedCover ?? assets.find((asset) => asset.kind === 'cover' && asset.status === 'active');
      if (cover) {
        const keepUserLayout = cover.provenance === 'user_supplied' || cover.provenance === 'approved_enrichment';
        const preservedExistingCover = preservedCover?.id === cover.id;
        nextNovel = {
          ...nextNovel,
          coverAssetId: cover.id,
          coverContentHash: cover.contentHash,
          coverFit: keepUserLayout ? currentNovel?.coverFit : 'contain',
          coverPositionX: keepUserLayout ? currentNovel?.coverPositionX : 50,
          coverPositionY: keepUserLayout ? currentNovel?.coverPositionY : 50,
          coverUpdatedAt: preservedExistingCover ? currentNovel?.coverUpdatedAt : activatedAt,
          coverRemovedAt: preservedExistingCover ? currentNovel?.coverRemovedAt : undefined,
        };
      }
    }
    // The novel record is the atomic active-revision pointer. Chapter heads
    // remain a small ID-only lookup aid. Paragraph lookup validates any legacy
    // head against that active revision and otherwise uses the revision-scoped
    // domain index, avoiding one extra write for every imported paragraph.
    upsertChapterDomainHeadsInTransaction(tx, storedRevision.id, input.shouldCancel);
    tx.objectStore('novels').put(nextNovel);
    const { stagedCounts: _stagedCounts, ...activatedRevision } = storedRevision;
    revisionStore.put({
      ...activatedRevision,
      status: 'active',
      actual: storedCounts,
      activatedAt: new Date().toISOString(),
    } satisfies BookContentRevisionRecord);
    if (storedRevision.baseActiveRevisionId) {
      const previous = await requestToPromise<BookContentRevisionRecord | undefined>(
        revisionStore.get(storedRevision.baseActiveRevisionId),
      );
      if (previous?.status === 'active') {
        revisionStore.put({ ...previous, status: 'superseded' } satisfies BookContentRevisionRecord);
      }
    }

    const readerPlan = input.readerPlan;
    if (readerPlan?.readingPosition) {
      tx.objectStore('reading_positions').put(readerPlan.readingPosition);
    } else if (readerPlan?.deleteReadingPosition) {
      tx.objectStore('reading_positions').delete(`reading_position_${input.novel.id}`);
    }
    readerPlan?.bookmarks.forEach((bookmark) => tx.objectStore('bookmarks').put(bookmark));
    readerPlan?.highlights.forEach((highlight) => tx.objectStore('highlights').put(highlight));
    readerPlan?.notes.forEach((note) => tx.objectStore('notes').put(note));
    readerPlan?.deleteBookmarkIds?.forEach((id) => tx.objectStore('bookmarks').delete(id));
    readerPlan?.deleteHighlightIds?.forEach((id) => tx.objectStore('highlights').delete(id));
    readerPlan?.deleteNoteIds?.forEach((id) => tx.objectStore('notes').delete(id));
    readerPlan?.deleteOutboxItemIds?.forEach((id) => tx.objectStore('sync_outbox').delete(id));
    readerPlan?.outboxItems.forEach((item) => tx.objectStore('sync_outbox').put(item));
    readerPlan?.quarantineRecords?.forEach((record) => tx.objectStore(READER_ANCHOR_QUARANTINE_STORE).put(record));
    readerPlan?.segments?.forEach((segment) => tx.objectStore('segments').put(segment));
    readerPlan?.deleteSegmentIds?.forEach((id) => tx.objectStore('segments').delete(id));
    readerPlan?.corrections?.forEach((correction) => tx.objectStore('corrections').put(correction));
    readerPlan?.deleteCorrectionIds?.forEach((id) => tx.objectStore('corrections').delete(id));
    readerPlan?.structureReviewItems?.forEach((item) => tx.objectStore(CHAPTER_STRUCTURE_STORES.review).put(item));
    if (readerPlan?.clearVoiceProductState) {
      tx.objectStore('voice_product_states').delete(`voice_product_state_${input.novel.id}`);
    }
    if (currentSyncState && readerPlan?.nextSyncSequence !== undefined) {
      tx.objectStore('sync_state').put({
        ...currentSyncState,
        nextSequence: readerPlan.nextSyncSequence,
        updatedAt: new Date().toISOString(),
      } satisfies SyncState);
    }
    await input.queueBookImported?.(tx, nextNovel);
    if (readerPlan || input.queueBookImported) {
      const syncStateStore = tx.objectStore('sync_state');
      const statusIndex = tx.objectStore('sync_outbox').index('status');
      const [latestSyncState, ...queuedCounts] = await Promise.all([
        requestToPromise<SyncState | undefined>(syncStateStore.get('sync-state')),
        ...(['pending', 'sending', 'failed'] as const).map((status) =>
          requestToPromise<number>(statusIndex.count(status)),
        ),
      ]);
      if (latestSyncState) {
        syncStateStore.put({
          ...latestSyncState,
          pendingCount: queuedCounts.reduce((total, count) => total + count, 0),
          updatedAt: new Date().toISOString(),
        } satisfies SyncState);
      }
    }
    await done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have aborted because of a failed request.
    }
    await done.catch(() => undefined);
    throw error;
  }
}
