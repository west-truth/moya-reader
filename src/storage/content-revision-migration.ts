import { EXACT_SECTION_READ_INDEXES } from './exact-section-read-schema';

export const CONTENT_REVISION_STORES = {
  revisions: 'book_content_revisions',
  chapters: 'book_content_chapters',
  paragraphs: 'book_content_paragraphs',
  pages: 'book_content_paragraph_pages',
  search: 'book_content_paragraph_search',
  heads: 'book_content_domain_heads',
} as const;

function createEntityStore(db: IDBDatabase, name: string): IDBObjectStore {
  return db.createObjectStore(name, { keyPath: 'id' });
}

function createRevisionScopedStore(db: IDBDatabase, name: string): IDBObjectStore {
  return db.createObjectStore(name, { keyPath: 'storageId' });
}

function ensureIndex(
  store: IDBObjectStore,
  name: string,
  keyPath: string | string[],
  options?: IDBIndexParameters,
): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

export function upgradeContentRevisionStores(db: IDBDatabase, transaction: IDBTransaction): void {
  if (!db.objectStoreNames.contains(CONTENT_REVISION_STORES.revisions)) {
    const store = createEntityStore(db, CONTENT_REVISION_STORES.revisions);
    store.createIndex('novelId', 'novelId');
    store.createIndex('status', 'status');
    store.createIndex('novelId_status', ['novelId', 'status']);
    store.createIndex('sourceRevision', 'sourceRevision');
  }
  if (!db.objectStoreNames.contains(CONTENT_REVISION_STORES.chapters)) {
    const store = createRevisionScopedStore(db, CONTENT_REVISION_STORES.chapters);
    store.createIndex('contentRevisionId', 'contentRevisionId');
    store.createIndex('novelId', 'novelId');
    store.createIndex('domainId', 'id');
    store.createIndex('contentRevisionId_domainId', ['contentRevisionId', 'id'], { unique: true });
    store.createIndex('contentRevisionId_index', ['contentRevisionId', 'index'], { unique: true });
    store.createIndex(EXACT_SECTION_READ_INDEXES.revisionSection, ['novelId', 'documentSectionId']);
    store.createIndex(EXACT_SECTION_READ_INDEXES.revisionReadAt, ['novelId', 'documentSectionReadAt']);
  } else {
    const store = transaction.objectStore(CONTENT_REVISION_STORES.chapters);
    ensureIndex(store, EXACT_SECTION_READ_INDEXES.revisionSection, ['novelId', 'documentSectionId']);
    ensureIndex(store, EXACT_SECTION_READ_INDEXES.revisionReadAt, ['novelId', 'documentSectionReadAt']);
  }
  if (!db.objectStoreNames.contains(CONTENT_REVISION_STORES.paragraphs)) {
    const store = createRevisionScopedStore(db, CONTENT_REVISION_STORES.paragraphs);
    store.createIndex('contentRevisionId', 'contentRevisionId');
    store.createIndex('novelId', 'novelId');
    store.createIndex('domainId', 'id');
    store.createIndex('contentRevisionId_domainId', ['contentRevisionId', 'id'], { unique: true });
    store.createIndex('contentRevisionId_chapterId', ['contentRevisionId', 'chapterId']);
    store.createIndex('contentRevisionId_chapterId_index', ['contentRevisionId', 'chapterId', 'index'], {
      unique: true,
    });
  }
  if (!db.objectStoreNames.contains(CONTENT_REVISION_STORES.pages)) {
    const store = createRevisionScopedStore(db, CONTENT_REVISION_STORES.pages);
    store.createIndex('contentRevisionId', 'contentRevisionId');
    store.createIndex('novelId', 'novelId');
    store.createIndex('domainId', 'id');
    store.createIndex('contentRevisionId_domainId', ['contentRevisionId', 'id'], { unique: true });
    store.createIndex('contentRevisionId_chapterId', ['contentRevisionId', 'chapterId']);
    store.createIndex('contentRevisionId_chapterId_pageIndex', ['contentRevisionId', 'chapterId', 'pageIndex'], {
      unique: true,
    });
    store.createIndex('paragraphIds', 'paragraphIds', { multiEntry: true });
  } else {
    ensureIndex(transaction.objectStore(CONTENT_REVISION_STORES.pages), 'paragraphIds', 'paragraphIds', {
      multiEntry: true,
    });
  }
  if (!db.objectStoreNames.contains(CONTENT_REVISION_STORES.search)) {
    const store = createRevisionScopedStore(db, CONTENT_REVISION_STORES.search);
    store.createIndex('contentRevisionId', 'contentRevisionId');
    store.createIndex('novelId', 'novelId');
    store.createIndex('paragraphId', 'paragraphId');
    store.createIndex('contentRevisionId_paragraphId', ['contentRevisionId', 'paragraphId'], { unique: true });
    store.createIndex(
      'contentRevisionId_chapterId_paragraphIndex',
      ['contentRevisionId', 'chapterId', 'paragraphIndex'],
      { unique: true },
    );
  }
  if (!db.objectStoreNames.contains(CONTENT_REVISION_STORES.heads)) {
    const store = createEntityStore(db, CONTENT_REVISION_STORES.heads);
    store.createIndex('novelId', 'novelId');
    store.createIndex('contentRevisionId', 'contentRevisionId');
    store.createIndex('entityType', 'entityType');
  }
}
