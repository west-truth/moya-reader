import type {
  ChapterStructurePreview,
  ChapterStructureReceipt,
  ChapterStructureReviewItem,
} from '../repositories/chapter-structure-repository';

export const CHAPTER_STRUCTURE_STORES = {
  drafts: 'chapter_structure_drafts',
  receipts: 'chapter_structure_receipts',
  review: 'chapter_structure_review',
} as const;

export type StoredChapterStructureDraft = ChapterStructurePreview;
export type StoredChapterStructureReceipt = ChapterStructureReceipt;
export type StoredChapterStructureReviewItem = ChapterStructureReviewItem;

export function upgradeChapterStructureStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(CHAPTER_STRUCTURE_STORES.drafts)) {
    const store = db.createObjectStore(CHAPTER_STRUCTURE_STORES.drafts, { keyPath: 'draftId' });
    store.createIndex('bookId', 'bookId');
    store.createIndex('novelId', 'bookId');
    store.createIndex('createdAt', 'createdAt');
  }
  if (!db.objectStoreNames.contains(CHAPTER_STRUCTURE_STORES.receipts)) {
    const store = db.createObjectStore(CHAPTER_STRUCTURE_STORES.receipts, { keyPath: 'id' });
    store.createIndex('bookId', 'bookId');
    store.createIndex('novelId', 'bookId');
    store.createIndex('bookId_createdAt', ['bookId', 'createdAt']);
  }
  if (!db.objectStoreNames.contains(CHAPTER_STRUCTURE_STORES.review)) {
    const store = db.createObjectStore(CHAPTER_STRUCTURE_STORES.review, { keyPath: 'id' });
    store.createIndex('bookId', 'bookId');
    store.createIndex('novelId', 'bookId');
    store.createIndex('receiptId', 'receiptId');
  }
}
