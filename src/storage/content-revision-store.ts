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
  createContentRevisionId,
  revisionScopedStorageId,
  type StoredContentRevisionCounts,
  validateStoredContentRevisionCounts,
} from './content-revisions';
import { CONTENT_REVISION_STORES } from './content-revision-migration';
import { READER_ANCHOR_QUARANTINE_STORE, type ReaderAnchorQuarantineRecord } from './reader-anchor-quarantine';
import { BOOK_ASSET_STORES } from './book-asset-schema';
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
  textLower: string;
  paragraph: Paragraph;
}

export interface RevisionScopedRow {
  storageId: string;
  contentRevisionId: string;
}

export interface RevisionChapterRow extends Chapter, RevisionScopedRow {}
export interface RevisionParagraphRefRow extends StoredParagraphRef, RevisionScopedRow {}
export interface RevisionParagraphPageRow extends ParagraphPage, RevisionScopedRow {}
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

type MutableNovelMetadata = Pick<
  Novel,
  | 'title'
  | 'lastReadChapterId'
  | 'lastReadChapterIndex'
  | 'lastReadParagraphId'
  | 'lastReadOffset'
  | 'lastReadProgress'
  | 'readingSeconds'
  | 'lastReadAt'
  | 'favorite'
>;

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
  base: MutableNovelMetadata | undefined,
  localImport: boolean,
): Novel {
  const imported = { ...input, activeContentRevisionId: contentRevisionId };
  if (!current) return storedNovel(imported);
  const mergedValue = <K extends keyof MutableNovelMetadata>(key: K): MutableNovelMetadata[K] => {
    const preserveLocalReaderMetadata = localImport;
    return preserveLocalReaderMetadata || !base || !Object.is(current[key], base[key]) ? current[key] : input[key];
  };
  return storedNovel({
    ...imported,
    title: mergedValue('title'),
    createdAt: current.createdAt,
    updatedAt: current.updatedAt > input.updatedAt ? current.updatedAt : input.updatedAt,
    lastReadChapterId: mergedValue('lastReadChapterId'),
    lastReadChapterIndex: mergedValue('lastReadChapterIndex'),
    lastReadParagraphId: mergedValue('lastReadParagraphId'),
    lastReadOffset: mergedValue('lastReadOffset'),
    lastReadProgress: mergedValue('lastReadProgress'),
    readingSeconds: mergedValue('readingSeconds'),
    lastReadAt: mergedValue('lastReadAt'),
    favorite: localImport ? current.favorite || input.favorite : mergedValue('favorite'),
  });
}

function mutableNovelMetadata(novel: Novel): MutableNovelMetadata {
  return {
    title: novel.title,
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
    textLower: paragraph.text.toLocaleLowerCase(),
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

function revisionParagraphRefRow(
  contentRevisionId: string,
  paragraph: Paragraph,
  pageIndex: number,
): RevisionParagraphRefRow {
  return {
    ...pageBackedParagraphRef(paragraph, pageIndex),
    storageId: revisionScopedStorageId(contentRevisionId, paragraph.id),
    contentRevisionId,
  };
}

function revisionParagraphPageRow(contentRevisionId: string, page: ParagraphPage): RevisionParagraphPageRow {
  return {
    ...page,
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
  const { storageId: _storageId, contentRevisionId: _contentRevisionId, ...page } = row;
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
  },
): Promise<BookContentRevisionRecord> {
  const tx = db.transaction(['novels', CONTENT_REVISION_STORES.revisions], 'readwrite');
  const currentNovel = await requestToPromise<Novel | undefined>(tx.objectStore('novels').get(input.novel.id));
  const revision: StoredBookContentRevisionRecord = {
    id: createContentRevisionId(),
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
    const tx = db.transaction(CONTENT_REVISION_STORES.chapters, 'readwrite');
    const store = tx.objectStore(CONTENT_REVISION_STORES.chapters);
    batch.forEach((chapter) => store.put(revisionChapterRow(contentRevisionId, chapter)));
    await transactionDone(tx);
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
  const tx = db.transaction(
    [CONTENT_REVISION_STORES.paragraphs, CONTENT_REVISION_STORES.pages, CONTENT_REVISION_STORES.search],
    'readwrite',
  );
  const paragraphStore = tx.objectStore(CONTENT_REVISION_STORES.paragraphs);
  const pageStore = tx.objectStore(CONTENT_REVISION_STORES.pages);
  const searchStore = tx.objectStore(CONTENT_REVISION_STORES.search);
  pages.forEach((page) => {
    pageStore.put(revisionParagraphPageRow(contentRevisionId, page));
    page.paragraphs.forEach((paragraph) => {
      paragraphStore.put(revisionParagraphRefRow(contentRevisionId, paragraph, page.pageIndex));
      searchStore.put(revisionParagraphSearchRow(contentRevisionId, page, paragraph));
    });
  });
  await transactionDone(tx);
}

export async function cleanupStagingContentRevision(db: IDBDatabase, contentRevisionId: string): Promise<void> {
  const tx = db.transaction(Object.values(CONTENT_REVISION_STORES), 'readwrite');
  const revisionStore = tx.objectStore(CONTENT_REVISION_STORES.revisions);
  const revision = await requestToPromise<BookContentRevisionRecord | undefined>(revisionStore.get(contentRevisionId));
  if (revision?.status === 'staging') {
    deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.chapters, 'contentRevisionId', contentRevisionId);
    deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.paragraphs, 'contentRevisionId', contentRevisionId);
    deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.pages, 'contentRevisionId', contentRevisionId);
    deleteByIndexInTransaction(tx, CONTENT_REVISION_STORES.search, 'contentRevisionId', contentRevisionId);
    revisionStore.delete(contentRevisionId);
  }
  await transactionDone(tx);
}

function replaceContentDomainHeadsInTransaction(
  tx: IDBTransaction,
  novelId: string,
  contentRevisionId: string,
  shouldCancel?: () => boolean,
): void {
  const abortIfCancelled = () => {
    if (!shouldCancel?.()) return false;
    tx.abort();
    return true;
  };
  const headStore = tx.objectStore(CONTENT_REVISION_STORES.heads);
  const deleteRequest = headStore.index('novelId').openKeyCursor(novelId);
  deleteRequest.onsuccess = () => {
    if (abortIfCancelled()) return;
    const cursor = deleteRequest.result;
    if (cursor) {
      headStore.delete(cursor.primaryKey);
      cursor.continue();
      return;
    }
    const addHeads = (storeName: string, entityType: ContentDomainEntity) => {
      const request = tx.objectStore(storeName).index('contentRevisionId').openCursor(contentRevisionId);
      request.onsuccess = () => {
        if (abortIfCancelled()) return;
        const contentCursor = request.result;
        if (!contentCursor) return;
        const row = contentCursor.value as RevisionScopedRow & { id: string; novelId: string };
        const head: ContentDomainHead = {
          id: contentDomainHeadId(entityType, row.id),
          entityType,
          domainId: row.id,
          novelId: row.novelId,
          contentRevisionId,
        };
        headStore.put(head);
        contentCursor.continue();
      };
    };
    addHeads(CONTENT_REVISION_STORES.chapters, 'chapter');
    addHeads(CONTENT_REVISION_STORES.paragraphs, 'paragraph');
  };
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
    const [currentNovel, currentSyncState, storedRevision, chapterCount, paragraphRefCount, pageCount, searchRowCount] =
      await Promise.all([
        requestToPromise<Novel | undefined>(tx.objectStore('novels').get(input.novel.id)),
        requestToPromise<SyncState | undefined>(tx.objectStore('sync_state').get('sync-state')),
        requestToPromise<StoredBookContentRevisionRecord | undefined>(revisionStore.get(input.revision.id)),
        requestToPromise<number>(
          tx.objectStore(CONTENT_REVISION_STORES.chapters).index('contentRevisionId').count(input.revision.id),
        ),
        requestToPromise<number>(
          tx.objectStore(CONTENT_REVISION_STORES.paragraphs).index('contentRevisionId').count(input.revision.id),
        ),
        requestToPromise<number>(
          tx.objectStore(CONTENT_REVISION_STORES.pages).index('contentRevisionId').count(input.revision.id),
        ),
        requestToPromise<number>(
          tx.objectStore(CONTENT_REVISION_STORES.search).index('contentRevisionId').count(input.revision.id),
        ),
      ]);
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
    const storedCounts: StoredContentRevisionCounts = {
      chapterCount,
      pageCount,
      paragraphCount: paragraphRefCount,
      paragraphRefCount,
      searchRowCount,
    };
    validateStoredContentRevisionCounts(input.actual, storedCounts);

    let nextNovel = novelForContentActivation(
      input.novel,
      currentNovel,
      storedRevision.id,
      storedRevision.baseMutableMetadata,
      storedRevision.source === 'local_import',
    );
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
    if (input.sourceAssetId) {
      const asset = await activateSourceAssetInTransaction(tx, {
        assetId: input.sourceAssetId,
        bookId: input.novel.id,
        contentRevisionId: storedRevision.id,
        activatedAt: new Date().toISOString(),
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
        activatedAt: new Date().toISOString(),
      });
      const cover = preservedCover ?? assets.find((asset) => asset.kind === 'cover' && asset.status === 'active');
      if (cover) {
        const keepUserLayout = cover.provenance === 'user_supplied' || cover.provenance === 'approved_enrichment';
        nextNovel = {
          ...nextNovel,
          coverAssetId: cover.id,
          coverContentHash: cover.contentHash,
          coverFit: keepUserLayout ? currentNovel?.coverFit : 'contain',
          coverPositionX: keepUserLayout ? currentNovel?.coverPositionX : 50,
          coverPositionY: keepUserLayout ? currentNovel?.coverPositionY : 50,
        };
      }
    }
    replaceContentDomainHeadsInTransaction(tx, input.novel.id, storedRevision.id, input.shouldCancel);
    tx.objectStore('novels').put(nextNovel);
    revisionStore.put({
      ...storedRevision,
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
