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

export type CloudVaultProviderKind = 'directory' | 'dropbox';

export interface CloudVaultSyncScope {
  readonly library: boolean;
  readonly annotations: boolean;
  readonly statistics: boolean;
  readonly aiTtsArtifacts: boolean;
  readonly readerSettings: boolean;
  readonly ttsAudio: false;
}

export const DEFAULT_CLOUD_VAULT_SCOPE: CloudVaultSyncScope = {
  library: true,
  annotations: true,
  statistics: true,
  aiTtsArtifacts: true,
  readerSettings: false,
  ttsAudio: false,
};

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
  readonly favorite: boolean;
  readonly metadataRevision: number;
  readonly updatedAt: string;
}

export interface CloudVaultBookRevisionsV1 {
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
}

export type CloudVaultTombstoneEntity =
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
  readonly shelfId?: string;
  readonly pageIndex?: number;
  readonly deletedAt: string;
}

export interface CloudVaultShelfMembershipV1 {
  readonly id: string;
  readonly shelfId: string;
  readonly bookHash: string;
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
  write(bytes: Uint8Array, expectedRevision?: string): Promise<{ revision: string }>;
}

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
}

export interface CloudVaultArtifactRepository {
  capture(input: {
    readonly deviceId: string;
    readonly scope: CloudVaultSyncScope;
    readonly capturedAt?: string;
  }): Promise<CloudVaultSnapshotV1>;
  apply(snapshot: CloudVaultSnapshotV1): Promise<CloudVaultApplyReport>;
}
