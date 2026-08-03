import type { DocumentTextBlock, DocumentTextOrderOverride, DocumentTextRevision } from '../domain/types';

export interface DocumentTextSearchResult {
  readonly pageIndex: number;
  readonly revisionId: string;
  readonly blockId: string;
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly quads: DocumentTextBlock['quads'];
  readonly source: DocumentTextRevision['source'];
  readonly blockOrder: number;
}

export interface DocumentTextRepository {
  findReadyRevision(bookId: string, pageIndex: number, pageHash: string): Promise<DocumentTextRevision | undefined>;
  listRevisions(bookId: string): Promise<DocumentTextRevision[]>;
  listReadyRevisions(bookId: string): Promise<DocumentTextRevision[]>;
  getBlocks(revisionId: string): Promise<DocumentTextBlock[]>;
  getRawBlocks(revisionId: string): Promise<DocumentTextBlock[]>;
  getOrderOverride(bookId: string, pageIndex: number): Promise<DocumentTextOrderOverride | undefined>;
  saveOrderOverride(override: DocumentTextOrderOverride): Promise<void>;
  removeOrderOverride(id: string): Promise<void>;
  saveRevision(revision: DocumentTextRevision): Promise<void>;
  markRevisionStatus(revisionId: string, status: DocumentTextRevision['status'], errorMessage?: string): Promise<void>;
  recoverInterruptedOcr(bookId: string): Promise<DocumentTextRevision[]>;
  saveReadyPage(revision: DocumentTextRevision, blocks: readonly DocumentTextBlock[]): Promise<void>;
  search(bookId: string, query: string, limit?: number): Promise<DocumentTextSearchResult[]>;
}
