import type {
  BookEnrichmentApprovalIntent,
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
  const existing = await requestToPromise<BookEnrichmentCandidate[]>(
    store.index('bookId_status').getAll(IDBKeyRange.only([bookId, 'pending'])),
  );
  for (const current of existing) {
    if (current.provenance.contributionId !== contributionId) continue;
    store.put({
      ...current,
      status: 'rejected',
      statusReason: 'superseded',
      approvalIntent: undefined,
      updatedAt: now,
    });
  }
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
    approvalIntent: status === 'pending' ? candidate.approvalIntent : undefined,
    updatedAt: new Date().toISOString(),
  } satisfies BookEnrichmentCandidate;
  store.put(next);
  await transactionDone(tx);
  return next;
}

export async function stageBookEnrichmentApprovalIntent(
  candidateId: string,
  intent: BookEnrichmentApprovalIntent,
): Promise<BookEnrichmentCandidate> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ENRICHMENT_STORES.candidates, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(BOOK_ENRICHMENT_STORES.candidates);
  const candidate = await requestToPromise<BookEnrichmentCandidate | undefined>(store.get(candidateId));
  if (!candidate || candidate.status !== 'pending') {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('이미 처리되었거나 다시 검토해야 하는 추천입니다.');
  }
  if (candidate.kind !== intent.kind || candidate.baseMetadataRevision !== intent.baseMetadataRevision) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('작품 정보 승인 작업의 기준이 일치하지 않습니다.');
  }
  if (candidate.approvalIntent) {
    if (candidate.approvalIntent.operationId === intent.operationId) {
      await done;
      return candidate;
    }
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('이 추천의 다른 승인 작업을 복구하고 있습니다.');
  }
  const next = {
    ...candidate,
    approvalIntent: intent,
    updatedAt: intent.stagedAt,
  } satisfies BookEnrichmentCandidate;
  store.put(next);
  await done;
  return next;
}

export async function resolveBookEnrichmentApprovalIntent(
  candidateId: string,
  operationId: string,
  outcome: 'pending' | 'stale',
  reason?: string,
): Promise<BookEnrichmentCandidate | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ENRICHMENT_STORES.candidates, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(BOOK_ENRICHMENT_STORES.candidates);
  const candidate = await requestToPromise<BookEnrichmentCandidate | undefined>(store.get(candidateId));
  if (!candidate) {
    await done;
    return undefined;
  }
  if (!candidate.approvalIntent) {
    await done;
    return candidate;
  }
  if (candidate.approvalIntent.operationId !== operationId) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('작품 정보 승인 작업이 다른 작업으로 교체되었습니다.');
  }
  const next = {
    ...candidate,
    approvalIntent: undefined,
    status: outcome,
    statusReason: reason,
    updatedAt: new Date().toISOString(),
  } satisfies BookEnrichmentCandidate;
  store.put(next);
  await done;
  return next;
}

export async function recordBookEnrichmentApproval(
  candidateId: string,
  receipt: BookEnrichmentApprovalReceipt,
  expectedApprovalOperationId?: string,
): Promise<BookEnrichmentCandidate | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction([BOOK_ENRICHMENT_STORES.candidates, BOOK_ENRICHMENT_STORES.receipts], 'readwrite');
  const done = transactionDone(tx);
  const candidateStore = tx.objectStore(BOOK_ENRICHMENT_STORES.candidates);
  const candidate = await requestToPromise<BookEnrichmentCandidate | undefined>(candidateStore.get(candidateId));
  if (!candidate) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('보강 후보를 찾을 수 없습니다.');
  }
  if (
    expectedApprovalOperationId &&
    (receipt.approvalOperationId !== expectedApprovalOperationId ||
      receipt.candidateId !== candidate.id ||
      receipt.bookId !== candidate.bookId ||
      receipt.kind !== candidate.kind ||
      receipt.baseMetadataRevision !== candidate.baseMetadataRevision ||
      receipt.appliedMetadataRevision !== candidate.baseMetadataRevision + 1)
  ) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('작품 정보 승인 기록이 영구 작업 기준과 일치하지 않습니다.');
  }
  if (expectedApprovalOperationId && candidate.status !== 'pending') {
    const existing = await requestToPromise<BookEnrichmentApprovalReceipt | undefined>(
      tx.objectStore(BOOK_ENRICHMENT_STORES.receipts).get(receipt.id),
    );
    if (candidate.status === 'applied' && existing?.approvalOperationId === expectedApprovalOperationId) {
      await done;
      return candidate;
    }
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('이미 처리된 보강 후보에 승인 기록을 적용할 수 없습니다.');
  }
  if (expectedApprovalOperationId && candidate.approvalIntent?.operationId !== expectedApprovalOperationId) {
    const existing = await requestToPromise<BookEnrichmentApprovalReceipt | undefined>(
      tx.objectStore(BOOK_ENRICHMENT_STORES.receipts).get(receipt.id),
    );
    if (candidate.status === 'applied' && existing?.approvalOperationId === expectedApprovalOperationId) {
      await done;
      return candidate;
    }
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('작품 정보 승인 작업이 더 이상 유효하지 않습니다.');
  }
  if (
    expectedApprovalOperationId &&
    (receipt.selectedFields.length !== candidate.approvalIntent?.selectedFields.length ||
      receipt.selectedFields.some((field, index) => field !== candidate.approvalIntent?.selectedFields[index]))
  ) {
    tx.abort();
    await done.catch(() => undefined);
    throw new Error('작품 정보 승인 필드가 영구 작업 기준과 일치하지 않습니다.');
  }
  const next = {
    ...candidate,
    status: 'applied',
    statusReason: undefined,
    approvalIntent: undefined,
    updatedAt: receipt.appliedAt,
  } satisfies BookEnrichmentCandidate;
  candidateStore.put(next);
  tx.objectStore(BOOK_ENRICHMENT_STORES.receipts).put(receipt);
  await done;
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

export async function reconcileBookEnrichmentCandidatesAfterApproval(
  approvedCandidate: BookEnrichmentCandidate,
  appliedMetadataRevision: number,
): Promise<void> {
  const db = await openReaderDb();
  const tx = db.transaction(BOOK_ENRICHMENT_STORES.candidates, 'readwrite');
  const store = tx.objectStore(BOOK_ENRICHMENT_STORES.candidates);
  const now = new Date().toISOString();
  cursorEach(
    store.index('bookId_status').openCursor(IDBKeyRange.only([approvedCandidate.bookId, 'pending'])),
    (cursor) => {
      const candidate = cursor.value as BookEnrichmentCandidate;
      if (
        candidate.id === approvedCandidate.id ||
        candidate.baseMetadataRevision !== approvedCandidate.baseMetadataRevision
      )
        return;
      const sameResolvedMatch =
        Boolean(approvedCandidate.proposalGroupId) &&
        candidate.proposalGroupId === approvedCandidate.proposalGroupId &&
        candidate.provenance.contributionId === approvedCandidate.provenance.contributionId &&
        candidate.provenance.registrationFingerprint === approvedCandidate.provenance.registrationFingerprint &&
        candidate.kind !== approvedCandidate.kind;
      cursor.update(
        sameResolvedMatch && !candidate.approvalIntent
          ? { ...candidate, baseMetadataRevision: appliedMetadataRevision, updatedAt: now }
          : {
              ...candidate,
              status: 'stale',
              statusReason: 'metadata_revision_changed',
              approvalIntent: undefined,
              updatedAt: now,
            },
      );
    },
  );
  await transactionDone(tx);
}

export function deleteBookEnrichmentDataInTransaction(transaction: IDBTransaction, bookId: string): void {
  for (const storeName of Object.values(BOOK_ENRICHMENT_STORES)) {
    cursorEach(transaction.objectStore(storeName).index('bookId').openCursor(IDBKeyRange.only(bookId)), (cursor) => {
      cursor.delete();
    });
  }
}
