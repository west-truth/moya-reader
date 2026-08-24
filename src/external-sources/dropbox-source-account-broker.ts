import {
  beginDropboxAuthorizationRedirect,
  completeDropboxAuthorizationRedirect,
  defaultDropboxRedirectUri,
} from '../cloud-vault/dropbox-oauth';
import type { DropboxCredential, DropboxCredentialStore } from '../cloud-vault/dropbox-provider';
import type {
  DownloadedExternalSource,
  ExternalItemPage,
  ExternalSourceBroker,
  ExternalSourceConnectionStatus,
  ExternalSourceCredentialRecord,
  ExternalSourceDownloadRef,
  ExternalSourceListInput,
} from './contracts';
import { sealExternalSourceCredential, unsealExternalSourceCredential } from './device-credential-crypto';
import type { ExternalSourceLocalState } from './local-state';
import { DropboxCloudFileBroker, DROPBOX_EXTERNAL_SOURCE_SCOPES } from './dropbox-cloud-file-broker';

function nowIso(): string {
  return new Date().toISOString();
}

function credentialRecordId(connectorId: string): string {
  return `external-credential::${connectorId}`;
}

/** Owns the separate read-only Dropbox source grant and its device-local encrypted credential. */
export class DropboxSourceAccountBroker implements ExternalSourceBroker {
  private record?: ExternalSourceCredentialRecord;
  private credential?: DropboxCredential;
  private credentialKey?: CryptoKey;
  private reauthorizationRequired = false;
  private connectionReason?: string;
  private api?: DropboxCloudFileBroker;

  constructor(
    private readonly connectorId: string,
    private readonly appKey: string | undefined,
    private readonly state: ExternalSourceLocalState,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async initialize(): Promise<void> {
    if (this.appKey) {
      try {
        const redirectedCredential = await completeDropboxAuthorizationRedirect({
          appKey: this.appKey,
          fetchImpl: this.fetchImpl,
        });
        if (redirectedCredential) {
          await this.persistCredential(redirectedCredential);
          return;
        }
      } catch (error) {
        this.connectionReason = error instanceof Error ? error.message : 'Dropbox 연결을 완료하지 못했습니다.';
      }
    }
    this.record = await this.state.getCredential(this.connectorId);
    if (!this.record) return;
    if (this.record.protection !== 'device_key_v1') {
      this.reauthorizationRequired = true;
      return;
    }
    try {
      const key = await this.state.getOrCreateCredentialKey();
      const credential = await unsealExternalSourceCredential<DropboxCredential>(this.record.credentialEnvelope, key);
      this.validateCredential(credential, this.record);
      this.installCredential(credential, key);
    } catch {
      this.credential = undefined;
      this.credentialKey = undefined;
      this.api = undefined;
      this.reauthorizationRequired = true;
    }
  }

  status(): ExternalSourceConnectionStatus {
    if (!this.appKey) {
      return {
        state: 'unavailable',
        reason: '이 빌드에는 Dropbox 외부 소스 앱 키가 설정되지 않았습니다.',
      };
    }
    if (!defaultDropboxRedirectUri()) {
      return {
        state: 'unavailable',
        reason: 'Dropbox 외부 소스 연결은 현재 HTTP(S) Web 환경에서 지원됩니다.',
      };
    }
    if (!this.record) return { state: 'disconnected', label: 'Dropbox', reason: this.connectionReason };
    return {
      state: this.credential && this.api ? 'connected' : 'reauthorization_required',
      accountConnectionId: this.record.accountConnectionId,
      label: this.record.label,
      reason: this.credential
        ? undefined
        : this.reauthorizationRequired
          ? '이 기기의 저장 키로 연결 정보를 복구할 수 없습니다. Dropbox에 다시 연결해 주세요.'
          : 'Dropbox에 다시 연결해 주세요.',
    };
  }

  async connect(): Promise<void> {
    const appKey = this.requireAppKey();
    this.connectionReason = undefined;
    await beginDropboxAuthorizationRedirect({
      appKey,
      scopes: DROPBOX_EXTERNAL_SOURCE_SCOPES,
    });
    await new Promise<never>(() => undefined);
  }

  private async persistCredential(credential: DropboxCredential): Promise<void> {
    const timestamp = nowIso();
    const accountConnectionId = credential.accountId ?? `dropbox-${crypto.randomUUID()}`;
    const key = await this.state.getOrCreateCredentialKey();
    const record: ExternalSourceCredentialRecord = {
      id: credentialRecordId(this.connectorId),
      connectorId: this.connectorId,
      accountConnectionId,
      label: 'Dropbox',
      credentialEnvelope: await sealExternalSourceCredential(credential, key),
      protection: 'device_key_v1',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.state.saveCredential(record);
    this.record = record;
    this.reauthorizationRequired = false;
    this.connectionReason = undefined;
    this.installCredential(credential, key);
  }

  async disconnect(): Promise<void> {
    const accountConnectionId = this.record?.accountConnectionId;
    await this.state.deleteCredential(this.connectorId);
    await this.state.clearCache(this.connectorId, accountConnectionId);
    this.record = undefined;
    this.credential = undefined;
    this.credentialKey = undefined;
    this.reauthorizationRequired = false;
    this.connectionReason = undefined;
    this.api = undefined;
  }

  async list(input: ExternalSourceListInput, signal: AbortSignal): Promise<ExternalItemPage> {
    return this.requireApi().list(input, signal);
  }

  async download(ref: ExternalSourceDownloadRef, signal: AbortSignal): Promise<DownloadedExternalSource> {
    return this.requireApi().download(ref, signal);
  }

  private installCredential(credential: DropboxCredential, key: CryptoKey): void {
    this.credential = credential;
    this.credentialKey = key;
    const credentialStore: DropboxCredentialStore = {
      get: async () => this.credential,
      save: async (next) => {
        const currentRecord = this.record;
        const currentKey = this.credentialKey;
        if (!currentRecord || !currentKey) throw new Error('Dropbox 외부 소스에 다시 연결해야 합니다.');
        const updated: ExternalSourceCredentialRecord = {
          ...currentRecord,
          credentialEnvelope: await sealExternalSourceCredential(next, currentKey),
          protection: 'device_key_v1',
          updatedAt: nowIso(),
        };
        await this.state.saveCredential(updated);
        this.record = updated;
        this.credential = next;
      },
    };
    this.api = new DropboxCloudFileBroker(this.connectorId, this.requireAppKey(), credentialStore, this.fetchImpl);
  }

  private requireApi(): DropboxCloudFileBroker {
    if (!this.api || !this.credential) throw new Error('Dropbox 외부 소스에 먼저 연결해 주세요.');
    return this.api;
  }

  private requireAppKey(): string {
    if (!this.appKey) throw new Error('이 빌드에는 Dropbox 외부 소스 앱 키가 설정되지 않았습니다.');
    return this.appKey;
  }

  private validateCredential(credential: DropboxCredential, record: ExternalSourceCredentialRecord): void {
    if (!credential.accessToken?.trim()) throw new Error('invalid credential');
    if (credential.accountId && credential.accountId !== record.accountConnectionId) {
      throw new Error('credential account mismatch');
    }
  }
}
