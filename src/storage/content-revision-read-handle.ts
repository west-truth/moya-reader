import { hashSync } from '../domain/hash';
import type { Chapter, Novel, Paragraph, ParagraphPage } from '../domain/types';
import type { BulkParagraphPageRequest } from '../repositories/reader-repository';
import { PARAGRAPHS_PER_PAGE } from '../repositories/reader-defaults';
import { throwIfReaderSearchAborted } from '../repositories/reader-query-contract';
import {
  type BookContentRevisionRecord,
  ContentRevisionValidationError,
  contentRevisionComponentIds,
} from './content-revisions';
import { CONTENT_REVISION_STORES } from './content-revision-migration';
import {
  chapterFromRevisionRow,
  contentDomainHeadId,
  pageBackedParagraphRef,
  type ContentDomainEntity,
  type ContentDomainHead,
  pageFromRevisionRow,
  paragraphFromRevisionRow,
  type ParagraphSearchRow,
  type RevisionChapterRow,
  type RevisionParagraphPageRow,
  type RevisionParagraphRefRow,
  type RevisionParagraphSearchRow,
  searchRowFromRevisionRow,
  type StoredParagraphRef,
} from './content-revision-store';

export interface BookContentRevisionHandle {
  readonly novel: Novel;
  readonly contentRevisionId?: string;
  listChapters(): Promise<Chapter[]>;
  listParagraphs(chapterId: string): Promise<Paragraph[]>;
  listParagraphPages(chapterId: string): Promise<ParagraphPage[]>;
  iterateParagraphPages(request: BulkParagraphPageRequest): AsyncIterable<ParagraphPage>;
}

export interface ActiveContentRevisionDiagnostics {
  contentRevisionId?: string;
  revision?: BookContentRevisionRecord;
  paragraphRefs: StoredParagraphRef[];
  paragraphPages: ParagraphPage[];
  paragraphSearchRows: ParagraphSearchRow[];
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getItem<T>(db: IDBDatabase, storeName: string, id: string): Promise<T | undefined> {
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise<T | undefined>(tx.objectStore(storeName).get(id));
}

function getByIndex<T>(
  db: IDBDatabase,
  storeName: string,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
): Promise<T | undefined> {
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise<T | undefined>(tx.objectStore(storeName).index(indexName).get(query));
}

function getAllByIndex<T>(
  db: IDBDatabase,
  storeName: string,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
  count?: number,
): Promise<T[]> {
  const tx = db.transaction(storeName, 'readonly');
  const index = tx.objectStore(storeName).index(indexName);
  return requestToPromise<T[]>(count === undefined ? index.getAll(query) : index.getAll(query, count));
}

const DEFAULT_PARAGRAPH_PAGE_BATCH_SIZE = 20;
const MAX_PARAGRAPH_PAGE_BATCH_SIZE = 20;
const MAX_INDEX_NUMBER = Number.MAX_SAFE_INTEGER;

function paragraphPageBatchSize(requested?: number): number {
  return Math.min(
    MAX_PARAGRAPH_PAGE_BATCH_SIZE,
    Math.max(1, Math.trunc(requested ?? DEFAULT_PARAGRAPH_PAGE_BATCH_SIZE)),
  );
}

async function getPinnedParagraphPageBatch(
  db: IDBDatabase,
  contentRevisionId: string | undefined,
  chapterId: string,
  fromPageIndex: number,
  batchSize: number,
): Promise<ParagraphPage[]> {
  if (contentRevisionId) {
    const rows = await getAllByIndex<RevisionParagraphPageRow>(
      db,
      CONTENT_REVISION_STORES.pages,
      'contentRevisionId_chapterId_pageIndex',
      IDBKeyRange.bound(
        [contentRevisionId, chapterId, fromPageIndex],
        [contentRevisionId, chapterId, MAX_INDEX_NUMBER],
      ),
      batchSize,
    );
    return rows.map(pageFromRevisionRow).sort((left, right) => left.pageIndex - right.pageIndex);
  }

  const pages = await getAllByIndex<ParagraphPage>(
    db,
    'paragraph_pages',
    'chapterId_pageIndex',
    IDBKeyRange.bound([chapterId, fromPageIndex], [chapterId, MAX_INDEX_NUMBER]),
    batchSize,
  );
  return pages.sort((left, right) => left.pageIndex - right.pageIndex);
}

async function getPinnedParagraphRefBatch(
  db: IDBDatabase,
  contentRevisionId: string | undefined,
  chapterId: string,
  fromParagraphIndex: number,
  count: number,
): Promise<Paragraph[]> {
  if (contentRevisionId) {
    const rows = await getAllByIndex<RevisionParagraphRefRow>(
      db,
      CONTENT_REVISION_STORES.paragraphs,
      'contentRevisionId_chapterId_index',
      IDBKeyRange.bound(
        [contentRevisionId, chapterId, fromParagraphIndex],
        [contentRevisionId, chapterId, MAX_INDEX_NUMBER],
      ),
      count,
    );
    return rows.map(paragraphFromRevisionRow).sort((left, right) => left.index - right.index);
  }

  const paragraphs = await getAllByIndex<StoredParagraphRef>(
    db,
    'paragraphs',
    'chapterId_index',
    IDBKeyRange.bound([chapterId, fromParagraphIndex], [chapterId, MAX_INDEX_NUMBER]),
    count,
  );
  return paragraphs.sort((left, right) => left.index - right.index);
}

function paragraphPageFromRefs(
  contentRevisionId: string | undefined,
  chapterId: string,
  pageIndex: number,
  paragraphs: Paragraph[],
): ParagraphPage {
  return {
    id: contentRevisionId
      ? `revision_page_${contentRevisionId}_${chapterId}_${pageIndex}`
      : `legacy_page_${chapterId}_${pageIndex}`,
    novelId: paragraphs[0].novelId,
    chapterId,
    pageIndex,
    startParagraphIndex: paragraphs[0].index,
    endParagraphIndex: paragraphs[paragraphs.length - 1].index,
    paragraphs,
    textHash: hashSync(paragraphs.map((paragraph) => paragraph.textHash).join(':')),
  };
}

async function* iteratePinnedParagraphRefsAsPages(
  db: IDBDatabase,
  contentRevisionId: string | undefined,
  request: BulkParagraphPageRequest,
  batchSize: number,
): AsyncIterable<ParagraphPage> {
  const readCount = batchSize * PARAGRAPHS_PER_PAGE;
  let fromParagraphIndex = 1;
  let pendingPageIndex: number | undefined;
  let pendingParagraphs: Paragraph[] = [];

  for (;;) {
    throwIfReaderSearchAborted(request.signal);
    const paragraphs = await getPinnedParagraphRefBatch(
      db,
      contentRevisionId,
      request.chapterId,
      fromParagraphIndex,
      readCount,
    );
    throwIfReaderSearchAborted(request.signal);

    for (const paragraph of paragraphs) {
      const pageIndex = Math.max(0, Math.floor((paragraph.index - 1) / PARAGRAPHS_PER_PAGE));
      if (pendingPageIndex !== undefined && pageIndex !== pendingPageIndex) {
        throwIfReaderSearchAborted(request.signal);
        yield paragraphPageFromRefs(contentRevisionId, request.chapterId, pendingPageIndex, pendingParagraphs);
        pendingParagraphs = [];
      }
      pendingPageIndex = pageIndex;
      pendingParagraphs.push(paragraph);
    }

    if (paragraphs.length < readCount) {
      if (pendingPageIndex !== undefined && pendingParagraphs.length) {
        throwIfReaderSearchAborted(request.signal);
        yield paragraphPageFromRefs(contentRevisionId, request.chapterId, pendingPageIndex, pendingParagraphs);
      }
      return;
    }

    const nextParagraphIndex = paragraphs[paragraphs.length - 1].index + 1;
    if (nextParagraphIndex <= fromParagraphIndex) throw new Error('Paragraph batch cursor did not advance.');
    fromParagraphIndex = nextParagraphIndex;
  }
}

export async function* iteratePinnedParagraphPages(
  db: IDBDatabase,
  contentRevisionId: string | undefined,
  request: BulkParagraphPageRequest,
): AsyncIterable<ParagraphPage> {
  const batchSize = paragraphPageBatchSize(request.batchSize);
  let fromPageIndex = 0;

  throwIfReaderSearchAborted(request.signal);
  let pages = await getPinnedParagraphPageBatch(db, contentRevisionId, request.chapterId, fromPageIndex, batchSize);
  throwIfReaderSearchAborted(request.signal);

  if (!pages.length) {
    yield* iteratePinnedParagraphRefsAsPages(db, contentRevisionId, request, batchSize);
    return;
  }

  for (;;) {
    for (const page of pages) {
      throwIfReaderSearchAborted(request.signal);
      yield page;
    }
    if (pages.length < batchSize) return;

    const nextPageIndex = pages[pages.length - 1].pageIndex + 1;
    if (nextPageIndex <= fromPageIndex) throw new Error('Paragraph page batch cursor did not advance.');
    fromPageIndex = nextPageIndex;
    throwIfReaderSearchAborted(request.signal);
    pages = await getPinnedParagraphPageBatch(db, contentRevisionId, request.chapterId, fromPageIndex, batchSize);
    throwIfReaderSearchAborted(request.signal);
  }
}

export async function getRevisionChapters(db: IDBDatabase, contentRevisionId: string): Promise<Chapter[]> {
  return getLogicalRevisionChapters(db, contentRevisionId);
}

function getRevisionChapterRows(db: IDBDatabase, contentRevisionId: string): Promise<RevisionChapterRow[]> {
  return getAllByIndex<RevisionChapterRow>(
    db,
    CONTENT_REVISION_STORES.chapters,
    'contentRevisionId',
    contentRevisionId,
  );
}

interface ResolvedRevisionChapters {
  readonly revision?: BookContentRevisionRecord;
  readonly componentRevisionIds: readonly string[];
  readonly chapters: readonly Chapter[];
  readonly physicalRevisionByChapterId: ReadonlyMap<string, string>;
}

export async function getContentRevisionComponentIds(
  db: IDBDatabase,
  contentRevisionId: string,
): Promise<readonly string[]> {
  const revision = await getItem<BookContentRevisionRecord>(db, CONTENT_REVISION_STORES.revisions, contentRevisionId);
  return revision ? contentRevisionComponentIds(revision) : [contentRevisionId];
}

async function resolveRevisionChapters(db: IDBDatabase, contentRevisionId: string): Promise<ResolvedRevisionChapters> {
  const revision = await getItem<BookContentRevisionRecord>(db, CONTENT_REVISION_STORES.revisions, contentRevisionId);
  const componentRevisionIds = revision ? contentRevisionComponentIds(revision) : [contentRevisionId];
  const rowsByComponent = await Promise.all(
    componentRevisionIds.map((componentRevisionId) => getRevisionChapterRows(db, componentRevisionId)),
  );
  const chapters: Chapter[] = [];
  const physicalRevisionByChapterId = new Map<string, string>();
  const chapterIdByIndex = new Map<number, string>();
  for (const [componentIndex, rows] of rowsByComponent.entries()) {
    const physicalRevisionId = componentRevisionIds[componentIndex]!;
    for (const row of rows) {
      if (revision && row.novelId !== revision.novelId) {
        throw new ContentRevisionValidationError(
          `Content revision component ${physicalRevisionId} contains a chapter from another book`,
        );
      }
      if (physicalRevisionByChapterId.has(row.id) || chapterIdByIndex.has(row.index)) {
        throw new ContentRevisionValidationError(`Content revision ${contentRevisionId} contains duplicate chapters`);
      }
      const chapter = chapterFromRevisionRow(row);
      chapters.push(chapter);
      physicalRevisionByChapterId.set(chapter.id, physicalRevisionId);
      chapterIdByIndex.set(chapter.index, chapter.id);
    }
  }
  chapters.sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
  if (revision?.composition) {
    if (chapters.length !== revision.composition.logicalCounts.chapterCount) {
      throw new ContentRevisionValidationError(`Content revision ${contentRevisionId} logical chapter count mismatch`);
    }
    chapters.forEach((chapter, offset) => {
      if (chapter.index !== offset + 1) {
        throw new ContentRevisionValidationError(
          `Content revision ${contentRevisionId} chapter order is not continuous`,
        );
      }
    });
  }
  return { revision, componentRevisionIds, chapters, physicalRevisionByChapterId };
}

export async function getLogicalRevisionChapters(db: IDBDatabase, contentRevisionId: string): Promise<Chapter[]> {
  const resolved = await resolveRevisionChapters(db, contentRevisionId);
  return resolved.chapters.map((chapter) => ({ ...chapter }));
}

async function resolvePhysicalRevisionForChapter(
  db: IDBDatabase,
  contentRevisionId: string,
  chapterId: string,
): Promise<string | undefined> {
  const revision = await getItem<BookContentRevisionRecord>(db, CONTENT_REVISION_STORES.revisions, contentRevisionId);
  const componentRevisionIds = revision ? contentRevisionComponentIds(revision) : [contentRevisionId];
  const head = await getContentDomainHead(db, 'chapter', chapterId);
  if (
    head &&
    (!revision || head.novelId === revision.novelId) &&
    componentRevisionIds.includes(head.contentRevisionId)
  ) {
    return head.contentRevisionId;
  }
  for (const componentRevisionId of [...componentRevisionIds].reverse()) {
    const row = await getByIndex<RevisionChapterRow>(
      db,
      CONTENT_REVISION_STORES.chapters,
      'contentRevisionId_domainId',
      [componentRevisionId, chapterId],
    );
    if (row && (!revision || row.novelId === revision.novelId)) return componentRevisionId;
  }
  return undefined;
}

export async function getRevisionParagraphPages(
  db: IDBDatabase,
  contentRevisionId: string,
  chapterId: string,
): Promise<ParagraphPage[]> {
  const physicalRevisionId = await resolvePhysicalRevisionForChapter(db, contentRevisionId, chapterId);
  return physicalRevisionId ? getPhysicalRevisionParagraphPages(db, physicalRevisionId, chapterId) : [];
}

async function getPhysicalRevisionParagraphPages(
  db: IDBDatabase,
  contentRevisionId: string,
  chapterId: string,
): Promise<ParagraphPage[]> {
  const rows = await getAllByIndex<RevisionParagraphPageRow>(
    db,
    CONTENT_REVISION_STORES.pages,
    'contentRevisionId_chapterId',
    [contentRevisionId, chapterId],
  );
  return rows.map(pageFromRevisionRow).sort((a, b) => a.pageIndex - b.pageIndex);
}

export async function getRevisionParagraphRefs(
  db: IDBDatabase,
  contentRevisionId: string,
  chapterId: string,
): Promise<StoredParagraphRef[]> {
  const physicalRevisionId = await resolvePhysicalRevisionForChapter(db, contentRevisionId, chapterId);
  return physicalRevisionId ? getPhysicalRevisionParagraphRefs(db, physicalRevisionId, chapterId) : [];
}

async function getPhysicalRevisionParagraphRefs(
  db: IDBDatabase,
  contentRevisionId: string,
  chapterId: string,
): Promise<StoredParagraphRef[]> {
  const rows = await getAllByIndex<RevisionParagraphRefRow>(
    db,
    CONTENT_REVISION_STORES.paragraphs,
    'contentRevisionId_chapterId',
    [contentRevisionId, chapterId],
  );
  if (rows.length) return rows.map(paragraphFromRevisionRow).sort((a, b) => a.index - b.index);
  const pages = await getPhysicalRevisionParagraphPages(db, contentRevisionId, chapterId);
  return pages
    .flatMap((page) => page.paragraphs.map((paragraph) => pageBackedParagraphRef(paragraph, page.pageIndex)))
    .sort((a, b) => a.index - b.index);
}

export function getContentDomainHead(
  db: IDBDatabase,
  entityType: ContentDomainEntity,
  domainId: string,
): Promise<ContentDomainHead | undefined> {
  return getItem<ContentDomainHead>(db, CONTENT_REVISION_STORES.heads, contentDomainHeadId(entityType, domainId));
}

export async function activeRevisionIdForChapter(db: IDBDatabase, chapterId: string): Promise<string | undefined> {
  const head = await getContentDomainHead(db, 'chapter', chapterId);
  if (!head) return undefined;
  const novel = await getItem<Novel>(db, 'novels', head.novelId);
  if (!novel?.activeContentRevisionId) return undefined;
  const components = await getContentRevisionComponentIds(db, novel.activeContentRevisionId);
  return components.includes(head.contentRevisionId) ? head.contentRevisionId : undefined;
}

export async function getLegacyChapters(db: IDBDatabase, novelId: string): Promise<Chapter[]> {
  const chapters = await getAllByIndex<Chapter>(db, 'chapters', 'novelId', novelId);
  return chapters.sort((a, b) => a.index - b.index);
}

export async function getLegacyParagraphPages(db: IDBDatabase, chapterId: string): Promise<ParagraphPage[]> {
  const pages = await getAllByIndex<ParagraphPage>(db, 'paragraph_pages', 'chapterId', chapterId);
  return pages.sort((a, b) => a.pageIndex - b.pageIndex);
}

export async function getLegacyParagraphs(db: IDBDatabase, chapterId: string): Promise<Paragraph[]> {
  const pages = await getLegacyParagraphPages(db, chapterId);
  if (pages.length) return pages.flatMap((page) => page.paragraphs).sort((a, b) => a.index - b.index);
  const paragraphs = await getAllByIndex<StoredParagraphRef>(db, 'paragraphs', 'chapterId', chapterId);
  return paragraphs.sort((a, b) => a.index - b.index);
}

export async function readableLegacyChapter(db: IDBDatabase, chapterId: string): Promise<Chapter | undefined> {
  const chapter = await getItem<Chapter>(db, 'chapters', chapterId);
  if (!chapter) return undefined;
  const novel = await getItem<Novel>(db, 'novels', chapter.novelId);
  return novel && !novel.activeContentRevisionId ? chapter : undefined;
}

export async function legacyNovelIsReadable(db: IDBDatabase, novelId: string): Promise<boolean> {
  const novel = await getItem<Novel>(db, 'novels', novelId);
  return Boolean(novel && !novel.activeContentRevisionId);
}

export async function openBookContentRevision(db: IDBDatabase, novelId: string): Promise<BookContentRevisionHandle> {
  const novel = await getItem<Novel>(db, 'novels', novelId);
  if (!novel) throw new Error(`Novel ${novelId} does not exist`);
  const contentRevisionId = novel.activeContentRevisionId;
  if (!contentRevisionId) {
    return {
      novel: { ...novel },
      contentRevisionId,
      listChapters: () => getLegacyChapters(db, novelId),
      listParagraphPages: (chapterId) => getLegacyParagraphPages(db, chapterId),
      iterateParagraphPages: (request) => iteratePinnedParagraphPages(db, undefined, request),
      listParagraphs: (chapterId) => getLegacyParagraphs(db, chapterId),
    };
  }

  const resolved = await resolveRevisionChapters(db, contentRevisionId);
  const pinnedChapters = resolved.chapters.map((chapter) => ({ ...chapter }));
  const pinnedRevisionByChapterId = new Map(resolved.physicalRevisionByChapterId);
  return {
    novel: { ...novel },
    contentRevisionId,
    listChapters: async () => pinnedChapters.map((chapter) => ({ ...chapter })),
    listParagraphPages: (chapterId) => {
      const physicalRevisionId = pinnedRevisionByChapterId.get(chapterId);
      return physicalRevisionId
        ? getPhysicalRevisionParagraphPages(db, physicalRevisionId, chapterId)
        : Promise.resolve([]);
    },
    iterateParagraphPages: (request) =>
      (async function* () {
        const physicalRevisionId = pinnedRevisionByChapterId.get(request.chapterId);
        if (!physicalRevisionId) return;
        yield* iteratePinnedParagraphPages(db, physicalRevisionId, request);
      })(),
    listParagraphs: async (chapterId) => {
      const physicalRevisionId = pinnedRevisionByChapterId.get(chapterId);
      if (!physicalRevisionId) return [];
      const pages = await getPhysicalRevisionParagraphPages(db, physicalRevisionId, chapterId);
      if (pages.length) return pages.flatMap((page) => page.paragraphs).sort((a, b) => a.index - b.index);
      return getPhysicalRevisionParagraphRefs(db, physicalRevisionId, chapterId);
    },
  };
}

export async function getActiveContentRevisionDiagnostics(
  db: IDBDatabase,
  novelId: string,
): Promise<ActiveContentRevisionDiagnostics> {
  const novel = await getItem<Novel>(db, 'novels', novelId);
  const contentRevisionId = novel?.activeContentRevisionId;
  if (!contentRevisionId) {
    const [paragraphRefs, paragraphPages, paragraphSearchRows] = await Promise.all([
      getAllByIndex<StoredParagraphRef>(db, 'paragraphs', 'novelId', novelId),
      getAllByIndex<ParagraphPage>(db, 'paragraph_pages', 'novelId', novelId),
      getAllByIndex<ParagraphSearchRow>(db, 'paragraph_search', 'novelId', novelId),
    ]);
    return { paragraphRefs, paragraphPages, paragraphSearchRows };
  }
  const resolved = await resolveRevisionChapters(db, contentRevisionId);
  const componentRows = await Promise.all(
    resolved.componentRevisionIds.map(async (componentRevisionId) => {
      const [paragraphRefs, paragraphPages, paragraphSearchRows] = await Promise.all([
        getAllByIndex<RevisionParagraphRefRow>(
          db,
          CONTENT_REVISION_STORES.paragraphs,
          'contentRevisionId',
          componentRevisionId,
        ),
        getAllByIndex<RevisionParagraphPageRow>(
          db,
          CONTENT_REVISION_STORES.pages,
          'contentRevisionId',
          componentRevisionId,
        ),
        getAllByIndex<RevisionParagraphSearchRow>(
          db,
          CONTENT_REVISION_STORES.search,
          'contentRevisionId',
          componentRevisionId,
        ),
      ]);
      return { paragraphRefs, paragraphPages, paragraphSearchRows };
    }),
  );
  return {
    contentRevisionId,
    revision: resolved.revision,
    paragraphRefs: componentRows.flatMap((rows) => rows.paragraphRefs.map(paragraphFromRevisionRow)),
    paragraphPages: componentRows.flatMap((rows) => rows.paragraphPages.map(pageFromRevisionRow)),
    paragraphSearchRows: componentRows.flatMap((rows) => rows.paragraphSearchRows.map(searchRowFromRevisionRow)),
  };
}

export async function getRevisionParagraphPage(
  db: IDBDatabase,
  contentRevisionId: string,
  chapterId: string,
  pageIndex: number,
): Promise<ParagraphPage | undefined> {
  const physicalRevisionId = await resolvePhysicalRevisionForChapter(db, contentRevisionId, chapterId);
  return physicalRevisionId
    ? getPhysicalRevisionParagraphPage(db, physicalRevisionId, chapterId, pageIndex)
    : undefined;
}

async function getPhysicalRevisionParagraphPage(
  db: IDBDatabase,
  contentRevisionId: string,
  chapterId: string,
  pageIndex: number,
): Promise<ParagraphPage | undefined> {
  const row = await getByIndex<RevisionParagraphPageRow>(
    db,
    CONTENT_REVISION_STORES.pages,
    'contentRevisionId_chapterId_pageIndex',
    [contentRevisionId, chapterId, pageIndex],
  );
  if (row) return pageFromRevisionRow(row);

  const startIndex = pageIndex * PARAGRAPHS_PER_PAGE + 1;
  const endIndex = startIndex + PARAGRAPHS_PER_PAGE - 1;
  const rows = await getAllByIndex<RevisionParagraphRefRow>(
    db,
    CONTENT_REVISION_STORES.paragraphs,
    'contentRevisionId_chapterId_index',
    IDBKeyRange.bound([contentRevisionId, chapterId, startIndex], [contentRevisionId, chapterId, endIndex]),
  );
  const paragraphs = rows.map(paragraphFromRevisionRow).sort((a, b) => a.index - b.index);
  if (!paragraphs.length) return undefined;
  return {
    id: `revision_page_${contentRevisionId}_${chapterId}_${pageIndex}`,
    novelId: paragraphs[0].novelId,
    chapterId,
    pageIndex,
    startParagraphIndex: paragraphs[0].index,
    endParagraphIndex: paragraphs[paragraphs.length - 1].index,
    paragraphs,
    textHash: hashSync(paragraphs.map((paragraph) => paragraph.textHash).join(':')),
  };
}
