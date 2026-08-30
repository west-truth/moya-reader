import type { BookEnrichmentProviderDescriptor, ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { BookCoverAssetInput } from '../../repositories/book-asset-repository';

export const BOOK_ENRICHMENT_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION = 2 as const;
export const BOOK_ENRICHMENT_APPROVAL_INTENT_SCHEMA_VERSION = 1 as const;

export const BOOK_ENRICHMENT_METADATA_FIELDS = [
  'title',
  'author',
  'seriesTitle',
  'seriesIndex',
  'tags',
  'description',
  'language',
] as const;

export type BookEnrichmentMetadataField = (typeof BOOK_ENRICHMENT_METADATA_FIELDS)[number];

export interface BookEnrichmentMetadataValues {
  readonly title?: string;
  readonly author?: string | null;
  readonly seriesTitle?: string | null;
  readonly seriesIndex?: number | null;
  readonly tags?: readonly string[];
  readonly description?: string | null;
  readonly language?: string | null;
}

export interface PublicBookMetadataSnapshot {
  readonly bookId: string;
  readonly metadataRevision: number;
  readonly contentRevisionId?: string;
  readonly sourceFileName?: string;
  readonly title: string;
  readonly author?: string;
  readonly seriesTitle?: string;
  readonly seriesIndex?: number;
  readonly tags: readonly string[];
  readonly description?: string;
  readonly language?: string;
  readonly readingDirection?: 'ltr' | 'rtl';
  readonly cover: {
    readonly present: boolean;
    readonly provenance?: string;
    readonly contentHash?: string;
  };
}

/**
 * A trusted provider's bounded recommendation. The host still owns the apply
 * policy and must never treat this hint as permission to overwrite user data.
 */
export interface BookEnrichmentAutomationHint {
  readonly autoApplyEligible: boolean;
  readonly matchType?: 'exact_identity' | 'exact_title_and_author' | 'exact_title' | 'fuzzy_title' | 'ambiguous';
  readonly metadataQuality?: 'full' | 'partial';
  readonly reasons: readonly string[];
  readonly authenticatedSearch?: boolean;
}

interface BookEnrichmentCandidateDraftBase {
  /** Groups metadata and cover drafts produced by one resolved catalog match. */
  readonly proposalGroupId?: string;
  readonly confidence?: number;
  readonly rationale?: string;
  readonly sourceFingerprints?: readonly string[];
  readonly providerId?: string;
  readonly modelId?: string;
  readonly sourceLabel?: string;
  readonly sourceUrl?: string;
  readonly licenseSummary?: string;
  readonly automation?: BookEnrichmentAutomationHint;
}

export interface BookEnrichmentMetadataCandidateDraft extends BookEnrichmentCandidateDraftBase {
  readonly kind: 'metadata';
  readonly patch: BookEnrichmentMetadataValues;
}

export interface BookEnrichmentCoverCandidateDraft extends BookEnrichmentCandidateDraftBase {
  readonly kind: 'cover';
  readonly binary: Blob;
  readonly fileName: string;
  readonly declaredContentType: string;
  readonly derivationFingerprint: string;
  readonly fit?: 'crop' | 'contain';
  readonly positionX?: number;
  readonly positionY?: number;
}

export type BookEnrichmentCandidateDraft = BookEnrichmentMetadataCandidateDraft | BookEnrichmentCoverCandidateDraft;

export interface TrustedBookEnrichmentHostContext {
  readonly book: PublicBookMetadataSnapshot;
  readonly signal?: AbortSignal;
}

export interface BookEnrichmentProvenance {
  readonly extensionId: ExtensionContributionId;
  readonly extensionVersion: string;
  readonly contributionId: ExtensionContributionId;
  readonly origin: 'bundled_trusted';
  readonly registrationFingerprint: string;
  readonly sourceFingerprints: readonly string[];
  readonly providerId?: string;
  readonly modelId?: string;
  readonly generatedAt: string;
  readonly confidence?: number;
  readonly rationale?: string;
  readonly sourceLabel?: string;
  readonly sourceUrl?: string;
  readonly licenseSummary?: string;
  readonly automation?: BookEnrichmentAutomationHint;
}

interface BookEnrichmentCandidateBase {
  readonly schemaVersion: typeof BOOK_ENRICHMENT_CANDIDATE_SCHEMA_VERSION;
  readonly id: string;
  readonly bookId: string;
  readonly status: 'pending' | 'stale' | 'applied' | 'rejected';
  readonly baseMetadataRevision: number;
  readonly baseContentRevisionId?: string;
  readonly proposalGroupId?: string;
  readonly provenance: BookEnrichmentProvenance;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly statusReason?: string;
  /**
   * Host-owned write-ahead intent. It is persisted before the canonical book
   * mutation so a later session can finish the approval receipt safely.
   */
  readonly approvalIntent?: BookEnrichmentApprovalIntent;
}

export interface BookEnrichmentMetadataCandidate extends BookEnrichmentCandidateBase {
  readonly kind: 'metadata';
  readonly baseValues: BookEnrichmentMetadataValues;
  readonly patch: BookEnrichmentMetadataValues;
}

export interface BookEnrichmentCoverCandidate extends BookEnrichmentCandidateBase {
  readonly kind: 'cover';
  readonly baseCover: PublicBookMetadataSnapshot['cover'];
  readonly cover: Omit<BookCoverAssetInput, 'expectedMetadataRevision'>;
  readonly derivationFingerprint: string;
}

export type BookEnrichmentCandidate = BookEnrichmentMetadataCandidate | BookEnrichmentCoverCandidate;

export interface BookEnrichmentCoverSnapshot {
  readonly present: boolean;
  readonly assetId?: string;
  readonly contentHash?: string;
  readonly provenance?: string;
  readonly fit: 'crop' | 'contain';
  readonly positionX: number;
  readonly positionY: number;
}

export type BookEnrichmentMutationSnapshot =
  | {
      readonly kind: 'metadata';
      readonly values: BookEnrichmentMetadataValues;
    }
  | {
      readonly kind: 'cover';
      readonly cover: BookEnrichmentCoverSnapshot;
    };

export interface BookEnrichmentApprovalIntent {
  readonly schemaVersion: typeof BOOK_ENRICHMENT_APPROVAL_INTENT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly stagedAt: string;
  readonly kind: BookEnrichmentCandidate['kind'];
  readonly baseMetadataRevision: number;
  readonly selectedFields: readonly BookEnrichmentMetadataField[];
  readonly before: BookEnrichmentMutationSnapshot;
  /**
   * Expected selected metadata values, or expected cover hash and layout. A
   * cover asset id is intentionally absent because it is allocated by the host
   * mutation after this intent is committed.
   */
  readonly expected: BookEnrichmentMutationSnapshot;
}

export interface BookEnrichmentApprovalReceipt {
  /** Missing only on receipts written before C3. */
  readonly schemaVersion?: typeof BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION;
  readonly id: string;
  /** Missing only on receipts written before C3 and treated as a non-undoable apply receipt. */
  readonly action?: 'apply' | 'undo';
  readonly approvalReceiptId?: string;
  readonly candidateId: string;
  readonly bookId: string;
  readonly kind: BookEnrichmentCandidate['kind'];
  readonly baseMetadataRevision: number;
  readonly appliedMetadataRevision: number;
  readonly selectedFields: readonly BookEnrichmentMetadataField[];
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly before?: BookEnrichmentMutationSnapshot;
  readonly after?: BookEnrichmentMutationSnapshot;
  readonly provenance: BookEnrichmentProvenance;
  readonly appliedAt: string;
  /** Present on approvals created from the durable approval-intent path. */
  readonly approvalOperationId?: string;
}

export interface BookEnrichmentProviderSummary {
  readonly extensionId: ExtensionContributionId;
  readonly extensionVersion: string;
  readonly descriptor: BookEnrichmentProviderDescriptor;
}
