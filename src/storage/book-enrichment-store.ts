import type {
  BookEnrichmentApprovalReceipt,
  BookEnrichmentCandidate,
} from '../features/book-enrichment/book-enrichment-contract';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';
import { BOOK_ENRICHMENT_STORES } from './book-enrichment-schema';

function cursorEach(request: IDBRequest<IDBCursorWithValue | null>, visit: (cursor: IDBCursorWithValue) => void) {
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    visit(cursor);
    cursor.continue();
  };
}

export async function listBookEnrichmentCandidates(bookId: string): Promise<BookEnrichmentCandidate[]> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ENRICHMENT_STORES.candidates, 'readonly');
  const candidates = await requestToPromise<BookEnrichmentCandidate[]>(
    tx.objectStore(BOOK_ENRICHMENT_STORES.candidates).index('bookId').getAll(bookId),
  );
  await transactionDone(tx);
  return candidates.sort(
    (left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
  );
}

export async function listBookEnrichmentReceipts(bookId: string): Promise<BookEnrichmentApprovalReceipt[]> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ENRICHMENT_STORES.receipts, 'readonly');
  const receipts = await requestToPromise<BookEnrichmentApprovalReceipt[]>(
    tx.objectStore(BOOK_ENRICHMENT_STORES.receipts).index('bookId').getAll(bookId),
  );
  await transactionDone(tx);
  return receipts.sort((left, right) => right.appliedAt.localeCompare(left.appliedAt));
}

export async function getBookEnrichmentCandidate(candidateId: string): Promise<BookEnrichmentCandidate | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ENRICHMENT_STORES.candidates, 'readonly');
  const candidate = await requestToPromise<BookEnrichmentCandidate | undefined>(
    tx.objectStore(BOOK_ENRICHMENT_STORES.candidates).get(candidateId),
  );
  await transactionDone(tx);
  return candidate;
}

export async function getBookEnrichmentReceipt(receiptId: string): Promise<BookEnrichmentApprovalReceipt | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ENRICHMENT_STORES.receipts, 'readonly');
  const receipt = await requestToPromise<BookEnrichmentApprovalReceipt | undefined>(
    tx.objectStore(BOOK_ENRICHMENT_STORES.receipts).get(receiptId),
  );
  await transactionDone(tx);
  return receipt;
}

export async function replacePendingBookEnrichmentCandidates(
  bookId: string,
  contributionId: string,
  candidates: readonly BookEnrichmentCandidate[],
): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ENRICHMENT_STORES.candidates, 'readwrite');
  const store = tx.objectStore(BOOK_ENRICHMENT_STORES.candidates);
  const now = new Date().toISOString();
  cursorEach(store.index('bookId_status').openCursor(IDBKeyRange.only([bookId, 'pending'])), (cursor) => {
    const current = cursor.value as BookEnrichmentCandidate;
    if (current.provenance.contributionId !== contributionId) return;
    cursor.update({ ...current, status: 'rejected', statusReason: 'superseded', updatedAt: now });
  });
  for (const candidate of candidates) store.put(candidate);
  await transactionDone(tx);
}

export async function updateBookEnrichmentCandidateStatus(
  candidateId: string,
  status: BookEnrichmentCandidate['status'],
  reason?: string,
): Promise<BookEnrichmentCandidate | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ENRICHMENT_STORES.candidates, 'readwrite');
  const store = tx.objectStore(BOOK_ENRICHMENT_STORES.candidates);
  const candidate = await requestToPromise<BookEnrichmentCandidate | undefined>(store.get(candidateId));
  if (!candidate) {
    await transactionDone(tx);
    return undefined;
  }
  const next = {
    ...candidate,
    status,
    statusReason: reason,
    updatedAt: new Date().toISOString(),
  } satisfies BookEnrichmentCandidate;
  store.put(next);
  await transactionDone(tx);
  return next;
}

export async function recordBookEnrichmentApproval(
  candidateId: string,
  receipt: BookEnrichmentApprovalReceipt,
): Promise<BookEnrichmentCandidate | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction([BOOK_ENRICHMENT_STORES.candidates, BOOK_ENRICHMENT_STORES.receipts], 'readwrite');
  const candidateStore = tx.objectStore(BOOK_ENRICHMENT_STORES.candidates);
  const candidate = await requestToPromise<BookEnrichmentCandidate | undefined>(candidateStore.get(candidateId));
  if (!candidate) {
    tx.abort();
    await transactionDone(tx).catch(() => undefined);
    throw new Error('보강 후보를 찾을 수 없습니다.');
  }
  const next = {
    ...candidate,
    status: 'applied',
    statusReason: undefined,
    updatedAt: receipt.appliedAt,
  } satisfies BookEnrichmentCandidate;
  candidateStore.put(next);
  tx.objectStore(BOOK_ENRICHMENT_STORES.receipts).put(receipt);
  await transactionDone(tx);
  return next;
}

export async function recordBookEnrichmentUndo(receipt: BookEnrichmentApprovalReceipt): Promise<void> {
  if (receipt.action !== 'undo' || !receipt.approvalReceiptId) {
    throw new Error('작품 보강 되돌림 영수증이 올바르지 않습니다.');
  }
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ENRICHMENT_STORES.receipts, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(BOOK_ENRICHMENT_STORES.receipts);
  const approval = await requestToPromise<BookEnrichmentApprovalReceipt | undefined>(
    store.get(receipt.approvalReceiptId),
  );
  if (!approval || approval.bookId !== receipt.bookId || approval.candidateId !== receipt.candidateId) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('원본 작품 보강 승인 기록을 찾을 수 없습니다.');
  }
  const existing = await requestToPromise<BookEnrichmentApprovalReceipt[]>(
    store.index('candidateId').getAll(receipt.candidateId),
  );
  if (existing.some((item) => item.action === 'undo' && item.approvalReceiptId === approval.id)) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('이미 되돌린 작품 보강 승인입니다.');
  }
  store.put(receipt);
  await done;
}

export async function markCompetingBookEnrichmentCandidatesStale(
  bookId: string,
  baseMetadataRevision: number,
  exceptCandidateId: string,
): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ENRICHMENT_STORES.candidates, 'readwrite');
  const store = tx.objectStore(BOOK_ENRICHMENT_STORES.candidates);
  const now = new Date().toISOString();
  cursorEach(store.index('bookId_status').openCursor(IDBKeyRange.only([bookId, 'pending'])), (cursor) => {
    const candidate = cursor.value as BookEnrichmentCandidate;
    if (candidate.id === exceptCandidateId || candidate.baseMetadataRevision !== baseMetadataRevision) return;
    cursor.update({ ...candidate, status: 'stale', statusReason: 'metadata_revision_changed', updatedAt: now });
  });
  await transactionDone(tx);
}

export function deleteBookEnrichmentDataInTransaction(transaction: IDBTransaction, bookId: string): void {
  for (const storeName of Object.values(BOOK_ENRICHMENT_STORES)) {
    cursorEach(transaction.objectStore(storeName).index('bookId').openCursor(IDBKeyRange.only(bookId)), (cursor) => {
      cursor.delete();
    });
  }
}
