import type { BookAssetMetadata, EncodingMode } from '../domain/types';

export interface OriginalSourceAssetInput {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly contentHash: string;
  readonly encoding?: EncodingMode;
  readonly provenance?: 'original' | 'canonical_reconstruction';
  readonly blob: Blob;
}

export interface ExportedBookSource {
  readonly metadata: BookAssetMetadata;
  readonly blob: Blob;
}

export interface RandomAccessBookSource {
  readonly byteLength: number;
  readonly contentType: string;
  readonly contentHash: string;
  readRange(startInclusive: number, endExclusive: number, signal?: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface BookSourceReadExpectation {
  readonly activeContentRevisionId?: string;
}

export interface BookCoverAssetInput {
  readonly blob: Blob;
  readonly fileName: string;
  readonly contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly contentHash: string;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly fit: 'crop' | 'contain';
  readonly positionX: number;
  readonly positionY: number;
  readonly expectedMetadataRevision?: number;
  readonly expectedContentRevisionId?: string;
}

export interface BookCoverMutationExpectation {
  readonly metadataRevision?: number;
  readonly activeContentRevisionId?: string;
}

export interface ExportedBookCover {
  readonly metadata: BookAssetMetadata;
  readonly blob: Blob;
}

export interface ApprovedEnrichmentCoverMutationReceipt {
  readonly current: BookAssetMetadata;
  readonly previous?: BookAssetMetadata;
  readonly metadataRevision: number;
}

export interface ApprovedEnrichmentCoverRestoreInput {
  readonly expectedMetadataRevision: number;
  readonly expectedContentRevisionId?: string;
  readonly expectedActiveAssetId: string;
  readonly expectedActiveContentHash: string;
  readonly previousAssetId?: string;
  readonly previousContentHash?: string;
  readonly previousFit: 'crop' | 'contain';
  readonly previousPositionX: number;
  readonly previousPositionY: number;
}

export interface ApprovedEnrichmentCoverRestoreReceipt {
  readonly current?: BookAssetMetadata;
  readonly metadataRevision: number;
}

export interface GeneratedBookCoverInput extends Omit<BookCoverAssetInput, 'expectedMetadataRevision'> {
  readonly derivationFingerprint: string;
}

export interface ExportedBookResource {
  readonly metadata: BookAssetMetadata;
  readonly blob: Blob;
}

export interface ReselectedBookSourceInput {
  readonly fileName: string;
  readonly contentType: string;
  readonly blob: Blob;
  /**
   * Fences a delayed source attachment to the content incarnation that opened
   * the picker. Hosted clients must send this value after an ID was reused.
   */
  readonly expectedContentRevisionId?: string;
}

export class OriginalSourceMismatchError extends Error {
  constructor() {
    super('선택한 파일이 이 책의 원본과 일치하지 않습니다.');
    this.name = 'OriginalSourceMismatchError';
  }
}

export interface BookAssetRepository {
  getActiveSource(bookId: string, expectation?: BookSourceReadExpectation): Promise<BookAssetMetadata | undefined>;
  exportSource(bookId: string, expectation?: BookSourceReadExpectation): Promise<ExportedBookSource | undefined>;
  openSource(bookId: string, expectation?: BookSourceReadExpectation): Promise<RandomAccessBookSource | undefined>;
  reselectOriginalSource(bookId: string, input: ReselectedBookSourceInput): Promise<BookAssetMetadata>;
  reconstructCanonicalSource?(bookId: string): Promise<BookAssetMetadata>;
  /**
   * Reads only the active cover descriptor. Hosted adapters must not download
   * the cover body for provenance checks.
   */
  getActiveCoverMetadata(bookId: string): Promise<BookAssetMetadata | undefined>;
  getActiveCover(bookId: string): Promise<ExportedBookCover | undefined>;
  saveCover(bookId: string, input: BookCoverAssetInput): Promise<BookAssetMetadata>;
  saveApprovedEnrichmentCover?(
    bookId: string,
    input: BookCoverAssetInput,
  ): Promise<ApprovedEnrichmentCoverMutationReceipt>;
  restoreApprovedEnrichmentCover?(
    bookId: string,
    input: ApprovedEnrichmentCoverRestoreInput,
  ): Promise<ApprovedEnrichmentCoverRestoreReceipt>;
  saveGeneratedCover?(bookId: string, input: GeneratedBookCoverInput): Promise<BookAssetMetadata | undefined>;
  removeCover(bookId: string, expectation?: BookCoverMutationExpectation): Promise<void>;
  getEmbeddedResource(
    bookId: string,
    assetId: string,
    expectation?: BookSourceReadExpectation,
  ): Promise<ExportedBookResource | undefined>;
}
