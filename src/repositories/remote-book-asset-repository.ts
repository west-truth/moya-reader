import type { BookAssetMetadata, EncodingMode } from '../domain/types';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import { RemoteApiError } from '../services/remote/remote-api-contracts';
import type { BookAssetRepository } from './book-asset-repository';

type JsonRecord = Record<string, unknown>;

function text(row: JsonRecord, key: string): string {
  return typeof row[key] === 'string' ? row[key] : '';
}

function sourceMetadata(row: JsonRecord): BookAssetMetadata {
  return {
    id: text(row, 'id'),
    bookId: text(row, 'book_id'),
    contentRevisionId: text(row, 'content_revision_id') || undefined,
    kind: 'source',
    provenance: 'original',
    status: 'active',
    storageKey: text(row, 'storage_key') || text(row, 'id'),
    fileName: text(row, 'file_name') || undefined,
    contentType: text(row, 'content_type') || 'application/octet-stream',
    byteLength: Number(row.size_bytes) || 0,
    contentHash: text(row, 'raw_text_hash'),
    encoding: (text(row, 'source_encoding') || undefined) as EncodingMode | undefined,
    createdAt: text(row, 'created_at') || new Date(0).toISOString(),
  };
}

function coverMetadata(row: JsonRecord): BookAssetMetadata {
  const provenance = text(row, 'provenance');
  return {
    id: text(row, 'id'),
    bookId: text(row, 'book_id'),
    kind: 'cover',
    provenance: provenance === 'generated_preview' ? 'generated_preview' : 'user_supplied',
    status: 'active',
    storageKey: text(row, 'storage_key') || text(row, 'id'),
    fileName: text(row, 'file_name') || undefined,
    contentType: text(row, 'content_type') || 'image/jpeg',
    byteLength: Number(row.byte_length) || 0,
    contentHash: text(row, 'content_hash'),
    pixelWidth: Number(row.pixel_width) || undefined,
    pixelHeight: Number(row.pixel_height) || undefined,
    createdAt: text(row, 'created_at') || new Date(0).toISOString(),
    activatedAt: text(row, 'activated_at') || undefined,
  };
}

export class RemoteBookAssetRepository implements BookAssetRepository {
  constructor(private readonly client: RemoteApiClient) {}

  async getActiveSource(bookId: string) {
    return sourceMetadata((await this.client.getBookSourceMetadata(bookId)).source);
  }

  async exportSource(bookId: string) {
    const [metadata, download] = await Promise.all([this.getActiveSource(bookId), this.client.getBookSource(bookId)]);
    return { metadata, blob: download.blob };
  }

  async openSource(bookId: string) {
    const metadata = await this.getActiveSource(bookId);
    let closed = false;
    return {
      byteLength: metadata.byteLength,
      contentType: metadata.contentType,
      contentHash: metadata.contentHash,
      readRange: async (startInclusive: number, endExclusive: number, signal?: AbortSignal) => {
        if (closed) throw new Error('Book source is closed.');
        const start = Math.max(0, Math.floor(startInclusive));
        const end = Math.min(metadata.byteLength, Math.max(start, Math.floor(endExclusive)));
        if (end <= start) return new Uint8Array();
        const response = await this.client.getBookSourceRange(bookId, start, end, signal);
        return new Uint8Array(await response.blob.arrayBuffer());
      },
      close: async () => {
        closed = true;
      },
    };
  }

  async reselectOriginalSource(bookId: string, input: Parameters<BookAssetRepository['reselectOriginalSource']>[1]) {
    const result = await this.client.reselectBookSource(bookId, input.blob, {
      fileName: input.fileName,
      contentType: input.contentType,
    });
    return sourceMetadata(result.source);
  }

  async getActiveCover(bookId: string) {
    try {
      const [metadata, download] = await Promise.all([
        this.client.getBookCoverMetadata(bookId),
        this.client.getBookCover(bookId),
      ]);
      return { metadata: coverMetadata(metadata.cover), blob: download.blob };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && Number(error.status) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async saveCover(bookId: string, input: Parameters<BookAssetRepository['saveCover']>[1]) {
    const result = await this.client.saveBookCover(bookId, input.blob, input);
    return coverMetadata(result.cover);
  }

  async saveGeneratedCover(
    bookId: string,
    input: Parameters<NonNullable<BookAssetRepository['saveGeneratedCover']>>[1],
  ) {
    try {
      const result = await this.client.saveBookCover(bookId, input.blob, {
        ...input,
        provenance: 'generated_preview',
      });
      return coverMetadata(result.cover);
    } catch (error) {
      if (
        error instanceof RemoteApiError &&
        error.status === 409 &&
        error.message.includes('generated cover cannot replace')
      ) {
        return undefined;
      }
      throw error;
    }
  }

  removeCover(bookId: string, expectedMetadataRevision?: number) {
    return this.client.removeBookCover(bookId, expectedMetadataRevision).then(() => undefined);
  }

  async getEmbeddedResource(bookId: string, assetId: string) {
    try {
      const result = await this.client.getBookResource(bookId, assetId);
      const pageIndexHeader = result.headers.get('x-page-index');
      return {
        metadata: {
          id: assetId,
          bookId,
          kind:
            result.headers.get('x-asset-kind') === 'document_page'
              ? ('document_page' as const)
              : ('epub_resource' as const),
          provenance:
            result.headers.get('x-asset-kind') === 'document_page'
              ? ('archive_embedded' as const)
              : ('epub_embedded' as const),
          status: 'active' as const,
          storageKey: assetId,
          fileName: decodeURIComponent(result.headers.get('x-asset-file-name') ?? 'resource'),
          contentType: result.blob.type || 'application/octet-stream',
          byteLength: result.blob.size,
          contentHash: result.headers.get('etag') ?? '',
          pageIndex: pageIndexHeader === null || pageIndexHeader === '' ? undefined : Number(pageIndexHeader),
          createdAt: new Date(0).toISOString(),
        },
        blob: result.blob,
      };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && Number(error.status) === 404) {
        return undefined;
      }
      throw error;
    }
  }
}
