export type ExternalSourceKind = 'cloud_file' | 'catalog';

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
  readonly cursor?: string;
}

export interface ExternalItemPage {
  readonly items: readonly ExternalItemSummary[];
  readonly nextCursor?: string;
  readonly detail?: ExternalSourceWorkDetail;
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
  readonly importedRemoteRevision?: string;
  readonly importedSourceContentHash?: string;
  readonly activeContentRevisionId?: string;
  readonly linkedAt: string;
  readonly lastCheckedAt?: string;
}

export interface ExternalCatalogCachePage {
  readonly id: string;
  readonly connectorId: string;
  readonly accountConnectionId?: string;
  readonly queryFingerprint: string;
  readonly cursor?: string;
  readonly nextCursor?: string;
  readonly items: readonly ExternalItemSummary[];
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
