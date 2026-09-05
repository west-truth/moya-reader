import { isExternalSeriesProfile } from '@noveldesk/extension-contracts';
import type {
  DownloadedExternalSourceV2,
  ExternalItemPage,
  ExternalItemKey,
  ExternalItemSummary,
  ExternalSourceBroker,
  ExternalSourceConnectionForm,
  ExternalSourceConnectionInput,
  ExternalSourceConnectionStatus,
  ExternalSourceCredentialRecord,
  ExternalSourceDownloadRef,
  ExternalSourceListInput,
  ExternalSourceWorkDetail,
} from '../contracts';
import type { ExternalSourceLocalState } from '../local-state';
import type { ExternalSourceSharedConnectionV1 } from '../../integration-settings/self-host-integration-settings';
import { sealExternalSourceCredential, unsealExternalSourceCredential } from '../device-credential-crypto';
import {
  normalizeTextServerEndpoint,
  textServerNamespace,
  TextServerClient,
  type ManagedTextSourceFetch,
} from './text-server-client';
import { TEXT_SERVER_PROFILE } from './text-server-external-source';

const MANAGED_ENDPOINT = '/api/integrations/text-sources';
type RecordValue = Record<string, unknown>;
interface ServerIdentity {
  readonly instanceId: string;
  readonly dataNamespace: string;
  readonly accountId?: string;
  readonly label: string;
}
interface Credential {
  readonly version: 1;
  readonly endpoint: string;
  readonly token?: string;
  readonly identity: ServerIdentity;
}

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('텍스트 서버 응답 구조가 올바르지 않습니다.');
  return value as RecordValue;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('텍스트 서버 식별자 또는 제목이 올바르지 않습니다.');
  return value;
}
function optionalText(value: unknown, max = 256): string | undefined {
  return value === undefined ? undefined : text(value, max);
}
function id(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(result)) throw new Error('텍스트 서버 항목 식별자가 올바르지 않습니다.');
  return result;
}
function navigation(parts: readonly string[]): string {
  return `text:${JSON.stringify(parts)}`;
}
function parseNavigation(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(5));
  } catch {
    throw new Error('텍스트 소스 위치가 올바르지 않습니다.');
  }
  if (!value.startsWith('text:') || !Array.isArray(parsed) || parsed.length < 1 || parsed.length > 3)
    throw new Error('텍스트 소스 위치가 올바르지 않습니다.');
  return parsed.map(id);
}
function page(value: unknown, requestedCursor?: string): { items: RecordValue[]; nextCursor?: string } {
  const result = record(value);
  if (!Array.isArray(result.items) || result.items.length > 1_000)
    throw new Error('텍스트 서버 목록 크기가 올바르지 않습니다.');
  const nextCursor = optionalText(result.nextCursor, 512);
  if (nextCursor && nextCursor === requestedCursor) throw new Error('텍스트 서버 목록이 같은 페이지를 반복합니다.');
  const items = result.items.map(record);
  if (new Set(items.map((item) => id(item.id))).size !== items.length)
    throw new Error('텍스트 서버 목록에 중복 식별자가 있습니다.');
  return { items, nextCursor };
}
function query(path: string, input: ExternalSourceListInput, search = false): string {
  const parameters = new URLSearchParams();
  if (search && input.query?.trim()) parameters.set('query', text(input.query.trim(), 200));
  if (input.cursor) parameters.set('cursor', text(input.cursor, 512));
  return parameters.size ? `${path}?${parameters}` : path;
}
function detail(value: unknown): ExternalSourceWorkDetail & { id: string } {
  const work = record(value);
  const tags = work.tags === undefined ? undefined : work.tags;
  if (
    tags !== undefined &&
    (!Array.isArray(tags) || tags.length > 64 || !tags.every((tag) => typeof tag === 'string' && tag.length <= 128))
  )
    throw new Error('텍스트 서버 작품 정보가 올바르지 않습니다.');
  return {
    id: id(work.id),
    title: text(work.title),
    author: optionalText(work.author),
    description: optionalText(work.description, 8_192),
    status: optionalText(work.status),
    tags: tags as string[] | undefined,
  };
}
function health(value: unknown): ServerIdentity {
  const data = record(value);
  if (
    data.protocolVersion !== 1 ||
    !Array.isArray(data.capabilities) ||
    !['catalog', 'txt-content'].every(
      (capability) => data.capabilities instanceof Array && data.capabilities.includes(capability),
    )
  ) {
    throw new Error('텍스트 서버 protocol 1과 목록·TXT 본문 기능이 필요합니다.');
  }
  return {
    instanceId: text(data.instanceId),
    dataNamespace: text(data.dataNamespace),
    accountId: optionalText(data.accountId),
    label: optionalText(data.label) ?? '텍스트 소스 서버',
  };
}
async function connectionId(identity: ServerIdentity): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([identity.instanceId, identity.dataNamespace, identity.accountId ?? 'single-account']),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `text-server:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** One server connection; site credentials stay on that server, never in this broker. */
export class TextServerSourceAccountBroker implements ExternalSourceBroker {
  private credential?: Credential;
  private credentialRecord?: ExternalSourceCredentialRecord;
  private shared?: ExternalSourceSharedConnectionV1;
  private client?: TextServerClient;
  private lifecycle = new AbortController();
  private generation = crypto.randomUUID();
  private reason?: string;
  private readonly sourceTitles = new Map<string, string>();
  private readonly coverUrls = new Map<string, string>();

  constructor(
    private readonly connectorId: string,
    private readonly state: ExternalSourceLocalState,
    private readonly options: {
      readonly managedFetch?: ManagedTextSourceFetch;
      readonly fetchImpl?: typeof fetch;
      readonly requestTimeoutMs?: number;
      readonly readTimeoutMs?: number;
    } = {},
  ) {}

  connectionForm(): ExternalSourceConnectionForm {
    return this.options.managedFetch
      ? {
          fields: [],
          submitLabel: '텍스트 소스 연결',
          help: '현재 Moya 서버에 설정된 텍스트 소스를 연결합니다. 서버는 단일 계정 범위로 제공됩니다.',
        }
      : {
          fields: [
            {
              id: 'endpoint',
              label: '서버 주소',
              type: 'text',
              required: true,
              defaultValue: this.credential?.endpoint ?? this.shared?.endpoint,
              placeholder: 'https://text.example.test',
              help: '이 브라우저의 접근을 허용한 서버 주소를 입력해 주세요.',
            },
            {
              id: 'token',
              label: '접속 토큰',
              type: 'password',
              help: '필요한 경우 입력합니다. 이 기기의 키로 보호하며 다른 기기에는 공유하지 않습니다.',
            },
          ],
          submitLabel: '텍스트 소스 연결',
          help: '텍스트 서버의 단일 계정에 연결합니다. 사이트 로그인은 텍스트 서버에서 관리합니다.',
        };
  }

  status(): ExternalSourceConnectionStatus {
    return {
      state: this.client
        ? 'connected'
        : this.credentialRecord || this.shared
          ? 'reauthorization_required'
          : 'disconnected',
      accountConnectionId: this.credentialRecord?.accountConnectionId ?? this.shared?.accountConnectionId,
      connectionGeneration: this.generation,
      label: this.credentialRecord?.label ?? this.shared?.label ?? '텍스트 소스 서버',
      reason: this.reason,
    };
  }

  async initialize(): Promise<void> {
    const signal = this.beginChange();
    const [stored, shared] = await Promise.all([
      this.state.getCredential(this.connectorId),
      this.state.getSharedConnection?.(this.connectorId),
    ]);
    signal.throwIfAborted();
    this.shared = shared;
    this.credentialRecord = stored;
    try {
      let endpoint: string;
      let token: string | undefined;
      const expectedAccount = shared?.accountConnectionId ?? stored?.accountConnectionId;
      if (this.options.managedFetch) {
        if (!shared || shared.authMode !== 'managed') {
          this.credentialRecord = undefined;
          return;
        }
        endpoint = MANAGED_ENDPOINT;
      } else if (stored?.protection === 'device_key_v1') {
        const key = await this.state.getOrCreateCredentialKey();
        const value = await unsealExternalSourceCredential<Credential>(stored.credentialEnvelope, key);
        if (value.version !== 1) throw new Error('저장된 연결을 다시 확인해 주세요.');
        endpoint = normalizeTextServerEndpoint(value.endpoint);
        token = optionalText(value.token, 4_096);
        if (shared && (shared.endpoint !== endpoint || shared.accountConnectionId !== stored.accountConnectionId)) {
          this.credentialRecord = undefined;
          throw new Error('다른 기기의 연결 설정이 바뀌었습니다. 이 기기에서 다시 연결해 주세요.');
        }
      } else if (shared?.authMode === 'none') {
        endpoint = normalizeTextServerEndpoint(shared.endpoint);
      } else {
        this.reason = shared || stored ? '이 기기에서 텍스트 서버에 다시 연결해 주세요.' : undefined;
        return;
      }
      const client = this.makeClient(endpoint, token);
      const identity = health(await client.json('/v1/health', signal));
      if (expectedAccount && (await connectionId(identity)) !== expectedAccount)
        throw new Error('텍스트 서버의 데이터 범위가 바뀌었습니다. 다시 연결해 주세요.');
      await this.install({ version: 1, endpoint, token, identity }, signal, false);
    } catch (error) {
      if (signal.aborted) return;
      this.reason = error instanceof Error ? error.message : '텍스트 서버에 다시 연결해 주세요.';
    }
  }

  async refreshSharedConfiguration(): Promise<void> {
    const shared = await this.state.getSharedConnection?.(this.connectorId);
    const authMode = this.options.managedFetch ? 'managed' : this.credential?.token ? 'bearer' : 'none';
    if (
      this.client &&
      shared?.authMode === authMode &&
      shared?.accountConnectionId === this.credentialRecord?.accountConnectionId &&
      shared?.endpoint === this.credential?.endpoint
    )
      return;
    await this.initialize();
  }

  async connect(input: ExternalSourceConnectionInput = {}): Promise<void> {
    const signal = this.beginChange();
    const endpoint = this.options.managedFetch ? MANAGED_ENDPOINT : normalizeTextServerEndpoint(input.endpoint ?? '');
    const token = this.options.managedFetch ? undefined : input.token?.trim() || undefined;
    if (token && (token.length > 4_096 || /\s/u.test(token))) throw new Error('접속 토큰 형식을 확인해 주세요.');
    const client = this.makeClient(endpoint, token);
    const identity = health(await client.json('/v1/health', signal));
    await this.install({ version: 1, endpoint, token, identity }, signal, true);
  }

  async disconnect(): Promise<void> {
    this.beginChange();
    const accountId = this.status().accountConnectionId;
    this.credential = undefined;
    this.credentialRecord = undefined;
    this.shared = undefined;
    await this.state.deleteCredential(this.connectorId);
    await this.state.deleteSharedConnection?.(this.connectorId);
    await this.state.clearCache(this.connectorId, accountId);
  }

  dispose(): void {
    this.lifecycle.abort();
    this.clearCovers();
  }

  private clearCovers(): void {
    for (const url of this.coverUrls.values()) URL.revokeObjectURL(url);
    this.coverUrls.clear();
  }

  async resolveCover(key: ExternalItemKey, signal: AbortSignal): Promise<string | undefined> {
    if (key.connectorId !== this.connectorId) throw new Error('표지 소스 연결이 다릅니다.');
    const { client, requestSignal } = this.connected(key.accountConnectionId, signal);
    const parts = parseNavigation(key.remoteId);
    if (parts.length !== 2) throw new Error('표지 작품 정보가 올바르지 않습니다.');
    const cached = this.coverUrls.get(key.remoteId);
    if (cached) return cached;
    const blob = await client.cover(`/v1/sources/${parts[0]}/works/${parts[1]}/cover`, requestSignal);
    requestSignal.throwIfAborted();
    const existing = this.coverUrls.get(key.remoteId);
    if (existing) return existing;
    const url = URL.createObjectURL(blob);
    this.coverUrls.set(key.remoteId, url);
    return url;
  }

  async list(input: ExternalSourceListInput, signal: AbortSignal): Promise<ExternalItemPage> {
    const { client, requestSignal } = this.connected(input.accountConnectionId, signal);
    const location = input.parentRef ? parseNavigation(input.parentRef) : [];
    if (location.length === 0) {
      const sources = page(await client.json(query('/v1/sources', input), requestSignal), input.cursor);
      this.sourceTitles.clear();
      return {
        items: sources.items.map((source) => {
          const sourceId = id(source.id),
            title = text(source.title);
          this.sourceTitles.set(sourceId, title);
          return {
            key: this.key([sourceId]),
            kind: 'folder',
            title,
            navigationRef: source.available === false ? undefined : navigation([sourceId]),
            importability: 'unsupported',
          };
        }),
        nextCursor: sources.nextCursor,
      };
    }
    const [sourceId, workId] = location;
    const sourcePath = `/v1/sources/${sourceId}/works`;
    if (location.length === 1) {
      const works = page(await client.json(query(sourcePath, input, true), requestSignal), input.cursor);
      return {
        items: works.items.map((value) => {
          const work = detail(value);
          return {
            key: this.key([sourceId!, work.id]),
            kind: 'work',
            title: work.title,
            author: work.author,
            subtitle: work.status,
            coverRef: value.hasCover === true ? this.key([sourceId!, work.id]) : undefined,
            navigationRef: navigation([sourceId!, work.id]),
            importability: 'unsupported',
          };
        }),
        nextCursor: works.nextCursor,
        browse: { activeMode: 'search', availableModes: ['search'] },
      };
    }
    if (location.length !== 2) throw new Error('회차 목록 위치가 올바르지 않습니다.');
    const workPath = `${sourcePath}/${workId}`;
    const [workValue, releaseValue] = await Promise.all([
      client.json(workPath, requestSignal),
      client.json(query(`${workPath}/releases`, input), requestSignal),
    ]);
    const work = detail(workValue),
      workRecord = record(workValue);
    if (
      work.id !== workId ||
      !isExternalSeriesProfile(workRecord.seriesProfile) ||
      workRecord.seriesProfile.kind !== 'document_series'
    )
      throw new Error('텍스트 서버 작품 형식이 일치하지 않습니다.');
    const releases = page(releaseValue, input.cursor);
    return {
      detail: {
        ...work,
        sourceLabel: this.sourceTitles.get(sourceId!),
        coverRef: workRecord.hasCover === true ? this.key([sourceId!, workId!]) : undefined,
      },
      nextCursor: releases.nextCursor,
      items: releases.items.map((release): ExternalItemSummary => {
        const releaseId = id(release.id),
          title = text(release.title);
        if (typeof release.sourceOrder !== 'number' || !Number.isFinite(release.sourceOrder))
          throw new Error('텍스트 서버 회차 순서가 올바르지 않습니다.');
        const byteLength = release.byteLength;
        if (
          byteLength !== undefined &&
          (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0)
        )
          throw new Error('텍스트 서버 회차 크기가 올바르지 않습니다.');
        return {
          key: this.key([sourceId!, workId!, releaseId]),
          kind: 'file',
          title,
          importFileName: `${releaseId}.txt`,
          mimeType: 'text/plain',
          formatHint: 'TXT',
          byteLength: byteLength as number | undefined,
          remoteRevision: optionalText(release.revision, 512),
          importability: 'supported',
          collection: {
            remoteId: navigation([sourceId!, workId!]),
            title: work.title,
            author: work.author,
            description: work.description,
            tags: work.tags,
            status: work.status,
            sourceLabel: this.sourceTitles.get(sourceId!),
            seriesProfile: TEXT_SERVER_PROFILE,
          },
          release: { title, sourceOrder: release.sourceOrder },
        };
      }),
    };
  }

  async download(ref: ExternalSourceDownloadRef, signal: AbortSignal): Promise<DownloadedExternalSourceV2> {
    if (ref.key.connectorId !== this.connectorId) throw new Error('텍스트 소스 연결 정보가 다릅니다.');
    const { client, requestSignal } = this.connected(ref.key.accountConnectionId, signal);
    const [sourceId, workId, releaseId, extra] = parseNavigation(ref.key.remoteId);
    if (!sourceId || !workId || !releaseId || extra) throw new Error('텍스트 소스 회차 정보가 올바르지 않습니다.');
    const result = await client.content(
      `/v1/sources/${sourceId}/works/${workId}/releases/${releaseId}/content`,
      requestSignal,
    );
    requestSignal.throwIfAborted();
    const file = new File([result.bytes], `${releaseId}.txt`, { type: 'text/plain;charset=utf-8' });
    return {
      content: { kind: 'document', file, format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
      remoteRevision: result.revision ?? ref.remoteRevision,
    };
  }

  private key(parts: string[]) {
    return {
      connectorId: this.connectorId,
      accountConnectionId: this.credentialRecord!.accountConnectionId,
      remoteId: navigation(parts),
    };
  }
  private beginChange(): AbortSignal {
    this.lifecycle.abort();
    this.clearCovers();
    this.lifecycle = new AbortController();
    this.generation = crypto.randomUUID();
    this.client = undefined;
    this.reason = undefined;
    this.sourceTitles.clear();
    return this.lifecycle.signal;
  }
  private connected(accountId: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.client || !this.credentialRecord || accountId !== this.credentialRecord.accountConnectionId)
      throw new Error('텍스트 서버 연결을 다시 확인해 주세요.');
    return { client: this.client, requestSignal: AbortSignal.any([signal, this.lifecycle.signal]) };
  }
  private makeClient(endpoint: string, token?: string) {
    return new TextServerClient({ ...this.options, endpoint, token });
  }
  private async install(credential: Credential, signal: AbortSignal, publish: boolean) {
    const accountId = await connectionId(credential.identity);
    const timestamp = new Date().toISOString();
    const label = credential.identity.label;
    const key = await this.state.getOrCreateCredentialKey();
    const stored: ExternalSourceCredentialRecord = {
      id: `external-credential::${this.connectorId}`,
      connectorId: this.connectorId,
      accountConnectionId: accountId,
      label,
      credentialEnvelope: await sealExternalSourceCredential(credential, key),
      protection: 'device_key_v1',
      createdAt: this.credentialRecord?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    signal.throwIfAborted();
    if (publish) {
      await this.state.saveCredential(stored);
      signal.throwIfAborted();
      await this.state.saveSharedConnection?.({
        schemaVersion: 1,
        connectorId: this.connectorId,
        accountConnectionId: accountId,
        endpoint: credential.endpoint,
        authMode: this.options.managedFetch ? 'managed' : credential.token ? 'bearer' : 'none',
        label,
        updatedAt: timestamp,
      });
      await this.state.clearCache(this.connectorId);
    }
    signal.throwIfAborted();
    this.credentialRecord = stored;
    this.credential = credential;
    this.client = new TextServerClient({
      ...this.options,
      endpoint: credential.endpoint,
      token: credential.token,
      expectedNamespace: textServerNamespace(credential.identity),
    });
  }
}
