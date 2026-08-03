import type { Novel } from '../../domain/types';

export function serializeLibraryMetadata(books: readonly Novel[]): string {
  return JSON.stringify(
    {
      format: 'noveldesk-library-metadata',
      version: 1,
      exportedAt: new Date().toISOString(),
      books: books.map((book) => ({
        id: book.id,
        title: book.title,
        author: book.author ?? null,
        seriesTitle: book.seriesTitle ?? null,
        seriesIndex: book.seriesIndex ?? null,
        tags: book.tags ?? [],
        description: book.description ?? null,
        language: book.language ?? null,
        format: book.format ?? 'txt',
        sourceFileName: book.sourceFileName,
        sourceEncoding: book.sourceEncoding,
        sourceHash: book.rawTextHash,
        favorite: book.favorite,
        deletedAt: book.deletedAt ?? null,
        createdAt: book.createdAt,
        updatedAt: book.updatedAt,
      })),
    },
    null,
    2,
  );
}

export function downloadLibraryMetadata(books: readonly Novel[]): void {
  const blob = new Blob([serializeLibraryMetadata(books)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `moya-metadata-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
