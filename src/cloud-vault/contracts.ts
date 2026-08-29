import type {
  Bookmark,
  Character,
  DocumentAnnotation,
  DocumentTextOrderOverride,
  LabeledSegment,
  ListeningPosition,
  ReaderHighlight,
  ReaderNote,
  ReaderSettings,
  ReadingPosition,
  ReadingSessionEvent,
  Shelf,
  UserCorrection,
  VoiceProfile,
} from '../domain/types';
import type { CharacterRelation } from '../providers/ai';

export const CLOUD_VAULT_FORMAT = 'noveldesk-cloud-vault' as const;
export const CLOUD_VAULT_VERSION = 1 as const;
export const CLOUD_VAULT_FILE_NAME = 'noveldesk-vault-v1.enc.json';
export const CLOUD_VAULT_AI_TTS_FORMAT = 'noveldesk-cloud-vault-ai-tts' as const;
export const CLOUD_VAULT_AI_TTS_VERSION = 1 as const;

export type CloudVaultProviderKind = 'directory' | 'dropbox';

export interface CloudVaultSyncScope {
  readonly library: boolean;
  readonly annotations: boolean;
  readonly statistics: boolean;
  readonly aiTtsArtifacts: boolean;
  readonly readerSettings: boolean;
  /**
   * Opt-in transfer of original book files and active covers. These objects live
   * in the user's private storage without additional Moya encryption; the
   * metadata manifest remains encrypted by the Vault passphrase.
   */
  readonly sourceFiles: boolean;
  readonly ttsAudio: false;
}

export const DEFAULT_CLOUD_VAULT_SCOPE: CloudVaultSyncScope = {
  library: true,
  annotations: true,
  statistics: true,
  aiTtsArtifacts: true,
  readerSettings: false,
  sourceFiles: false,
  ttsAudio: false,
};

export type CloudVaultContentKind = 'source' | 'cover';

export interface CloudVaultContentObjectV1 {
  readonly kind: CloudVaultContentKind;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly fileName: string;
  readonly encoding?: import('../domain/types').EncodingMode;
  readonly provenance?: import('../domain/types').BookAssetProvenance;
  readonly pixelWidth?: number;
  readonly pixelHeight?: number;
  readonly fit?: 'crop' | 'contain';
  readonly positionX?: number;
  readonly positionY?: number;
}

export interface CloudVaultAiTtsObjectV1 {
  readonly kind: 'ai-tts';
  readonly objectKey: string;
  readonly artifactHash: string;
  readonly byteLength: number;
  readonly revisionAt: string;
}

export interface CloudVaultAiTtsPayloadV1 {
  readonly format: typeof CLOUD_VAULT_AI_TTS_FORMAT;
  readonly version: typeof CLOUD_VAULT_AI_TTS_VERSION;
  readonly bookHash: string;
  readonly revisionAt: string;
  readonly chapters: readonly CloudVaultChapterRefV1[];
  readonly paragraphs: readonly CloudVaultParagraphRefV1[];
  readonly characters: readonly Character[];
  readonly characterRelations: readonly CharacterRelation[];
  readonly segments: readonly LabeledSegment[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly corrections: readonly UserCorrection[];
}

export interface CloudVaultChapterRefV1 {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly textHash: string;
}

export interface CloudVaultParagraphRefV1 {
  readonly id: string;
  readonly chapterId: string;
  readonly chapterIndex: number;
  readonly paragraphIndex: number;
  readonly textHash: string;
}

export interface CloudVaultBookIdentityV1 {
  readonly bookId: string;
  /**
   * Additive stable identity for v1 manifests. Older manifests omit this and
   * are promoted by matching normalizedTextHash once.
   */
  readonly vaultBookId?: string;
  readonly normalizedTextHash: string;
  readonly activeContentRevisionId?: string;
  readonly format: string;
  readonly title: string;
  readonly author?: string;
  readonly seriesTitle?: string;
  readonly seriesIndex?: number;
  readonly tags?: readonly string[];
  readonly description?: string;
  readonly language?: string;
  readonly coverUpdatedAt?: string;
  readonly favorite: boolean;
  readonly metadataRevision: number;
  readonly updatedAt: string;
}

export interface CloudVaultBookRevisionsV1 {
  /**
   * Clock for body/source ownership, independent from title and other library
   * metadata. Older v1 manifests omit it and fall back to metadataAt.
   */
  readonly contentAt?: string;
  /** Deterministic tie-break owner for equal content clocks. */
  readonly contentDeviceId?: string;
  readonly metadataAt: string;
  readonly readerAt: string;
  readonly annotationsAt: string;
  readonly statisticsAt: string;
  readonly aiTtsAt: string;
}

export interface CloudVaultBookV1 {
  readonly identity: CloudVaultBookIdentityV1;
  readonly revisions: CloudVaultBookRevisionsV1;
  readonly chapters: readonly CloudVaultChapterRefV1[];
  readonly paragraphs: readonly CloudVaultParagraphRefV1[];
  readonly readingPosition?: ReadingPosition;
  readonly listeningPosition?: ListeningPosition;
  readonly bookmarks: readonly Bookmark[];
  readonly highlights: readonly ReaderHighlight[];
  readonly notes: readonly ReaderNote[];
  /** Added to the v1 envelope additively; absent in older encrypted snapshots. */
  readonly documentAnnotations?: readonly DocumentAnnotation[];
  /** Added to the v1 envelope additively; absent in older encrypted snapshots. */
  readonly documentTextOrderOverrides?: readonly DocumentTextOrderOverride[];
  readonly readingSessions: readonly ReadingSessionEvent[];
  readonly characters: readonly Character[];
  readonly characterRelations: readonly CharacterRelation[];
  readonly segments: readonly LabeledSegment[];
  readonly voiceProfiles: readonly VoiceProfile[];
  readonly corrections: readonly UserCorrection[];
  /** Added to v1 snapshots additively. Older clients safely ignore it. */
  readonly sourceObject?: CloudVaultContentObjectV1;
  /** Added to v1 snapshots additively. Older clients safely ignore it. */
  readonly coverObject?: CloudVaultContentObjectV1;
  /** Latest per-book encrypted AI/TTS artifact sidecar. */
  readonly aiTtsObject?: CloudVaultAiTtsObjectV1;
}

export type CloudVaultTombstoneEntity =
  | 'book'
  | 'cover'
  | 'bookmark'
  | 'highlight'
  | 'note'
  | 'document_annotation'
  | 'document_text_order_override'
  | 'reading_position'
  | 'listening_position'
  | 'user_correction'
  | 'shelf'
  | 'shelf_membership';

export interface CloudVaultTombstoneV1 {
  readonly id: string;
  readonly entityType: CloudVaultTombstoneEntity;
  readonly entityId: string;
  readonly bookHash?: string;
  readonly vaultBookId?: string;
  readonly shelfId?: string;
  readonly pageIndex?: number;
  readonly deletedAt: string;
}

export interface CloudVaultShelfMembershipV1 {
  readonly id: string;
  readonly shelfId: string;
  readonly bookHash: string;
  readonly vaultBookId?: string;
  readonly createdAt: string;
}

export interface CloudVaultSnapshotV1 {
  readonly format: typeof CLOUD_VAULT_FORMAT;
  readonly version: typeof CLOUD_VAULT_VERSION;
  readonly generatedAt: string;
  readonly deviceId: string;
  readonly scope: CloudVaultSyncScope;
  readonly books: readonly CloudVaultBookV1[];
  readonly shelves: readonly Shelf[];
  readonly shelfMemberships: readonly CloudVaultShelfMembershipV1[];
  readonly tombstones: readonly CloudVaultTombstoneV1[];
  readonly settings?: ReaderSettings;
  readonly settingsUpdatedAt?: string;
}

export interface CloudVaultEncryptedEnvelopeV1 {
  readonly format: typeof CLOUD_VAULT_FORMAT;
  readonly version: typeof CLOUD_VAULT_VERSION;
  readonly kdf: {
    readonly name: 'PBKDF2';
    readonly hash: 'SHA-256';
    readonly iterations: number;
    readonly salt: string;
  };
  readonly cipher: {
    readonly name: 'AES-GCM';
    readonly iv: string;
  };
  readonly payloadKind?: 'vault' | 'ai-tts';
  readonly ciphertext: string;
}

export interface CloudVaultStoredObject {
  readonly bytes: Uint8Array;
  readonly revision: string;
}

export interface CloudVaultFileProvider {
  readonly kind: CloudVaultProviderKind;
  readonly label: string;
  read(): Promise<CloudVaultStoredObject | undefined>;
  /** Cheap remote metadata probe when the backing provider supports one. */
  getRevision?(): Promise<string | undefined>;
  write(bytes: Uint8Array, expectedRevision?: string): Promise<{ revision: string }>;
}

export interface CloudVaultStoredContentObject {
  readonly blob: Blob;
  readonly revision?: string;
}

/**
 * Immutable, content-addressed sidecar storage. Object listing and deletion are
 * intentionally excluded until a user-visible remote cleanup policy exists.
 */
export interface CloudVaultObjectStore {
  getObject(objectKey: string): Promise<CloudVaultStoredContentObject | undefined>;
  putObject(
    objectKey: string,
    blob: Blob,
    expected: { readonly byteLength: number },
  ): Promise<{ readonly created: boolean; readonly revision?: string }>;
}

export type CloudVaultContentProvider = CloudVaultFileProvider & CloudVaultObjectStore;

export class CloudVaultWriteConflictError extends Error {
  constructor(message = 'Cloud vault changed on another device.') {
    super(message);
    this.name = 'CloudVaultWriteConflictError';
  }
}

export interface CloudVaultApplyReport {
  readonly matchedBooks: number;
  readonly waitingForSourceBooks: number;
  readonly appliedRecords: number;
  readonly quarantinedRecords: number;
  readonly waitingBookTitles: readonly string[];
}

export interface CloudVaultSyncReport extends CloudVaultApplyReport {
  readonly provider: CloudVaultProviderKind;
  readonly uploadedBytes: number;
  readonly remoteRevision: string;
  readonly syncedAt: string;
  readonly uploadedSourceFiles: number;
  readonly restoredSourceFiles: number;
  readonly uploadedContentBytes: number;
  readonly downloadedContentBytes: number;
  readonly contentFailures: readonly string[];
  readonly uploadedAiTtsFiles: number;
  readonly restoredAiTtsFiles: number;
  readonly uploadedAiTtsBytes: number;
  readonly downloadedAiTtsBytes: number;
  readonly aiTtsObjectKeys: Readonly<Record<string, string>>;
}

export interface CloudVaultArtifactRepository {
  capture(input: {
    readonly deviceId: string;
    readonly scope: CloudVaultSyncScope;
    readonly capturedAt?: string;
  }): Promise<CloudVaultSnapshotV1>;
  apply(snapshot: CloudVaultSnapshotV1): Promise<CloudVaultApplyReport>;
}
