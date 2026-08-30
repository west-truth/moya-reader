import type { BookAssetRepository } from './book-asset-repository';
import {
  exportBookSource,
  getActiveBookCover,
  exportEmbeddedBookAsset,
  getActiveSourceAsset,
  reconstructCanonicalBookSource,
  removeBookCover,
  reselectOriginalBookSource,
  restoreApprovedEnrichmentBookCover,
  saveApprovedEnrichmentBookCover,
  saveBookCover,
  saveGeneratedBookCover,
} from '../storage/book-asset-store';

export class IndexedDbBookAssetRepository implements BookAssetRepository {
  getActiveSource(bookId: string) {
    return getActiveSourceAsset(bookId);
  }

  exportSource(bookId: string) {
    return exportBookSource(bookId);
  }

  async openSource(bookId: string) {
    const source = await exportBookSource(bookId);
    if (!source) return undefined;
    let closed = false;
    return {
      byteLength: source.blob.size,
      contentType: source.metadata.contentType,
      contentHash: source.metadata.contentHash,
      async readRange(startInclusive: number, endExclusive: number, signal?: AbortSignal) {
        if (closed) throw new Error('Book source is closed.');
        signal?.throwIfAborted();
        const start = Math.max(0, Math.floor(startInclusive));
        const end = Math.min(source.blob.size, Math.max(start, Math.floor(endExclusive)));
        return new Uint8Array(await source.blob.slice(start, end).arrayBuffer());
      },
      async close() {
        closed = true;
      },
    };
  }

  reselectOriginalSource(bookId: string, input: Parameters<BookAssetRepository['reselectOriginalSource']>[1]) {
    return reselectOriginalBookSource(bookId, input);
  }

  reconstructCanonicalSource(bookId: string) {
    return reconstructCanonicalBookSource(bookId);
  }

  getActiveCover(bookId: string) {
    return getActiveBookCover(bookId);
  }

  saveCover(bookId: string, input: Parameters<BookAssetRepository['saveCover']>[1]) {
    return saveBookCover(bookId, input);
  }

  saveApprovedEnrichmentCover(
    bookId: string,
    input: Parameters<NonNullable<BookAssetRepository['saveApprovedEnrichmentCover']>>[1],
  ) {
    return saveApprovedEnrichmentBookCover(bookId, input);
  }

  restoreApprovedEnrichmentCover(
    bookId: string,
    input: Parameters<NonNullable<BookAssetRepository['restoreApprovedEnrichmentCover']>>[1],
  ) {
    return restoreApprovedEnrichmentBookCover(bookId, input);
  }

  saveGeneratedCover(bookId: string, input: Parameters<NonNullable<BookAssetRepository['saveGeneratedCover']>>[1]) {
    return saveGeneratedBookCover(bookId, input);
  }

  removeCover(bookId: string, expectedMetadataRevision?: number) {
    return removeBookCover(bookId, expectedMetadataRevision);
  }

  async getEmbeddedResource(bookId: string, assetId: string) {
    const resource = await exportEmbeddedBookAsset(assetId);
    return resource?.metadata.bookId === bookId ? resource : undefined;
  }
}
