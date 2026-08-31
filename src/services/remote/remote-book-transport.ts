import type { Paragraph } from '../../domain/types';
import {
  snapshotQueryPath,
  type RemoteBookManifestResponse,
  type RemoteChapterListResponse,
  type RemotePageListResponse,
} from './remote-book-snapshot';
import type { RemoteRequest } from './remote-api-contracts';

export class RemoteBookTransport {
  constructor(private readonly request: RemoteRequest) {}

  async listBooks(
    signal?: AbortSignal,
    options?: { includeTrash?: boolean },
  ): Promise<{ books: Record<string, unknown>[] }> {
    const books: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    const includeTrash = options?.includeTrash === true;
    let path = includeTrash ? '/books?includeTrash=true' : '/books';
    while (true) {
      const page = await this.request<{
        books: Record<string, unknown>[];
        nextCursor?: string;
        includesTrash?: boolean;
      }>(path, { signal });
      if (includeTrash && page.includesTrash !== true) {
        throw new Error('서버를 업데이트한 뒤 소스 목록을 새로고침해 주세요.');
      }
      books.push(...page.books);
      const cursor = page.nextCursor?.trim();
      if (!cursor) return { books };
      if (seenCursors.has(cursor)) throw new Error('The server repeated a library cursor.');
      seenCursors.add(cursor);
      path = `/books?limit=1000&cursor=${encodeURIComponent(cursor)}${includeTrash ? '&includeTrash=true' : ''}`;
    }
  }

  getBookManifest(bookId: string, sourceRevision?: string, signal?: AbortSignal): Promise<RemoteBookManifestResponse> {
    return this.request(snapshotQueryPath(`/books/${encodeURIComponent(bookId)}/manifest`, sourceRevision), { signal });
  }

  listChapters(bookId: string, sourceRevision?: string, signal?: AbortSignal): Promise<RemoteChapterListResponse> {
    return this.request(snapshotQueryPath(`/books/${encodeURIComponent(bookId)}/chapters`, sourceRevision), { signal });
  }

  getChapter(chapterId: string, signal?: AbortSignal): Promise<{ chapter: Record<string, unknown> }> {
    return this.request(`/chapters/${encodeURIComponent(chapterId)}`, { signal });
  }

  listPages(
    chapterId: string,
    from = 0,
    count = 5,
    sourceRevision?: string,
    signal?: AbortSignal,
  ): Promise<RemotePageListResponse> {
    return this.request(
      snapshotQueryPath(`/chapters/${encodeURIComponent(chapterId)}/pages?from=${from}&count=${count}`, sourceRevision),
      { signal },
    );
  }

  getParagraph(paragraphId: string, signal?: AbortSignal): Promise<{ paragraph: Paragraph }> {
    return this.request(`/paragraphs/${encodeURIComponent(paragraphId)}`, { signal });
  }
}
