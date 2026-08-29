import type {
  BookEnrichmentApprovalReceipt,
  BookEnrichmentCandidate,
} from '../features/book-enrichment/book-enrichment-contract';

export const BOOK_ENRICHMENT_STORES = {
  candidates: 'book_enrichment_candidates',
  receipts: 'book_enrichment_receipts',
} as const;

export type StoredBookEnrichmentCandidate = BookEnrichmentCandidate;
export type StoredBookEnrichmentReceipt = BookEnrichmentApprovalReceipt;

export function upgradeBookEnrichmentStores(db: IDBDatabase, transaction: IDBTransaction): void {
  if (!db.objectStoreNames.contains(BOOK_ENRICHMENT_STORES.candidates)) {
    const store = db.createObjectStore(BOOK_ENRICHMENT_STORES.candidates, { keyPath: 'id' });
    store.createIndex('bookId', 'bookId');
    store.createIndex('bookId_status', ['bookId', 'status']);
    store.createIndex('contributionId', 'provenance.contributionId');
    store.createIndex('createdAt', 'createdAt');
  }
  if (!db.objectStoreNames.contains(BOOK_ENRICHMENT_STORES.receipts)) {
    const store = db.createObjectStore(BOOK_ENRICHMENT_STORES.receipts, { keyPath: 'id' });
    store.createIndex('bookId', 'bookId');
    store.createIndex('candidateId', 'candidateId');
    store.createIndex('appliedAt', 'appliedAt');
  } else {
    const store = transaction.objectStore(BOOK_ENRICHMENT_STORES.receipts);
    if (store.indexNames.contains('candidateId') && store.index('candidateId').unique) {
      store.deleteIndex('candidateId');
      store.createIndex('candidateId', 'candidateId');
    }
  }
}
