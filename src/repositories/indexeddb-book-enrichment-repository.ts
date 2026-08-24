import type { BookEnrichmentRepository } from './book-enrichment-repository';
import {
  getBookEnrichmentCandidate,
  getBookEnrichmentReceipt,
  listBookEnrichmentCandidates,
  listBookEnrichmentReceipts,
  markCompetingBookEnrichmentCandidatesStale,
  recordBookEnrichmentApproval,
  recordBookEnrichmentUndo,
  replacePendingBookEnrichmentCandidates,
  updateBookEnrichmentCandidateStatus,
} from '../storage/book-enrichment-store';

export class IndexedDbBookEnrichmentRepository implements BookEnrichmentRepository {
  listCandidates(bookId: string) {
    return listBookEnrichmentCandidates(bookId);
  }

  listReceipts(bookId: string) {
    return listBookEnrichmentReceipts(bookId);
  }

  getReceipt(receiptId: string) {
    return getBookEnrichmentReceipt(receiptId);
  }

  getCandidate(candidateId: string) {
    return getBookEnrichmentCandidate(candidateId);
  }

  replacePendingCandidates(...args: Parameters<BookEnrichmentRepository['replacePendingCandidates']>) {
    return replacePendingBookEnrichmentCandidates(...args);
  }

  updateCandidateStatus(...args: Parameters<BookEnrichmentRepository['updateCandidateStatus']>) {
    return updateBookEnrichmentCandidateStatus(...args);
  }

  recordApproval(...args: Parameters<BookEnrichmentRepository['recordApproval']>) {
    return recordBookEnrichmentApproval(...args);
  }

  recordUndo(...args: Parameters<BookEnrichmentRepository['recordUndo']>) {
    return recordBookEnrichmentUndo(...args);
  }

  markCompetingCandidatesStale(...args: Parameters<BookEnrichmentRepository['markCompetingCandidatesStale']>) {
    return markCompetingBookEnrichmentCandidatesStale(...args);
  }
}
