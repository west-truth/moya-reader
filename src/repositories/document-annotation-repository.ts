import type { DocumentAnnotation } from '../domain/types';

export interface DocumentAnnotationRepository {
  list(bookId: string): Promise<DocumentAnnotation[]>;
  listPage(bookId: string, pageIndex: number): Promise<DocumentAnnotation[]>;
  save(annotation: DocumentAnnotation): Promise<void>;
  remove(id: string, deletedAt?: string): Promise<void>;
}
