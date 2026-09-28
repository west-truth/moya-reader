import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import type { Novel, Chapter, ParagraphPage } from '../../domain/types';
import type { FixedDocumentScreenProps } from '../fixed-document/FixedDocumentScreen';
import type { SourceStreamSession } from '../../external-sources/source-stream';

/** A read-only document projection for the existing viewer. It does not import a book. */
export function sourceStreamDocument(id: string, title: string, session: SourceStreamSession, onLoaded: () => void) {
  const revision = `${id}:${crypto.randomUUID()}`;
  const timestamp = '1970-01-01T00:00:00.000Z';
  const novel: Novel = {
    id,
    title,
    format: 'image_archive',
    sourceFileName: title,
    activeContentRevisionId: revision,
    rawText: '',
    normalizedText: '',
    rawTextHash: id,
    normalizedTextHash: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    totalChapters: session.pageCount,
    totalCharacters: 0,
    totalParagraphs: session.pageCount,
    coverSeed: 0,
    lastReadOffset: 0,
    lastReadProgress: 0,
    favorite: false,
    analysisStatus: 'not_analyzed',
  };
  const chapters: Chapter[] = Array.from({ length: session.pageCount }, (_, index) => ({
    id: `${revision}:page:${index}`,
    novelId: id,
    index: index + 1,
    title: `${index + 1}`,
    normalizedText: '',
    textHash: `${id}:${index}`,
    rawStartOffset: 0,
    rawEndOffset: 0,
    characterCount: 0,
    paragraphCount: 1,
    documentSectionId: id,
    documentSectionTitle: title,
    documentSectionIndex: 0,
    documentPageIndexInSection: index,
    documentSectionSourceContentHash: revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const byId = new Map(chapters.map((chapter, index) => [chapter.id, index]));
  const repository: FixedDocumentScreenProps['repository'] = {
    getParagraphPage: async (chapterId, page, signal) => {
      signal?.throwIfAborted();
      const index = byId.get(chapterId);
      if (index === undefined || page !== 0) return undefined;
      const result: ParagraphPage = {
        id: chapterId,
        novelId: id,
        chapterId,
        pageIndex: 0,
        startParagraphIndex: 0,
        endParagraphIndex: 0,
        textHash: chapterId,
        paragraphs: [
          {
            id: chapterId,
            novelId: id,
            chapterId,
            index: 0,
            text: '',
            startOffsetInChapter: 0,
            endOffsetInChapter: 0,
            textHash: chapterId,
            assetId: chapterId,
          },
        ],
      };
      return result;
    },
  };
  const assets: FixedDocumentScreenProps['assets'] = {
    openSource: async () => undefined,
    getEmbeddedResource: async (_, assetId, signal) => {
      const index = byId.get(assetId);
      if (index === undefined) return undefined;
      const blob = await session.loadPage(index, signal ?? new AbortController().signal).catch((error) => {
        const message = packageOperationMessage(error);
        if (message) throw Object.assign(new Error(message), { cause: error });
        throw error;
      });
      onLoaded();
      return {
        blob,
        metadata: {
          id: `${id}:${index}`,
          bookId: id,
          kind: 'document_page',
          provenance: 'original',
          status: 'active',
          storageKey: `${id}:${index}`,
          contentType: blob.type,
          byteLength: blob.size,
          contentHash: `${id}:${index}`,
          createdAt: timestamp,
        },
      };
    },
  };
  return { novel, chapters, repository, assets };
}
