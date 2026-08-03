import type { UserCorrection } from '../domain/types';
import type { ChapterStructureChapterView, ChapterStructureCommand } from '@noveldesk/text-core/chapter-structure';

export type { ChapterStructureCommand } from '@noveldesk/text-core/chapter-structure';

export interface ChapterStructureImpact {
  readonly preservedParagraphs: number;
  readonly addedParagraphs: number;
  readonly removedParagraphs: number;
  readonly readerAnnotationsAtRisk: number;
  readonly correctionsForReview: number;
}

export interface ChapterStructurePreview {
  readonly draftId: string;
  readonly bookId: string;
  readonly baseContentRevisionId: string;
  readonly commands: readonly ChapterStructureCommand[];
  readonly before: readonly ChapterStructureChapterView[];
  readonly after: readonly ChapterStructureChapterView[];
  readonly affectedChapterIds: readonly string[];
  readonly impact: ChapterStructureImpact;
  readonly warnings: readonly string[];
  readonly createdAt: string;
}

export interface ChapterStructureEditorState {
  readonly bookId: string;
  readonly baseContentRevisionId: string;
  readonly sourceProvenance: 'original' | 'canonical_reconstruction';
  readonly chapters: readonly ChapterStructureChapterView[];
  readonly latestReceipt?: ChapterStructureReceipt;
  readonly reviewItemCount: number;
}

export interface ChapterStructureReceipt {
  readonly id: string;
  readonly bookId: string;
  readonly draftId: string;
  readonly previousContentRevisionId: string;
  readonly contentRevisionId: string;
  readonly commands: readonly ChapterStructureCommand[];
  readonly status: 'active' | 'rolled_back';
  readonly createdAt: string;
  readonly rolledBackAt?: string;
  readonly rollbackContentRevisionId?: string;
}

export interface ChapterStructureReviewItem {
  readonly id: string;
  readonly bookId: string;
  readonly receiptId: string;
  readonly kind: 'correction_unmapped' | 'reader_anchor_unmapped';
  readonly correction?: UserCorrection;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly payload?: unknown;
  readonly createdAt: string;
}

export interface ChapterStructureRepository {
  getEditorState(bookId: string): Promise<ChapterStructureEditorState>;
  preview(bookId: string, commands: readonly ChapterStructureCommand[]): Promise<ChapterStructurePreview>;
  apply(draftId: string): Promise<ChapterStructureReceipt>;
  rollback(receiptId: string): Promise<ChapterStructureReceipt>;
  listReviewItems(bookId: string): Promise<readonly ChapterStructureReviewItem[]>;
}
