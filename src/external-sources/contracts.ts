export type ExternalSourceKind = 'cloud_file' | 'catalog';
export type ExternalSourceBrowseMode = 'popular' | 'latest' | 'search';

export type ExternalSourceFilterValue =
  boolean | number | string | { readonly index: number; readonly ascending: boolean };

export interface ExternalSourceFilterChange {
  readonly position: number;
  readonly groupPosition?: number;
  readonly value: ExternalSourceFilterValue;
}

export type ExternalSourceFilterDefinition =
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'header';
      readonly label: string;
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'separator';
      readonly label?: string;
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'checkbox';
      readonly label: string;
      readonly defaultValue: boolean;
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'select';
      readonly label: string;
      readonly options: readonly string[];
      readonly defaultValue: number;
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'sort';
      readonly label: string;
      readonly options: readonly string[];
      readonly defaultValue: { readonly index: number; readonly ascending: boolean };
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'text';
      readonly label: string;
      readonly defaultValue: string;
    }
  | {
      readonly id: string;
      readonly position: number;
      readonly groupPosition?: number;
      readonly kind: 'tri_state';
      readonly label: string;
      readonly defaultValue: 'IGNORE' | 'INCLUDE' | 'EXCLUDE';
    };

export interface ExternalSourceBrowseState {
  readonly activeMode: ExternalSourceBrowseMode;
  readonly availableModes: readonly ExternalSourceBrowseMode[];
  readonly filters?: readonly ExternalSourceFilterDefinition[];
}

export interface ExternalSourceCollectionDescriptor {
  readonly remoteId: string;
  readonly title: string;
  readonly author?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly status?: string;
  readonly sourceLabel?: string;
}

export interface ExternalSourceReleaseDescriptor {
  readonly title: string;
  readonly chapterNumber?: number;
  readonly sourceOrder?: number;
}

export interface ExternalItemKey {
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly remoteId: string;
}

export interface ExternalItemSummary {
  readonly key: ExternalItemKey;
  readonly kind: 'file' | 'folder' | 'work';
  readonly title: string;
  /** Import-safe file name when the display title is not itself a file name. */
  readonly importFileName?: string;
  readonly subtitle?: string;
  readonly author?: string;
  readonly mimeType?: string;
  readonly formatHint?: string;
  readonly byteLength?: number;
  readonly remoteRevision?: string;
  readonly updatedAt?: string;
  /** Display-only remote cover/icon URL. Import still requires an explicit download action. */
  readonly thumbnailUrl?: string;
  /** Optional work/release identity used to aggregate serial catalog downloads into one local work. */
  readonly collection?: ExternalSourceCollectionDescriptor;
  readonly release?: ExternalSourceReleaseDescriptor;
  /** Opaque provider reference used only to enter a folder. */
  readonly navigationRef?: string;
  readonly importability: 'unknown' | 'supported' | 'unsupported';
}

export interface ExternalSourceWorkDetail {
  readonly title: string;
  readonly subtitle?: string;
  readonly author?: string;
  readonly artist?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly status?: string;
  readonly thumbnailUrl?: string;
  readonly sourceLabel?: string;
}

export interface ExternalSourceListInput {
  readonly accountConnectionId?: string;
  readonly parentRef?: string;
  readonly query?: string;
  readonly browseMode?: ExternalSourceBrowseMode;
  readonly filters?: readonly ExternalSourceFilterChange[];
  readonly cursor?: string;
}

export interface ExternalItemPage {
  readonly items: readonly ExternalItemSummary[];
  readonly nextCursor?: string;
  readonly detail?: ExternalSourceWorkDetail;
  readonly browse?: ExternalSourceBrowseState;
}

export interface ExternalSourceDownloadRef {
  readonly key: ExternalItemKey;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly byteLength?: number;
  readonly remoteRevision?: string;
}

export interface DownloadedExternalSource {
  readonly file: File;
  readonly remoteRevision?: string;
}

export type ExternalSourceConnectionState = 'disconnected' | 'reauthorization_required' | 'connected' | 'unavailable';

export interface ExternalSourceConnectionStatus {
  readonly state: ExternalSourceConnectionState;
  readonly accountConnectionId?: string;
  readonly label?: string;
  readonly reason?: string;
}

export interface ExternalSourceConnectionOption {
  readonly value: string;
  readonly label: string;
}

export interface ExternalSourceConnectionField {
  readonly id: string;
  readonly label: string;
  readonly type: 'text' | 'password' | 'select';
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly defaultValue?: string;
  readonly options?: readonly ExternalSourceConnectionOption[];
  readonly help?: string;
}

export interface ExternalSourceConnectionForm {
  readonly fields: readonly ExternalSourceConnectionField[];
  readonly submitLabel?: string;
  readonly help?: string;
}

export type ExternalSourceConnectionInput = Readonly<Record<string, string>>;

export interface ExternalSourcePickResult {
  readonly selectedCount: number;
  readonly addedCount: number;
}

export interface ExternalSourceSelectionRecord {
  readonly id: string;
  readonly connectorId: string;
  readonly accountConnectionId: string;
  readonly item: ExternalItemSummary;
  readonly selectedAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: 1;
}

/** Host-owned port. Tokens and provider response bodies never cross this boundary. */
export interface ExternalSourceBroker {
  status(): ExternalSourceConnectionStatus;
  connectionForm?(): ExternalSourceConnectionForm;
  connect(input?: ExternalSourceConnectionInput): Promise<void>;
  disconnect(): Promise<void>;
  list(input: ExternalSourceListInput, signal: AbortSignal): Promise<ExternalItemPage>;
  download(ref: ExternalSourceDownloadRef, signal: AbortSignal): Promise<DownloadedExternalSource>;
  pickItems?(): Promise<ExternalSourcePickResult>;
  removeSelectedItem?(key: ExternalItemKey): Promise<void>;
}

export interface TrustedExternalSourceHostContext {
  readonly brokers: {
    get(brokerId: string): ExternalSourceBroker | undefined;
  };
}

export interface ExternalSourceLink {
  readonly id: string;
  readonly source: ExternalItemKey;
  readonly localBookId: string;
  readonly collectionRemoteId?: string;
  readonly importedRemoteRevision?: string;
  readonly importedSourceContentHash?: string;
  readonly activeContentRevisionId?: string;
  readonly linkedAt: string;
  readonly lastCheckedAt?: string;
  /**
   * Durable intent written before a canonical import starts. If the app stops
   * after content activation but before link finalization, the next projection
   * can finish the link without downloading or importing the source again.
   */
  readonly pendingImport?: {
    readonly operationId: string;
    readonly stagedAt: string;
    readonly hadExistingLink: boolean;
    readonly previousActiveContentRevisionId?: string;
    /** Exact content incarnation returned by the completed canonical import. */
    readonly activatedContentRevisionId?: string;
    /** Exact source hash expected after activation, or the uploaded delta hash when resolved by the importer. */
    readonly expectedActiveSourceContentHash: string;
    /**
     * The uploaded source is an image-series delta whose final aggregate hash is
     * resolved by the active importer after merging it with the current book.
     */
    readonly sourceHashResolvedByImporter?: boolean;
    readonly collectionRemoteId?: string;
    readonly importedRemoteRevision?: string;
    readonly importedSourceContentHash?: string;
  };
}

export interface ExternalCatalogCachePage {
  readonly id: string;
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly queryFingerprint: string;
  readonly cursor?: string;
  readonly nextCursor?: string;
  readonly items: readonly ExternalItemSummary[];
  readonly browse?: ExternalSourceBrowseState;
  readonly fetchedAt: string;
  readonly expiresAt: string;
  readonly schemaVersion: 1;
}

export interface ExternalSourceCredentialRecord {
  readonly id: string;
  readonly connectorId: string;
  readonly accountConnectionId: string;
  readonly label: string;
  readonly credentialEnvelope: string;
  /** Missing on the legacy user-passphrase format, which must be reauthorized. */
  readonly protection?: 'device_key_v1';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function externalItemKeyId(key: ExternalItemKey): string {
  return [key.connectorId, key.accountConnectionId ?? '', key.remoteId].join('::');
}

export function externalSourceLinkId(key: ExternalItemKey): string {
  return `external-link::${externalItemKeyId(key)}`;
}
