import type {
  BookEnrichmentApprovalIntent,
  BookEnrichmentApprovalReceipt,
  BookEnrichmentCandidate,
} from '../features/book-enrichment/book-enrichment-contract';

export interface BookEnrichmentRepository {
  listCandidates(bookId: string): Promise<BookEnrichmentCandidate[]>;
  listReceipts(bookId: string): Promise<BookEnrichmentApprovalReceipt[]>;
  getReceipt(receiptId: string): Promise<BookEnrichmentApprovalReceipt | undefined>;
  getCandidate(candidateId: string): Promise<BookEnrichmentCandidate | undefined>;
  replacePendingCandidates(
    bookId: string,
    contributionId: string,
    candidates: readonly BookEnrichmentCandidate[],
  ): Promise<void>;
  updateCandidateStatus(
    candidateId: string,
    status: BookEnrichmentCandidate['status'],
    reason?: string,
  ): Promise<BookEnrichmentCandidate | undefined>;
  stageApprovalIntent(candidateId: string, intent: BookEnrichmentApprovalIntent): Promise<BookEnrichmentCandidate>;
  resolveApprovalIntent(
    candidateId: string,
    operationId: string,
    outcome: 'pending' | 'stale',
    reason?: string,
  ): Promise<BookEnrichmentCandidate | undefined>;
  recordApproval(
    candidateId: string,
    receipt: BookEnrichmentApprovalReceipt,
    expectedApprovalOperationId?: string,
  ): Promise<BookEnrichmentCandidate | undefined>;
  recordUndo(receipt: BookEnrichmentApprovalReceipt): Promise<void>;
  reconcileCandidatesAfterApproval(
    approvedCandidate: BookEnrichmentCandidate,
    appliedMetadataRevision: number,
  ): Promise<void>;
}
