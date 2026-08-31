import type { Chapter, Novel } from '../domain/types';
import { contentRevisionComponentIds, type BookContentRevisionRecord } from './content-revisions';
import { CONTENT_REVISION_STORES } from './content-revision-migration';
import { EXACT_SECTION_READ_INDEXES } from './exact-section-read-schema';
import type { RevisionChapterRow } from './content-revision-store';
import { requestToPromise } from './indexeddb-transaction';

async function activeRevisionComponentIds(tx: IDBTransaction, novel: Novel): Promise<ReadonlySet<string>> {
  const activeRevision = novel.activeContentRevisionId
    ? await requestToPromise<BookContentRevisionRecord | undefined>(
        tx.objectStore(CONTENT_REVISION_STORES.revisions).get(novel.activeContentRevisionId),
      )
    : undefined;
  if (!novel.activeContentRevisionId) return new Set();
  return new Set(activeRevision ? contentRevisionComponentIds(activeRevision) : [novel.activeContentRevisionId]);
}

function readTimestampRange(scopeId: string): IDBKeyRange {
  return IDBKeyRange.bound([scopeId, ''], [scopeId, '\uffff']);
}

async function activeRevisionSectionRows(
  tx: IDBTransaction,
  novel: Novel,
  documentSectionId: string,
): Promise<RevisionChapterRow[]> {
  const componentIds = await activeRevisionComponentIds(tx, novel);
  const index = tx.objectStore(CONTENT_REVISION_STORES.chapters).index(EXACT_SECTION_READ_INDEXES.revisionSection);
  const rows = await requestToPromise<RevisionChapterRow[]>(index.getAll([novel.id, documentSectionId]));
  return rows.filter((row) => componentIds.has(row.contentRevisionId));
}

async function activeRevisionReadRows(tx: IDBTransaction, novel: Novel): Promise<RevisionChapterRow[]> {
  const componentIds = await activeRevisionComponentIds(tx, novel);
  const index = tx.objectStore(CONTENT_REVISION_STORES.chapters).index(EXACT_SECTION_READ_INDEXES.revisionReadAt);
  const rows = await requestToPromise<RevisionChapterRow[]>(index.getAll(readTimestampRange(novel.id)));
  return rows.filter((row) => componentIds.has(row.contentRevisionId));
}

function laterTimestamp(candidate: string, current: string | undefined): boolean {
  return !current || candidate > current;
}

export async function markExactDocumentSectionReadState(
  tx: IDBTransaction,
  novel: Novel,
  documentSectionId: string,
  readAt: string,
): Promise<void> {
  const revisionStore = tx.objectStore(CONTENT_REVISION_STORES.chapters);
  const rows = await activeRevisionSectionRows(tx, novel, documentSectionId);
  rows
    .filter((row) => row.documentSectionId === documentSectionId && laterTimestamp(readAt, row.documentSectionReadAt))
    .forEach((row) => revisionStore.put({ ...row, documentSectionReadAt: readAt } satisfies RevisionChapterRow));

  const legacyStore = tx.objectStore('chapters');
  const legacyRows = await requestToPromise<Chapter[]>(
    legacyStore.index(EXACT_SECTION_READ_INDEXES.legacySection).getAll([novel.id, documentSectionId]),
  );
  legacyRows
    .filter((row) => row.documentSectionId === documentSectionId && laterTimestamp(readAt, row.documentSectionReadAt))
    .forEach((row) => legacyStore.put({ ...row, documentSectionReadAt: readAt } satisfies Chapter));
}

export async function clearExactDocumentSectionReadState(tx: IDBTransaction, novel: Novel): Promise<void> {
  const revisionStore = tx.objectStore(CONTENT_REVISION_STORES.chapters);
  const rows = await activeRevisionReadRows(tx, novel);
  rows
    .filter((row) => Boolean(row.documentSectionReadAt))
    .forEach((row) => revisionStore.put({ ...row, documentSectionReadAt: undefined } satisfies RevisionChapterRow));

  const legacyStore = tx.objectStore('chapters');
  const legacyRows = await requestToPromise<Chapter[]>(
    legacyStore.index(EXACT_SECTION_READ_INDEXES.legacyReadAt).getAll(readTimestampRange(novel.id)),
  );
  legacyRows
    .filter((row) => Boolean(row.documentSectionReadAt))
    .forEach((row) => legacyStore.put({ ...row, documentSectionReadAt: undefined } satisfies Chapter));
}

/** Text chapters use their own id; comic pages share their imported section id. */
export async function markExactChapterReadState(
  tx: IDBTransaction,
  novel: Novel,
  chapter: Chapter,
  readAt: string,
): Promise<void> {
  if (chapter.documentSectionId) {
    return markExactDocumentSectionReadState(tx, novel, chapter.documentSectionId, readAt);
  }
  const componentIds = await activeRevisionComponentIds(tx, novel);
  const revisionStore = tx.objectStore(CONTENT_REVISION_STORES.chapters);
  const rows = await requestToPromise<RevisionChapterRow[]>(revisionStore.index('domainId').getAll(chapter.id));
  rows
    .filter(
      (row) =>
        row.novelId === novel.id &&
        componentIds.has(row.contentRevisionId) &&
        laterTimestamp(readAt, row.documentSectionReadAt),
    )
    .forEach((row) => revisionStore.put({ ...row, documentSectionReadAt: readAt }));
  const legacyStore = tx.objectStore('chapters');
  const legacy = await requestToPromise<Chapter | undefined>(legacyStore.get(chapter.id));
  if (legacy?.novelId === novel.id && laterTimestamp(readAt, legacy.documentSectionReadAt)) {
    legacyStore.put({ ...legacy, documentSectionReadAt: readAt });
  }
}
