import { describe, expect, it, vi } from 'vitest';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import { RemoteChapterStructureRepository } from './remote-chapter-structure-repository';

describe('RemoteChapterStructureRepository', () => {
  it('keeps editor, preview, apply and rollback behind the remote client boundary', async () => {
    const editor = {
      bookId: 'book_1',
      baseContentRevisionId: 'revision_1',
      sourceProvenance: 'original' as const,
      chapters: [],
      reviewItemCount: 0,
    };
    const receipt = {
      id: 'receipt_1',
      bookId: 'book_1',
      draftId: 'draft_1',
      previousContentRevisionId: 'revision_1',
      contentRevisionId: 'revision_2',
      commands: [{ kind: 'rename' as const, chapterId: 'chapter_1', title: 'Renamed' }],
      status: 'active' as const,
      createdAt: '2026-07-13T00:00:00.000Z',
    };
    const preview = {
      draftId: 'draft_1',
      bookId: 'book_1',
      baseContentRevisionId: 'revision_1',
      commands: receipt.commands,
      before: [],
      after: [],
      affectedChapterIds: ['chapter_1'],
      impact: {
        preservedParagraphs: 1,
        addedParagraphs: 0,
        removedParagraphs: 0,
        readerAnnotationsAtRisk: 0,
        correctionsForReview: 0,
      },
      warnings: [],
      createdAt: '2026-07-13T00:00:00.000Z',
    };
    const client = {
      getChapterStructureEditor: vi.fn(async () => ({ editor })),
      previewChapterStructure: vi.fn(async () => ({ preview })),
      applyChapterStructure: vi.fn(async () => ({ receipt })),
      rollbackChapterStructure: vi.fn(async () => ({ receipt: { ...receipt, status: 'rolled_back' as const } })),
      listChapterStructureReview: vi.fn(async () => ({ items: [] })),
    } as unknown as RemoteApiClient;
    const repository = new RemoteChapterStructureRepository(client);

    await expect(repository.getEditorState('book_1')).resolves.toEqual(editor);
    await expect(repository.preview('book_1', receipt.commands)).resolves.toEqual(preview);
    await expect(repository.apply('draft_1')).resolves.toEqual(receipt);
    await expect(repository.rollback('receipt_1')).resolves.toMatchObject({ status: 'rolled_back' });
    await expect(repository.listReviewItems('book_1')).resolves.toEqual([]);
  });
});
