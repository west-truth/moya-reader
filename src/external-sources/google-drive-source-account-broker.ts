import type {
  DownloadedExternalSource,
  ExternalItemPage,
  ExternalItemSummary,
  ExternalSourceBroker,
  ExternalSourceConnectionStatus,
  ExternalSourceCredentialRecord,
  ExternalSourceDownloadRef,
  ExternalSourceListInput,
  ExternalSourcePickResult,
  ExternalSourceSelectionRecord,
} from './contracts';
import { externalItemKeyId } from './contracts';
import { sealExternalSourceCredential, unsealExternalSourceCredential } from './device-credential-crypto';
import type { ExternalSourceLocalState } from './local-state';
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GoogleDriveWebPicker,
  type GoogleDrivePickedDocument,
  type GoogleDrivePickerPort,
  type GoogleDrivePickerToken,
} from './google-drive-picker';

const GOOGLE_DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3';
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const PAGE_SIZE = 100;

const SUPPORTED_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'epub', 'pdf', 'zip', 'cbz', 'rar', 'cbr', '7z', 'cb7']);

const SUPPORTED_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/epub+zip',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.comicbook+zip',
  'application/vnd.comicbook-rar',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
]);

export interface GoogleDriveSourceConfig {
  readonly clientId?: string;
  readonly appId?: string;
  readonly developerKey?: string;
}

interface GoogleDriveCredential {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly accountId: string;
  readonly label: string;
  readonly scope: typeof GOOGLE_DRIVE_FILE_SCOPE;
}

interface GoogleDriveFileMetadata {
  readonly id: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly size?: string;
  readonly modifiedTime?: string;
  readonly md5Checksum?: string;
  readonly version?: string;
  readonly trashed?: boolean;
}

interface GoogleDriveAboutResponse {
  readonly user?: {
    readonly displayName?: string;
    readonly emailAddress?: string;
    readonly permissionId?: string;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function credentialRecordId(connectorId: string): string {
  return `external-credential::${connectorId}`;
}

function fileExtension(fileName: string): string | undefined {
  const match = /\.([^.]+)$/.exec(fileName.trim());
  return match?.[1]?.toLocaleLowerCase();
}

function supportedFile(name: string, mimeType: string | undefined): boolean {
  const extension = fileExtension(name);
  return Boolean(
    (extension && SUPPORTED_EXTENSIONS.has(extension)) || (mimeType && SUPPORTED_MIME_TYPES.has(mimeType)),
  );
}

function finiteByteLength(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function remoteRevision(metadata: GoogleDriveFileMetadata): string | undefined {
  if (metadata.md5Checksum) return `md5:${metadata.md5Checksum}`;
  if (metadata.version || metadata.modifiedTime) {
    return `version:${metadata.version ?? ''}:modified:${metadata.modifiedTime ?? ''}`;
  }
  return undefined;
}

function pageOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}

function isTokenFresh(credential: GoogleDriveCredential | undefined): credential is GoogleDriveCredential {
  return Boolean(credential && Date.parse(credential.expiresAt) > Date.now() + TOKEN_EXPIRY_MARGIN_MS);
}

function webPickerAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  if (!['http:', 'https:'].includes(window.location.protocol)) return false;
  return window.location.hostname !== 'tauri.localhost';
}

export class GoogleDriveSourceAccountBroker implements ExternalSourceBroker {
  private record?: ExternalSourceCredentialRecord;
  private credential?: GoogleDriveCredential;
  private reauthorizationRequired = false;
  private connectionReason?: string;
  private pickerTask?: Promise<ExternalSourcePickResult>;

  constructor(
    private readonly connectorId: string,
    private readonly config: GoogleDriveSourceConfig,
    private readonly state: ExternalSourceLocalState,
    private readonly picker: GoogleDrivePickerPort = new GoogleDriveWebPicker(),
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async initialize(): Promise<void> {
    this.record = await this.state.getCredential(this.connectorId);
    if (!this.record) return;
    if (this.record.protection !== 'device_key_v1') {
      this.reauthorizationRequired = true;
      return;
    }
    try {
      const key = await this.state.getOrCreateCredentialKey();
      const credential = await unsealExternalSourceCredential<GoogleDriveCredential>(
        this.record.credentialEnvelope,
        key,
      );
      this.validateCredential(credential, this.record);
      if (!isTokenFresh(credential)) {
        this.reauthorizationRequired = true;
        return;
      }
      this.credential = credential;
    } catch {
      this.credential = undefined;
      this.reauthorizationRequired = true;
    }
  }

  status(): ExternalSourceConnectionStatus {
    const missing = this.missingConfiguration();
    if (missing) return { state: 'unavailable', reason: missing };
    if (!webPickerAvailable()) {
      return {
        state: 'unavailable',
        reason: 'Google Drive Picker는 현재 일반 HTTP(S) Web 환경에서 지원됩니다.',
      };
    }
    if (!this.record) return { state: 'disconnected', label: 'Google Drive', reason: this.connectionReason };
    return {
      state: isTokenFresh(this.credential) ? 'connected' : 'reauthorization_required',
      accountConnectionId: this.record.accountConnectionId,
      label: this.record.label,
      reason: isTokenFresh(this.credential)
        ? undefined
        : this.reauthorizationRequired
          ? 'Google Drive의 짧은 Web 접근 권한이 만료되었습니다. 다시 연결하면 선택한 파일 목록은 유지됩니다.'
          : 'Google Drive에 다시 연결해 주세요. 선택한 파일 목록은 유지됩니다.',
    };
  }

  async connect(): Promise<void> {
    await this.pickItems();
  }

  async disconnect(): Promise<void> {
    const accountConnectionId = this.record?.accountConnectionId;
    await this.state.deleteCredential(this.connectorId);
    await this.state.clearCache(this.connectorId, accountConnectionId);
    this.record = undefined;
    this.credential = undefined;
    this.reauthorizationRequired = false;
    this.connectionReason = undefined;
  }

  async pickItems(): Promise<ExternalSourcePickResult> {
    if (this.pickerTask) return this.pickerTask;
    this.pickerTask = this.runPicker().finally(() => {
      this.pickerTask = undefined;
    });
    return this.pickerTask;
  }

  async removeSelectedItem(key: ExternalSourceDownloadRef['key']): Promise<void> {
    if (key.connectorId !== this.connectorId) throw new Error('Google Drive 파일 연결 정보가 올바르지 않습니다.');
    await this.state.deleteSelectedItem(externalItemKeyId(key));
    const accountConnectionId = this.record?.accountConnectionId;
    await this.state.clearCache(this.connectorId, accountConnectionId);
  }

  async list(input: ExternalSourceListInput, signal: AbortSignal): Promise<ExternalItemPage> {
    const credential = this.requireCredential(input.accountConnectionId);
    const records = await this.state.listSelectedItems(this.connectorId, credential.accountId);
    const refreshed: ExternalSourceSelectionRecord[] = [];
    for (const stored of records) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const metadata = await this.getFileMetadata(stored.item.key.remoteId, credential, signal);
      if (metadata.trashed) continue;
      const item = this.toItem(metadata, credential.accountId);
      const next = { ...stored, item, updatedAt: nowIso() };
      await this.state.saveSelectedItem(next);
      refreshed.push(next);
    }
    const query = input.query?.trim().toLocaleLowerCase();
    const filtered = query ? refreshed.filter(({ item }) => item.title.toLocaleLowerCase().includes(query)) : refreshed;
    const offset = pageOffset(input.cursor);
    const items = filtered.slice(offset, offset + PAGE_SIZE).map(({ item }) => item);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < filtered.length ? `offset:${nextOffset}` : undefined,
    };
  }

  async download(ref: ExternalSourceDownloadRef, signal: AbortSignal): Promise<DownloadedExternalSource> {
    const credential = this.requireCredential(ref.key.accountConnectionId);
    const metadata = await this.getFileMetadata(ref.key.remoteId, credential, signal);
    if (!supportedFile(metadata.name, metadata.mimeType)) {
      throw new Error('이 Google Drive 파일 형식은 아직 가져올 수 없습니다.');
    }
    const response = await this.authorizedFetch(
      `${GOOGLE_DRIVE_API_BASE_URL}/files/${encodeURIComponent(ref.key.remoteId)}?alt=media&supportsAllDrives=true`,
      credential,
      signal,
    );
    const blob = await response.blob();
    return {
      file: new File([blob], metadata.name || ref.fileName, {
        type: metadata.mimeType ?? blob.type ?? ref.mimeType ?? 'application/octet-stream',
        lastModified: metadata.modifiedTime ? Date.parse(metadata.modifiedTime) : Date.now(),
      }),
      remoteRevision: remoteRevision(metadata),
    };
  }

  private async runPicker(): Promise<ExternalSourcePickResult> {
    const config = this.requireConfiguration();
    const existingCredential = isTokenFresh(this.credential) ? this.credential : undefined;
    const documents = await this.picker.open({
      ...config,
      accessToken: existingCredential?.accessToken,
      onToken: (token) => this.persistToken(token),
    });
    const credential = this.requireCredential();
    const existing = new Map(
      (await this.state.listSelectedItems(this.connectorId, credential.accountId)).map((record) => [
        record.item.key.remoteId,
        record,
      ]),
    );
    let addedCount = 0;
    for (const document of documents) {
      const metadata = await this.getFileMetadata(document.id, credential, new AbortController().signal);
      const item = this.toItem(metadata, credential.accountId, document);
      const previous = existing.get(document.id);
      const timestamp = nowIso();
      await this.state.saveSelectedItem({
        id: externalItemKeyId(item.key),
        connectorId: this.connectorId,
        accountConnectionId: credential.accountId,
        item,
        selectedAt: previous?.selectedAt ?? timestamp,
        updatedAt: timestamp,
        schemaVersion: 1,
      });
      if (!previous) addedCount += 1;
    }
    await this.state.clearCache(this.connectorId, credential.accountId);
    return { selectedCount: documents.length, addedCount };
  }

  private async persistToken(token: GoogleDrivePickerToken): Promise<void> {
    const about = await this.googleJson<GoogleDriveAboutResponse>(
      `${GOOGLE_DRIVE_API_BASE_URL}/about?fields=user(displayName,emailAddress,permissionId)`,
      token.accessToken,
    );
    const accountIdentity = about.user?.permissionId?.trim() || about.user?.emailAddress?.trim();
    if (!accountIdentity) throw new Error('Google Drive 계정 식별자를 확인하지 못했습니다.');
    const accountId = `google-drive:${accountIdentity}`;
    const label = about.user?.emailAddress?.trim() || about.user?.displayName?.trim() || 'Google Drive';
    const credential: GoogleDriveCredential = {
      accessToken: token.accessToken,
      expiresAt: new Date(Date.now() + token.expiresInSeconds * 1_000).toISOString(),
      accountId,
      label,
      scope: GOOGLE_DRIVE_FILE_SCOPE,
    };
    const key = await this.state.getOrCreateCredentialKey();
    const timestamp = nowIso();
    const record: ExternalSourceCredentialRecord = {
      id: credentialRecordId(this.connectorId),
      connectorId: this.connectorId,
      accountConnectionId: accountId,
      label,
      credentialEnvelope: await sealExternalSourceCredential(credential, key),
      protection: 'device_key_v1',
      createdAt: this.record?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.state.saveCredential(record);
    this.record = record;
    this.credential = credential;
    this.reauthorizationRequired = false;
    this.connectionReason = undefined;
  }

  private async getFileMetadata(
    fileId: string,
    credential: GoogleDriveCredential,
    signal: AbortSignal,
  ): Promise<GoogleDriveFileMetadata> {
    const fields = 'id,name,mimeType,size,modifiedTime,md5Checksum,version,trashed';
    const response = await this.authorizedFetch(
      `${GOOGLE_DRIVE_API_BASE_URL}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`,
      credential,
      signal,
    );
    return (await response.json()) as GoogleDriveFileMetadata;
  }

  private toItem(
    metadata: GoogleDriveFileMetadata,
    accountConnectionId: string,
    picked?: GoogleDrivePickedDocument,
  ): ExternalItemSummary {
    const extension = fileExtension(metadata.name);
    const mimeType = metadata.mimeType ?? picked?.mimeType;
    return {
      key: {
        connectorId: this.connectorId,
        accountConnectionId,
        remoteId: metadata.id,
      },
      kind: 'file',
      title: metadata.name || picked?.name || 'Google Drive 파일',
      mimeType,
      formatHint: extension?.toLocaleUpperCase(),
      byteLength: finiteByteLength(metadata.size) ?? picked?.sizeBytes,
      remoteRevision: remoteRevision(metadata),
      updatedAt: metadata.modifiedTime,
      importability: supportedFile(metadata.name, mimeType) ? 'supported' : 'unsupported',
    };
  }

  private async authorizedFetch(
    url: string,
    credential: GoogleDriveCredential,
    signal: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${credential.accessToken}` },
      signal,
    });
    if (response.ok) return response;
    if (response.status === 401) {
      this.credential = undefined;
      this.reauthorizationRequired = true;
      throw new Error('Google Drive 접근 권한이 만료되었습니다. 설정에서 다시 연결해 주세요.');
    }
    if (response.status === 403) {
      throw new Error('Google Drive API 또는 선택한 파일의 접근 권한을 확인해 주세요.');
    }
    if (response.status === 404) throw new Error('선택한 Google Drive 파일을 찾지 못했습니다.');
    throw new Error(`Google Drive 요청에 실패했습니다. (${response.status})`);
  }

  private async googleJson<T>(url: string, accessToken: string): Promise<T> {
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Google Cloud 프로젝트에서 Drive API와 Picker API 설정을 확인해 주세요.');
      }
      throw new Error(`Google Drive 계정 정보를 확인하지 못했습니다. (${response.status})`);
    }
    return (await response.json()) as T;
  }

  private requireCredential(expectedAccountId?: string): GoogleDriveCredential {
    if (!isTokenFresh(this.credential)) {
      this.credential = undefined;
      this.reauthorizationRequired = Boolean(this.record);
      throw new Error('Google Drive에 다시 연결해 주세요.');
    }
    if (expectedAccountId && expectedAccountId !== this.credential.accountId) {
      throw new Error('현재 Google Drive 계정과 선택 파일의 계정이 다릅니다.');
    }
    return this.credential;
  }

  private requireConfiguration(): Required<GoogleDriveSourceConfig> {
    const missing = this.missingConfiguration();
    if (missing) throw new Error(missing);
    return {
      clientId: this.config.clientId!.trim(),
      appId: this.config.appId!.trim(),
      developerKey: this.config.developerKey!.trim(),
    };
  }

  private missingConfiguration(): string | undefined {
    const missing = [
      !this.config.clientId?.trim() ? 'OAuth Client ID' : undefined,
      !this.config.appId?.trim() ? 'App ID' : undefined,
      !this.config.developerKey?.trim() ? 'API Key' : undefined,
    ].filter((value): value is string => Boolean(value));
    return missing.length > 0 ? `이 빌드에는 Google Drive ${missing.join(', ')}가 설정되지 않았습니다.` : undefined;
  }

  private validateCredential(credential: GoogleDriveCredential, record: ExternalSourceCredentialRecord): void {
    if (!credential.accessToken?.trim() || credential.scope !== GOOGLE_DRIVE_FILE_SCOPE) {
      throw new Error('invalid credential');
    }
    if (credential.accountId !== record.accountConnectionId) throw new Error('credential account mismatch');
  }
}
