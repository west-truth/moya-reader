import type { RemoteApiClient } from '../services/remote/remote-api-client';
import type {
  ChapterStructureCommand,
  ChapterStructureEditorState,
  ChapterStructurePreview,
  ChapterStructureReceipt,
  ChapterStructureRepository,
  ChapterStructureReviewItem,
} from './chapter-structure-repository';

export class RemoteChapterStructureRepository implements ChapterStructureRepository {
  constructor(private readonly client: RemoteApiClient) {}

  getEditorState(bookId: string): Promise<ChapterStructureEditorState> {
    return this.client.getChapterStructureEditor(bookId).then((result) => result.editor);
  }

  preview(bookId: string, commands: readonly ChapterStructureCommand[]): Promise<ChapterStructurePreview> {
    return this.client.previewChapterStructure(bookId, commands).then((result) => result.preview);
  }

  apply(draftId: string): Promise<ChapterStructureReceipt> {
    return this.client.applyChapterStructure(draftId).then((result) => result.receipt);
  }

  rollback(receiptId: string): Promise<ChapterStructureReceipt> {
    return this.client.rollbackChapterStructure(receiptId).then((result) => result.receipt);
  }

  listReviewItems(bookId: string): Promise<readonly ChapterStructureReviewItem[]> {
    return this.client.listChapterStructureReview(bookId).then((result) => result.items);
  }
}
