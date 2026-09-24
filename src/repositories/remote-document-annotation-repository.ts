import type { DocumentAnnotation } from '../domain/types';
import type { DocumentAnnotationRepository } from './document-annotation-repository';
import type { RemoteApiClient } from '../services/remote/remote-api-client';

export class RemoteDocumentAnnotationRepository implements DocumentAnnotationRepository {
  constructor(private readonly client: RemoteApiClient) {}

  async list(bookId: string): Promise<DocumentAnnotation[]> {
    const result = await this.client.request<{ annotations: DocumentAnnotation[] }>(
      `/books/${encodeURIComponent(bookId)}/document-annotations`,
    );
    for (const annotation of result.annotations) this.bookIds.set(annotation.id, bookId);
    return result.annotations;
  }

  async listPage(bookId: string, pageIndex: number): Promise<DocumentAnnotation[]> {
    return (await this.list(bookId)).filter((item) => item.pageIndex === pageIndex);
  }

  async save(annotation: DocumentAnnotation): Promise<void> {
    await this.client.request(
      `/books/${encodeURIComponent(annotation.bookId)}/document-annotations/${encodeURIComponent(annotation.id)}`,
      { method: 'PUT', body: JSON.stringify(annotation) },
    );
    this.bookIds.set(annotation.id, annotation.bookId);
  }

  async remove(id: string): Promise<void> {
    // The UI only has an annotation ID here, so remember book ownership from reads and writes.
    const bookId = this.bookIds.get(id);
    if (!bookId) throw new Error('주석의 작품 정보를 찾을 수 없습니다. 주석 목록을 다시 열어 주세요.');
    await this.client.request(`/books/${encodeURIComponent(bookId)}/document-annotations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    this.bookIds.delete(id);
  }

  private readonly bookIds = new Map<string, string>();
}
