import type { BookAssetMetadata, BookAssetProvenance, EncodingMode } from '../domain/types';
import type { RemoteApiClient } from '../services/remote/remote-api-client';
import { RemoteApiError } from '../services/remote/remote-api-contracts';
import type { BookAssetRepository } from './book-asset-repository';

type JsonRecord = Record<string, unknown>;

function text(row: JsonRecord, key: string): string {
  return typeof row[key] === 'string' ? row[key] : '';
}

const bookAssetProvenances = new Set<BookAssetProvenance>([
  'original',
  'canonical_reconstruction',
  'user_supplied',
  'approved_enrichment',
  'epub_embedded',
  'archive_embedded',
  'generated_preview',
]);

function coverProvenance(value: string): BookAssetProvenance {
  return bookAssetProvenances.has(value as BookAssetProvenance) ? (value as BookAssetProvenance) : 'user_supplied';
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
  const status = text(row, 'status');
  return {
    id: text(row, 'id'),
    bookId: text(row, 'book_id'),
    kind: 'cover',
    provenance: coverProvenance(provenance),
    status: status === 'superseded' || status === 'staged' ? status : 'active',
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

function assertApprovedCoverRow(
  row: JsonRecord,
  expected: {
    readonly bookId: string;
    readonly contentHash?: string;
    readonly assetId?: string;
    readonly status: string;
  },
): void {
  if (
    !text(row, 'id') ||
    text(row, 'book_id') !== expected.bookId ||
    text(row, 'provenance') !== 'approved_enrichment' ||
    text(row, 'status') !== expected.status ||
    (expected.contentHash !== undefined && text(row, 'content_hash') !== expected.contentHash) ||
    (expected.assetId !== undefined && text(row, 'id') !== expected.assetId)
  ) {
    throw new Error('서버가 추천 표지 적용 결과를 완전하게 반환하지 않았습니다.');
  }
}

export class RemoteSourceRangeResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteSourceRangeResponseError';
  }
}

function assertValidRangeResponse(
  response: { blob: Blob; headers: Headers; status: number },
  start: number,
  end: number,
  sourceByteLength: number,
): void {
  const expectedLength = end - start;
  if (response.status !== 206) {
    throw new RemoteSourceRangeResponseError(`Expected HTTP 206 for source range, received ${response.status}.`);
  }
  const contentRange = response.headers.get('content-range');
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange?.trim() ?? '');
  const actualStart = match ? Number(match[1]) : Number.NaN;
  const actualEnd = match ? Number(match[2]) : Number.NaN;
  const actualTotal = match?.[3] === '*' ? undefined : Number(match?.[3]);
  if (
    !match ||
    actualStart !== start ||
    actualEnd !== end - 1 ||
    (sourceByteLength > 0 && actualTotal !== sourceByteLength)
  ) {
    throw new RemoteSourceRangeResponseError(
      `Invalid Content-Range for source bytes ${start}-${end - 1}: ${contentRange ?? 'missing'}.`,
    );
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== expectedLength) {
    throw new RemoteSourceRangeResponseError(`Invalid Content-Length for source range: ${contentLength}.`);
  }
  if (response.blob.size !== expectedLength) {
    throw new RemoteSourceRangeResponseError(
      `Source range body length mismatch: expected ${expectedLength}, received ${response.blob.size}.`,
    );
  }
}

export class RemoteBookAssetRepository implements BookAssetRepository {
  constructor(private readonly client: RemoteApiClient) {}

  async getActiveSource(bookId: string, expectation?: Parameters<BookAssetRepository['getActiveSource']>[1]) {
    const metadata = sourceMetadata(
      (await this.client.getBookSourceMetadata(bookId, expectation?.activeContentRevisionId)).source,
    );
    if (
      expectation?.activeContentRevisionId !== undefined &&
      metadata.contentRevisionId !== expectation.activeContentRevisionId
    ) {
      throw new Error(`Book ${bookId} content revision changed before source read`);
    }
    return metadata;
  }

  async exportSource(bookId: string, expectation?: Parameters<BookAssetRepository['exportSource']>[1]) {
    // Resolve the canonical incarnation first. Downloading in parallel could
    // combine R1 metadata with R2 bytes when a hard purge/reimport reuses the ID.
    const metadata = await this.getActiveSource(bookId, expectation);
    const expectedContentRevisionId = expectation?.activeContentRevisionId ?? metadata.contentRevisionId;
    const download = await this.client.getBookSource(bookId, expectedContentRevisionId);
    const downloadedContentRevisionId = download.headers.get('x-content-revision-id');
    if (
      downloadedContentRevisionId &&
      expectedContentRevisionId &&
      downloadedContentRevisionId !== expectedContentRevisionId
    ) {
      throw new Error(`Book ${bookId} content revision changed during source read`);
    }
    return { metadata, blob: download.blob };
  }

  async openSource(bookId: string, expectation?: Parameters<BookAssetRepository['openSource']>[1]) {
    const metadata = await this.getActiveSource(bookId, expectation);
    const expectedContentRevisionId = expectation?.activeContentRevisionId ?? metadata.contentRevisionId;
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
        const response = await this.client.getBookSourceRange(bookId, start, end, signal, expectedContentRevisionId);
        assertValidRangeResponse(response, start, end, metadata.byteLength);
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
      expectedContentRevisionId: input.expectedContentRevisionId,
    });
    return sourceMetadata(result.source);
  }

  async getActiveCover(bookId: string) {
    try {
      const download = await this.client.getBookCover(bookId);
      const metadata = download.metadata ?? (await this.client.getBookCoverMetadata(bookId)).cover;
      return { metadata: coverMetadata(metadata), blob: download.blob };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && Number(error.status) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async getActiveCoverMetadata(bookId: string) {
    try {
      return coverMetadata((await this.client.getBookCoverMetadata(bookId)).cover);
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

  async saveApprovedEnrichmentCover(
    bookId: string,
    input: Parameters<NonNullable<BookAssetRepository['saveApprovedEnrichmentCover']>>[1],
  ) {
    if (input.expectedMetadataRevision === undefined) {
      throw new Error('추천 표지 적용에는 최신 작품 정보가 필요합니다.');
    }
    let result: Awaited<ReturnType<RemoteApiClient['saveApprovedEnrichmentBookCover']>>;
    try {
      result = await this.client.saveApprovedEnrichmentBookCover(bookId, input.blob, {
        ...input,
        expectedMetadataRevision: input.expectedMetadataRevision,
      });
    } catch (error) {
      if (error instanceof RemoteApiError && error.status === 404) {
        throw Object.assign(
          new Error('추천 표지를 적용할 서버 기능을 찾지 못했습니다. Moya Web과 서버를 함께 업데이트해 주세요.'),
          { cause: error },
        );
      }
      throw error;
    }
    if (result.metadataRevision !== input.expectedMetadataRevision + 1) {
      throw new Error('서버가 추천 표지 적용 결과를 완전하게 반환하지 않았습니다.');
    }
    assertApprovedCoverRow(result.cover, {
      bookId,
      contentHash: input.contentHash,
      status: 'active',
    });
    if (result.previousCover !== null) {
      if (!text(result.previousCover, 'id') || text(result.previousCover, 'book_id') !== bookId) {
        throw new Error('서버가 이전 표지 보존 결과를 완전하게 반환하지 않았습니다.');
      }
      if (text(result.previousCover, 'status') !== 'superseded') {
        throw new Error('서버가 이전 표지를 안전하게 보존하지 않았습니다.');
      }
    }
    return {
      current: coverMetadata(result.cover),
      previous: result.previousCover === null ? undefined : coverMetadata(result.previousCover),
      metadataRevision: Number(result.metadataRevision),
    };
  }

  async restoreApprovedEnrichmentCover(
    bookId: string,
    input: Parameters<NonNullable<BookAssetRepository['restoreApprovedEnrichmentCover']>>[1],
  ) {
    const result = await this.client.restoreApprovedEnrichmentBookCover(bookId, input);
    if (result.metadataRevision !== input.expectedMetadataRevision + 1) {
      throw new Error('서버가 추천 표지 복원 결과를 완전하게 반환하지 않았습니다.');
    }
    if (input.previousAssetId && input.previousContentHash) {
      if (!result.cover) throw new Error('서버가 복원한 이전 표지를 반환하지 않았습니다.');
      const restored = result.cover;
      if (
        !text(restored, 'id') ||
        text(restored, 'id') !== input.previousAssetId ||
        text(restored, 'book_id') !== bookId ||
        text(restored, 'status') !== 'active' ||
        text(restored, 'content_hash') !== input.previousContentHash
      ) {
        throw new Error('서버가 추천 표지 복원 결과를 완전하게 반환하지 않았습니다.');
      }
    } else if (result.cover !== null) {
      throw new Error('서버가 표지 제거 복원 결과를 완전하게 반환하지 않았습니다.');
    }
    return {
      current: result.cover ? coverMetadata(result.cover) : undefined,
      metadataRevision: result.metadataRevision,
    };
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

  removeCover(bookId: string, expectation?: Parameters<BookAssetRepository['removeCover']>[1]) {
    return this.client.removeBookCover(bookId, expectation).then(() => undefined);
  }

  async getEmbeddedResource(
    bookId: string,
    assetId: string,
    expectation?: Parameters<BookAssetRepository['getEmbeddedResource']>[2],
  ) {
    try {
      const result = await this.client.getBookResource(bookId, assetId, expectation?.activeContentRevisionId);
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
