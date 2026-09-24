import { describe, expect, it, vi } from 'vitest';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import { RemoteDocumentAnnotationRepository } from './remote-document-annotation-repository';

describe('RemoteDocumentAnnotationRepository', () => {
  it('uses the selected server for document bookmarks and deletion', async () => {
    const bookmark = {
      id: 'annotation_1',
      bookId: 'book_1',
      pageIndex: 0,
      type: 'page_bookmark' as const,
      anchor: { kind: 'fixed_page' as const, bookId: 'book_1', pageIndex: 0, pageHash: 'source:pdf-page:0' },
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z',
    };
    const request = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === '/books/book_1/document-annotations' && !options) return { annotations: [bookmark] };
      return { ok: true };
    });
    const repository = new RemoteDocumentAnnotationRepository({ request } as unknown as RemoteApiClient);
    await expect(repository.listPage('book_1', 0)).resolves.toEqual([bookmark]);
    await repository.save(bookmark);
    await repository.remove(bookmark.id);
    expect(request).toHaveBeenCalledWith('/books/book_1/document-annotations/annotation_1', {
      method: 'PUT',
      body: JSON.stringify(bookmark),
    });
    expect(request).toHaveBeenCalledWith('/books/book_1/document-annotations/annotation_1', { method: 'DELETE' });
    await expect(repository.remove(bookmark.id)).rejects.toThrow('작품 정보를 찾을 수 없습니다');
  });
});
