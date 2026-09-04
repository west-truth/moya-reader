import type {
  DownloadedExternalSource,
  ExternalItemPage,
  ExternalItemSummary,
  ExternalSourceBrowseMode,
  ExternalSourceBroker,
  ExternalSourceConnectionForm,
  ExternalSourceConnectionInput,
  ExternalSourceConnectionStatus,
  ExternalSourceCredentialRecord,
  ExternalSourceDownloadRef,
  ExternalSourceListInput,
  ExternalSourceFilterDefinition,
  ExternalSourceWorkDetail,
} from '../contracts';
import { sealExternalSourceCredential, unsealExternalSourceCredential } from '../device-credential-crypto';
import type { ExternalSourceLocalState } from '../local-state';
import { buildSuwayomiChapterCbz } from './suwayomi-chapter-cbz';
import {
  SuwayomiAuthenticationError,
  SuwayomiGraphqlClient,
  SuwayomiHttpError,
  type SuwayomiAuthMode,
  type SuwayomiClientAuth,
} from './suwayomi-graphql-client';
import { DEFAULT_SUWAYOMI_BASE_URL } from '../../config/public-runtime-config';
import type { ExternalSourceSharedConnectionV1 } from '../../integration-settings/self-host-integration-settings';

export { DEFAULT_SUWAYOMI_BASE_URL } from '../../config/public-runtime-config';
const MAX_DIRECT_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 20 * 1024 * 1024;
const DIRECT_DOWNLOAD_FALLBACK_STATUSES = new Set([400, 404, 405, 409, 422, 500, 501]);

type SuwayomiConnectionAuthMode = 'auto' | SuwayomiAuthMode;

interface SuwayomiCredential {
  readonly baseUrl: string;
  readonly authMode: SuwayomiAuthMode;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly serverName: string;
  readonly serverVersion?: string;
}

interface SuwayomiSource {
  readonly id: string;
  readonly name: string;
  readonly displayName?: string;
  readonly lang: string;
  readonly iconUrl?: string;
  readonly supportsLatest?: boolean;
  readonly filters?: readonly SuwayomiFilter[];
  readonly extension?: {
    readonly pkgName?: string;
    readonly versionName?: string;
    readonly isInstalled?: boolean;
  };
}

type SuwayomiFilter =
  | { readonly __typename: 'HeaderFilter'; readonly name: string }
  | { readonly __typename: 'SeparatorFilter'; readonly name: string }
  | { readonly __typename: 'CheckBoxFilter'; readonly name: string; readonly booleanDefault: boolean }
  | {
      readonly __typename: 'SelectFilter';
      readonly name: string;
      readonly selectDefault: number;
      readonly values: readonly string[];
    }
  | {
      readonly __typename: 'SortFilter';
      readonly name: string;
      readonly sortDefault?: { readonly index: number; readonly ascending: boolean } | null;
      readonly values: readonly string[];
    }
  | { readonly __typename: 'TextFilter'; readonly name: string; readonly textDefault: string }
  | {
      readonly __typename: 'TriStateFilter';
      readonly name: string;
      readonly triStateDefault: 'IGNORE' | 'INCLUDE' | 'EXCLUDE';
    }
  | {
      readonly __typename: 'GroupFilter';
      readonly name: string;
      readonly filters: readonly Exclude<SuwayomiFilter, { readonly __typename: 'GroupFilter' }>[];
    };

interface SuwayomiManga {
  readonly id: number;
  readonly sourceId: string;
  readonly title: string;
  readonly thumbnailUrl?: string | null;
  readonly initialized?: boolean;
  readonly artist?: string | null;
  readonly author?: string | null;
  readonly description?: string | null;
  readonly genre?: readonly string[];
  readonly status?: string;
  readonly realUrl?: string | null;
  readonly lastFetchedAt?: number | null;
  readonly chaptersLastFetchedAt?: number | null;
}

interface SuwayomiChapter {
  readonly id: number;
  readonly name: string;
  readonly uploadDate?: number;
  readonly chapterNumber?: number;
  readonly scanlator?: string | null;
  readonly mangaId: number;
  readonly sourceOrder?: number;
  readonly realUrl?: string | null;
  readonly fetchedAt?: number;
  readonly isDownloaded?: boolean;
  readonly pageCount?: number;
}

const SOURCE_LIST_QUERY = `query MoyaSuwayomiSources {
  sources(first: 500) {
    nodes {
      id name displayName lang iconUrl supportsLatest
      filters {
        __typename
        ... on HeaderFilter { name }
        ... on SeparatorFilter { name }
        ... on CheckBoxFilter { name booleanDefault: default }
        ... on SelectFilter { name selectDefault: default values }
        ... on SortFilter { name sortDefault: default { index ascending } values }
        ... on TextFilter { name textDefault: default }
        ... on TriStateFilter { name triStateDefault: default }
        ... on GroupFilter {
          name
          filters {
            __typename
            ... on HeaderFilter { name }
            ... on SeparatorFilter { name }
            ... on CheckBoxFilter { name booleanDefault: default }
            ... on SelectFilter { name selectDefault: default values }
            ... on SortFilter { name sortDefault: default { index ascending } values }
            ... on TextFilter { name textDefault: default }
            ... on TriStateFilter { name triStateDefault: default }
          }
        }
      }
      extension { pkgName versionName isInstalled }
    }
  }
}`;

const SERVER_INFO_QUERY = `query MoyaSuwayomiServerInfo {
  aboutServer { name version }
}`;

const SOURCE_MANGA_QUERY = `mutation MoyaSuwayomiBrowse($input: FetchSourceMangaInput!) {
  fetchSourceManga(input: $input) {
    mangas {
      id sourceId title thumbnailUrl initialized artist author description genre status realUrl
      lastFetchedAt chaptersLastFetchedAt
    }
    hasNextPage
  }
}`;

const MANGA_DETAIL_QUERY = `mutation MoyaSuwayomiManga($input: FetchMangaAndChaptersInput!) {
  fetchMangaAndChapters(input: $input) {
    manga {
      id sourceId title thumbnailUrl initialized artist author description genre status realUrl
      lastFetchedAt chaptersLastFetchedAt
    }
    chapters {
      id name uploadDate chapterNumber scanlator mangaId sourceOrder realUrl fetchedAt isDownloaded pageCount
    }
  }
}`;

const CHAPTER_PAGES_QUERY = `mutation MoyaSuwayomiChapterPages($input: FetchChapterPagesInput!) {
  fetchChapterPages(input: $input) {
    pages
    chapter { id name mangaId pageCount fetchedAt }
  }
}`;

function nowIso(): string {
  return new Date().toISOString();
}

function credentialRecordId(connectorId: string): string {
  return `external-credential::${connectorId}`;
}

function normalizeBaseUrl(value: string | undefined, fallback = DEFAULT_SUWAYOMI_BASE_URL): string {
  let url: URL;
  try {
    url = new URL(value?.trim() || fallback);
  } catch {
    throw new Error('Suwayomi 서버 주소가 올바르지 않습니다.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Suwayomi 서버 주소는 경로와 사용자 정보가 없는 HTTP(S) origin이어야 합니다.');
  }
  return url.origin;
}

async function connectionId(baseUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(baseUrl));
  const shortHash = [...new Uint8Array(digest).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `suwayomi:${shortHash}`;
}

function navigationId(prefix: 'source' | 'manga', id: string | number): string {
  return `${prefix}:${id}`;
}

function parseNavigationId(value: string, prefix: 'source' | 'manga'): string | undefined {
  const match = new RegExp(`^${prefix}:(-?[0-9]+)$`).exec(value);
  return match?.[1];
}

function parseChapterId(remoteId: string): number | undefined {
  const match = /^chapter:([0-9]+)$/.exec(remoteId);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function pageNumber(cursor: string | undefined): number {
  const match = /^page:([1-9][0-9]*)$/.exec(cursor ?? '');
  return match ? Number(match[1]) : 1;
}

function filterId(position: number, groupPosition?: number): string {
  return groupPosition === undefined ? String(position) : `${position}.${groupPosition}`;
}

function projectFilter(
  filter: Exclude<SuwayomiFilter, { readonly __typename: 'GroupFilter' }>,
  position: number,
  groupPosition?: number,
): ExternalSourceFilterDefinition | undefined {
  const common = { id: filterId(position, groupPosition), position, groupPosition };
  switch (filter.__typename) {
    case 'HeaderFilter':
      return { ...common, kind: 'header', label: filter.name };
    case 'SeparatorFilter':
      return { ...common, kind: 'separator', label: filter.name || undefined };
    case 'CheckBoxFilter':
      return { ...common, kind: 'checkbox', label: filter.name, defaultValue: filter.booleanDefault };
    case 'SelectFilter':
      return {
        ...common,
        kind: 'select',
        label: filter.name,
        options: filter.values,
        defaultValue: filter.selectDefault,
      };
    case 'SortFilter':
      return {
        ...common,
        kind: 'sort',
        label: filter.name,
        options: filter.values,
        defaultValue: filter.sortDefault ?? { index: 0, ascending: true },
      };
    case 'TextFilter':
      return { ...common, kind: 'text', label: filter.name, defaultValue: filter.textDefault };
    case 'TriStateFilter':
      return { ...common, kind: 'tri_state', label: filter.name, defaultValue: filter.triStateDefault };
  }
}

function projectFilters(filters: readonly SuwayomiFilter[] | undefined): readonly ExternalSourceFilterDefinition[] {
  return (filters ?? []).flatMap((filter, position) => {
    if (filter.__typename !== 'GroupFilter') {
      const projected = projectFilter(filter, position);
      return projected ? [projected] : [];
    }
    const header: ExternalSourceFilterDefinition = {
      id: filterId(position),
      position,
      kind: 'header',
      label: filter.name,
    };
    return [
      header,
      ...filter.filters.flatMap((child, groupPosition) => {
        const projected = projectFilter(child, position, groupPosition);
        return projected ? [projected] : [];
      }),
    ];
  });
}

function browseMode(input: ExternalSourceListInput, source: SuwayomiSource | undefined): ExternalSourceBrowseMode {
  if (input.browseMode === 'search') return 'search';
  if (input.query?.trim()) return 'search';
  if (input.browseMode === 'latest' && source?.supportsLatest) return 'latest';
  return 'popular';
}

function suwayomiFilterChanges(input: ExternalSourceListInput) {
  return input.filters?.map((change) => {
    const value = change.value;
    const leaf = {
      position: change.groupPosition ?? change.position,
      ...(typeof value === 'boolean'
        ? { checkBoxState: value }
        : typeof value === 'number'
          ? { selectState: value }
          : typeof value === 'string'
            ? value === 'IGNORE' || value === 'INCLUDE' || value === 'EXCLUDE'
              ? { triState: value }
              : { textState: value }
            : { sortState: value }),
    };
    return change.groupPosition === undefined ? leaf : { position: change.position, groupChange: leaf };
  });
}

function epochIso(value: number | null | undefined): string | undefined {
  if (!Number.isFinite(value) || !value || value < 0) return undefined;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeFileName(value: string): string {
  const withoutControls = [...value].map((character) => (character.charCodeAt(0) < 32 ? ' ' : character)).join('');
  const clean = withoutControls
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (clean || 'Suwayomi 회차').slice(0, 180);
}

function statusLabel(status: string | undefined): string | undefined {
  const labels: Record<string, string> = {
    ONGOING: '연재 중',
    COMPLETED: '완결',
    LICENSED: '라이선스',
    PUBLISHING_FINISHED: '출판 완료',
    CANCELLED: '중단',
    ON_HIATUS: '휴재',
    UNKNOWN: '상태 미상',
  };
  return status ? (labels[status] ?? status) : undefined;
}

/** Hosts installed Mihon-compatible sources through a user-owned Suwayomi Server. */
export class SuwayomiSourceAccountBroker implements ExternalSourceBroker {
  private record?: ExternalSourceCredentialRecord;
  private sharedConnection?: ExternalSourceSharedConnectionV1;
  private credential?: SuwayomiCredential;
  private credentialKey?: CryptoKey;
  private client?: SuwayomiGraphqlClient;
  private basicAuthorization?: string;
  private reauthorizationRequired = false;
  private connectionReason?: string;
  private readonly sources = new Map<string, SuwayomiSource>();
  private readonly mangas = new Map<number, SuwayomiManga>();
  private readonly thumbnailObjectUrls = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;
  private readonly defaultBaseUrl: string;

  constructor(
    private readonly connectorId: string,
    private readonly state: ExternalSourceLocalState,
    fetchOrOptions: typeof fetch | { readonly fetchImpl?: typeof fetch; readonly defaultBaseUrl?: string } = {},
  ) {
    const options = typeof fetchOrOptions === 'function' ? { fetchImpl: fetchOrOptions } : fetchOrOptions;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.defaultBaseUrl = normalizeBaseUrl(options.defaultBaseUrl);
  }

  connectionForm(): ExternalSourceConnectionForm {
    return {
      submitLabel: 'Suwayomi 연결',
      help: 'Mihon 호환 소스의 설치와 업데이트는 Suwayomi에서 관리합니다.',
      fields: [
        {
          id: 'baseUrl',
          label: '서버 주소',
          type: 'text',
          required: true,
          defaultValue: this.credential?.baseUrl ?? this.sharedConnection?.endpoint ?? this.defaultBaseUrl,
          placeholder: this.defaultBaseUrl,
          help: '이 브라우저에서 접근 가능한 Suwayomi Server 주소를 입력하세요.',
        },
        {
          id: 'authMode',
          label: '인증 방식',
          type: 'select',
          defaultValue: this.sharedConnection?.authMode ?? 'auto',
          options: [
            { value: 'auto', label: '자동 감지' },
            { value: 'none', label: '인증 없음' },
            { value: 'ui_login', label: 'UI 로그인' },
            { value: 'basic_auth', label: 'Basic 인증' },
          ],
        },
        { id: 'username', label: '사용자 이름', type: 'text', placeholder: '인증 사용 시 입력' },
        {
          id: 'password',
          label: '비밀번호',
          type: 'password',
          placeholder: '이 연결 과정에서만 사용',
          help: '비밀번호는 저장하지 않습니다. UI 로그인은 발급된 토큰만 암호화해 저장합니다.',
        },
      ],
    };
  }

  async initialize(): Promise<void> {
    const [record, sharedConnection] = await Promise.all([
      this.state.getCredential(this.connectorId),
      this.state.getSharedConnection?.(this.connectorId) ?? Promise.resolve(undefined),
    ]);
    this.sharedConnection = sharedConnection;
    this.record =
      record && (!sharedConnection || record.accountConnectionId === sharedConnection.accountConnectionId)
        ? record
        : undefined;
    this.credential = undefined;
    this.client = undefined;
    this.basicAuthorization = undefined;
    this.connectionReason = undefined;
    this.reauthorizationRequired = Boolean(sharedConnection);
    if (!this.record) {
      if (sharedConnection?.authMode === 'none') {
        try {
          await this.connect({ baseUrl: sharedConnection.endpoint, authMode: 'none' });
        } catch (error) {
          this.connectionReason = error instanceof Error ? error.message : 'Suwayomi에 다시 연결해 주세요.';
          this.reauthorizationRequired = true;
        }
      }
      return;
    }
    if (this.record.protection !== 'device_key_v1') {
      this.reauthorizationRequired = true;
      return;
    }
    try {
      const key = await this.state.getOrCreateCredentialKey();
      const credential = await unsealExternalSourceCredential<SuwayomiCredential>(this.record.credentialEnvelope, key);
      await this.validateCredential(credential, this.record);
      if (credential.authMode === 'basic_auth') {
        this.reauthorizationRequired = true;
        return;
      }
      this.installCredential(credential, key);
      if (!sharedConnection) await this.saveSharedConnection(credential, this.record);
    } catch {
      this.credential = undefined;
      this.client = undefined;
      this.reauthorizationRequired = true;
    }
  }

  status(): ExternalSourceConnectionStatus {
    if (!this.record) {
      return this.sharedConnection
        ? {
            state: 'reauthorization_required',
            accountConnectionId: this.sharedConnection.accountConnectionId,
            label: this.sharedConnection.label,
            reason: this.connectionReason ?? '이 기기에서 Suwayomi 인증을 한 번 확인해 주세요.',
          }
        : { state: 'disconnected', label: 'Suwayomi', reason: this.connectionReason };
    }
    return {
      state: this.client && this.credential ? 'connected' : 'reauthorization_required',
      accountConnectionId: this.record.accountConnectionId,
      label: this.record.label,
      reason:
        this.client && this.credential
          ? undefined
          : this.reauthorizationRequired
            ? 'Suwayomi 연결 정보를 다시 입력해 주세요. Basic 비밀번호는 기기에 저장하지 않습니다.'
            : 'Suwayomi에 다시 연결해 주세요.',
    };
  }

  async connect(input: ExternalSourceConnectionInput = {}): Promise<void> {
    this.connectionReason = undefined;
    const baseUrl = normalizeBaseUrl(input.baseUrl, this.defaultBaseUrl);
    const requestedAuth = this.authMode(input.authMode);
    const username = input.username?.trim() ?? '';
    const password = input.password ?? '';
    const probe = this.makeClient(baseUrl, { mode: 'none' });
    let authCredential: Omit<SuwayomiCredential, 'serverName' | 'serverVersion'>;
    let authenticatedClient: SuwayomiGraphqlClient;
    let sessionBasicAuthorization: string | undefined;
    if (requestedAuth === 'none') {
      await this.verifySources(probe);
      authCredential = { baseUrl, authMode: 'none' };
      authenticatedClient = probe;
    } else if (requestedAuth === 'ui_login') {
      this.requireUserPassword(username, password);
      const tokens = await probe.login(username, password);
      authCredential = { baseUrl, authMode: 'ui_login', ...tokens };
      authenticatedClient = this.makeClient(baseUrl, authCredential);
      await this.verifySources(authenticatedClient);
    } else if (requestedAuth === 'basic_auth') {
      this.requireUserPassword(username, password);
      sessionBasicAuthorization = SuwayomiGraphqlClient.createBasicAuthorization(username, password);
      authCredential = { baseUrl, authMode: 'basic_auth' };
      authenticatedClient = this.makeClient(baseUrl, authCredential, sessionBasicAuthorization);
      await this.verifySources(authenticatedClient);
    } else {
      try {
        await this.verifySources(probe);
        authCredential = { baseUrl, authMode: 'none' };
        authenticatedClient = probe;
      } catch (error) {
        if (!(error instanceof SuwayomiAuthenticationError)) throw error;
        this.requireUserPassword(username, password);
        try {
          const tokens = await probe.login(username, password);
          authCredential = { baseUrl, authMode: 'ui_login', ...tokens };
          authenticatedClient = this.makeClient(baseUrl, authCredential);
          await this.verifySources(authenticatedClient);
        } catch {
          sessionBasicAuthorization = SuwayomiGraphqlClient.createBasicAuthorization(username, password);
          authCredential = { baseUrl, authMode: 'basic_auth' };
          authenticatedClient = this.makeClient(baseUrl, authCredential, sessionBasicAuthorization);
          await this.verifySources(authenticatedClient);
        }
      }
    }
    const info = await authenticatedClient.graphql<{ aboutServer?: { name?: string; version?: string } }>(
      SERVER_INFO_QUERY,
      {},
    );
    const credential: SuwayomiCredential = {
      ...authCredential,
      serverName: info.aboutServer?.name?.trim() || 'Suwayomi',
      serverVersion: info.aboutServer?.version?.trim() || undefined,
    };
    await this.persistCredential(credential, sessionBasicAuthorization);
  }

  async disconnect(): Promise<void> {
    const accountConnectionId = this.record?.accountConnectionId ?? this.sharedConnection?.accountConnectionId;
    await this.state.deleteCredential(this.connectorId);
    await this.state.deleteSharedConnection?.(this.connectorId);
    await this.state.clearCache(this.connectorId, accountConnectionId);
    this.record = undefined;
    this.sharedConnection = undefined;
    this.credential = undefined;
    this.credentialKey = undefined;
    this.client = undefined;
    this.basicAuthorization = undefined;
    this.reauthorizationRequired = false;
    this.connectionReason = undefined;
    this.sources.clear();
    this.mangas.clear();
    this.clearThumbnailObjectUrls();
  }

  async list(input: ExternalSourceListInput, signal: AbortSignal): Promise<ExternalItemPage> {
    this.requireConnection(input.accountConnectionId);
    if (!input.parentRef) return this.listSources(signal);
    const sourceId = parseNavigationId(input.parentRef, 'source');
    if (sourceId) return this.listMangas(sourceId, input, signal);
    const mangaId = parseNavigationId(input.parentRef, 'manga');
    if (mangaId) return this.listChapters(Number(mangaId), signal);
    throw new Error('Suwayomi 탐색 위치가 올바르지 않습니다.');
  }

  async download(ref: ExternalSourceDownloadRef, signal: AbortSignal): Promise<DownloadedExternalSource> {
    const client = this.requireConnection(ref.key.accountConnectionId);
    if (ref.key.connectorId !== this.connectorId) throw new Error('Suwayomi 회차 연결 정보가 올바르지 않습니다.');
    const chapterId = parseChapterId(ref.key.remoteId);
    if (!chapterId) throw new Error('Suwayomi 회차 연결 정보가 올바르지 않습니다.');
    const fileName = safeFileName(ref.fileName.replace(/\.cbz$/i, '')) + '.cbz';
    try {
      const response = await client.fetchAsset(`/api/v1/chapter/${chapterId}/download?markAsRead=false`, signal);
      const declaredLength = Number(response.headers.get('Content-Length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_DIRECT_DOWNLOAD_BYTES) {
        throw new Error('Suwayomi 회차 파일 크기가 안전 한도를 초과했습니다.');
      }
      const fileBlob = await response.blob();
      if (fileBlob.size === 0 || fileBlob.size > MAX_DIRECT_DOWNLOAD_BYTES) {
        throw new Error('Suwayomi 회차 파일 크기가 올바르지 않습니다.');
      }
      return {
        file: new File([fileBlob], fileName, { type: 'application/vnd.comicbook+zip' }),
        remoteRevision: ref.remoteRevision,
      };
    } catch (error) {
      if (!(error instanceof SuwayomiHttpError) || !DIRECT_DOWNLOAD_FALLBACK_STATUSES.has(error.status)) throw error;
    }

    const pages = await client.graphql<{
      fetchChapterPages?: { pages?: readonly string[]; chapter?: SuwayomiChapter } | null;
    }>(CHAPTER_PAGES_QUERY, { input: { chapterId } }, signal);
    const payload = pages.fetchChapterPages;
    if (!payload?.pages) throw new Error('Suwayomi에서 회차 이미지 목록을 가져오지 못했습니다.');
    const manga = payload.chapter ? this.mangas.get(payload.chapter.mangaId) : undefined;
    const blob = await buildSuwayomiChapterCbz(
      payload.pages,
      {
        title: payload.chapter?.name || fileName.replace(/\.cbz$/i, ''),
        series: manga?.title,
        author: manga?.author ?? undefined,
        summary: manga?.description ?? undefined,
        language: manga ? this.sources.get(manga.sourceId)?.lang : undefined,
        tags: manga?.genre,
      },
      (url, pageSignal) => client.fetchAsset(url, pageSignal),
      signal,
    );
    return {
      file: new File([blob], fileName, { type: 'application/vnd.comicbook+zip' }),
      remoteRevision: ref.remoteRevision,
    };
  }

  private async listSources(signal: AbortSignal): Promise<ExternalItemPage> {
    const client = this.requireConnection();
    const data = await client.graphql<{ sources?: { nodes?: readonly SuwayomiSource[] } }>(
      SOURCE_LIST_QUERY,
      {},
      signal,
    );
    const nodes = data.sources?.nodes?.filter((source) => source.extension?.isInstalled !== false) ?? [];
    this.sources.clear();
    nodes.forEach((source) => this.sources.set(source.id, source));
    const items = await Promise.all(
      nodes.map(async (source): Promise<ExternalItemSummary> => ({
        key: this.itemKey(`source:${source.id}`),
        kind: 'folder',
        title: source.displayName?.trim() || source.name,
        subtitle: [source.lang?.toUpperCase(), source.extension?.versionName].filter(Boolean).join(' · '),
        formatHint: 'MIHON SOURCE',
        thumbnailUrl: await this.resolveThumbnail(source.iconUrl, signal),
        navigationRef: navigationId('source', source.id),
        importability: 'unsupported',
      })),
    );
    return { items };
  }

  private async listMangas(
    sourceId: string,
    input: ExternalSourceListInput,
    signal: AbortSignal,
  ): Promise<ExternalItemPage> {
    const client = this.requireConnection();
    const page = pageNumber(input.cursor);
    const search = input.query?.trim();
    const source = this.sources.get(sourceId);
    const mode = browseMode(input, source);
    const data = await client.graphql<{
      fetchSourceManga?: { mangas?: readonly SuwayomiManga[]; hasNextPage?: boolean } | null;
    }>(
      SOURCE_MANGA_QUERY,
      {
        input: {
          source: sourceId,
          type: mode.toUpperCase(),
          page,
          ...(search ? { query: search } : {}),
          ...(input.filters?.length ? { filters: suwayomiFilterChanges(input) } : {}),
        },
      },
      signal,
    );
    const payload = data.fetchSourceManga;
    if (!payload?.mangas) throw new Error('Suwayomi 소스에서 작품 목록을 가져오지 못했습니다.');
    payload.mangas.forEach((manga) => this.mangas.set(manga.id, manga));
    return {
      items: await Promise.all(payload.mangas.map((manga) => this.mangaItem(manga, source, signal))),
      nextCursor: payload.hasNextPage ? `page:${page + 1}` : undefined,
      browse: {
        activeMode: mode,
        availableModes: ['popular', ...(source?.supportsLatest ? (['latest'] as const) : []), 'search'],
        filters: projectFilters(source?.filters),
      },
    };
  }

  private async listChapters(mangaId: number, signal: AbortSignal): Promise<ExternalItemPage> {
    const client = this.requireConnection();
    const data = await client.graphql<{
      fetchMangaAndChapters?: { manga?: SuwayomiManga; chapters?: readonly SuwayomiChapter[] } | null;
    }>(MANGA_DETAIL_QUERY, { input: { id: mangaId, fetchManga: true, fetchChapters: true } }, signal);
    const payload = data.fetchMangaAndChapters;
    if (!payload?.manga) throw new Error('Suwayomi에서 작품 정보를 가져오지 못했습니다.');
    const manga = payload.manga;
    this.mangas.set(manga.id, manga);
    const source = this.sources.get(manga.sourceId);
    return {
      detail: await this.workDetail(manga, source, signal),
      items: (payload.chapters ?? []).map((chapter): ExternalItemSummary => ({
        key: this.itemKey(`chapter:${chapter.id}`),
        kind: 'file',
        title: chapter.name,
        importFileName: `${safeFileName(`${manga.title} - ${chapter.name}`)}.cbz`,
        subtitle: chapter.scanlator?.trim() || undefined,
        mimeType: 'application/vnd.comicbook+zip',
        formatHint: 'CBZ',
        updatedAt: epochIso(chapter.uploadDate),
        // fetchedAt is a local Suwayomi refresh timestamp and can change even when the
        // remote release bytes did not. Keep the link revision stable across browsing.
        // pageCount can be missing until Suwayomi fetches a chapter for the first time.
        // Treating that cache fill as a revision would show an immediate false update after import.
        remoteRevision: [chapter.id, chapter.uploadDate ?? ''].join(':'),
        collection: {
          remoteId: `manga:${manga.id}`,
          title: manga.title,
          author: manga.author?.trim() || manga.artist?.trim() || undefined,
          description: manga.description?.trim() || undefined,
          tags: manga.genre,
          status: statusLabel(manga.status),
          sourceLabel: source?.displayName?.trim() || source?.name,
        },
        release: {
          title: chapter.name,
          chapterNumber: chapter.chapterNumber,
          sourceOrder: chapter.sourceOrder,
        },
        importability: 'supported',
      })),
    };
  }

  private async mangaItem(
    manga: SuwayomiManga,
    source: SuwayomiSource | undefined,
    signal: AbortSignal,
  ): Promise<ExternalItemSummary> {
    return {
      key: this.itemKey(`manga:${manga.id}`),
      kind: 'work',
      title: manga.title,
      author: manga.author?.trim() || manga.artist?.trim() || undefined,
      subtitle: [statusLabel(manga.status), source?.displayName ?? source?.name].filter(Boolean).join(' · '),
      thumbnailUrl: await this.resolveThumbnail(manga.thumbnailUrl ?? undefined, signal),
      updatedAt: epochIso(manga.chaptersLastFetchedAt ?? manga.lastFetchedAt),
      navigationRef: navigationId('manga', manga.id),
      importability: 'unsupported',
    };
  }

  private async workDetail(
    manga: SuwayomiManga,
    source: SuwayomiSource | undefined,
    signal: AbortSignal,
  ): Promise<ExternalSourceWorkDetail> {
    return {
      title: manga.title,
      author: manga.author?.trim() || undefined,
      artist: manga.artist?.trim() || undefined,
      description: manga.description?.trim() || undefined,
      tags: manga.genre,
      status: statusLabel(manga.status),
      thumbnailUrl: await this.resolveThumbnail(manga.thumbnailUrl ?? undefined, signal),
      sourceLabel: source?.displayName?.trim() || source?.name,
    };
  }

  private async resolveThumbnail(pathOrUrl: string | undefined, signal: AbortSignal): Promise<string | undefined> {
    if (!pathOrUrl) return undefined;
    const client = this.requireConnection();
    const absoluteUrl = client.absoluteUrl(pathOrUrl);
    if (!absoluteUrl) return undefined;
    if (this.credential?.authMode === 'none') return absoluteUrl;
    const cached = this.thumbnailObjectUrls.get(absoluteUrl);
    if (cached) return cached;
    try {
      const response = await client.fetchAsset(absoluteUrl, signal);
      const declaredLength = Number(response.headers.get('Content-Length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_THUMBNAIL_BYTES) return undefined;
      const blob = await response.blob();
      const contentType = (blob.type || response.headers.get('Content-Type') || '').toLowerCase();
      if (!contentType.startsWith('image/') || blob.size === 0 || blob.size > MAX_THUMBNAIL_BYTES) return undefined;
      if (typeof URL.createObjectURL !== 'function') return undefined;
      const objectUrl = URL.createObjectURL(blob);
      this.thumbnailObjectUrls.set(absoluteUrl, objectUrl);
      return objectUrl;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (error instanceof SuwayomiAuthenticationError) throw error;
      return undefined;
    }
  }

  private clearThumbnailObjectUrls(): void {
    if (typeof URL.revokeObjectURL === 'function') {
      this.thumbnailObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    }
    this.thumbnailObjectUrls.clear();
  }

  private itemKey(remoteId: string) {
    return {
      connectorId: this.connectorId,
      accountConnectionId: this.record?.accountConnectionId,
      remoteId,
    };
  }

  private requireConnection(accountConnectionId?: string): SuwayomiGraphqlClient {
    if (!this.client || !this.credential || !this.record) throw new Error('Suwayomi에 먼저 연결해 주세요.');
    if (accountConnectionId && accountConnectionId !== this.record.accountConnectionId) {
      throw new Error('Suwayomi 서버 연결 정보가 일치하지 않습니다.');
    }
    return this.client;
  }

  private async verifySources(client: SuwayomiGraphqlClient): Promise<void> {
    const data = await client.graphql<{ sources?: { nodes?: readonly SuwayomiSource[] } }>(SOURCE_LIST_QUERY, {});
    if (!data.sources?.nodes) throw new Error('Suwayomi의 설치 소스 목록을 확인하지 못했습니다.');
  }

  private makeClient(
    baseUrl: string,
    credential: Pick<SuwayomiCredential, 'authMode' | 'accessToken' | 'refreshToken'> | SuwayomiClientAuth,
    basic = this.basicAuthorization,
  ): SuwayomiGraphqlClient {
    return new SuwayomiGraphqlClient(
      baseUrl,
      this.fetchImpl,
      () => ({
        mode: 'authMode' in credential ? credential.authMode : credential.mode,
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        basicAuthorization: basic,
      }),
      async (accessToken) => this.saveRefreshedAccessToken(accessToken),
    );
  }

  private async persistCredential(credential: SuwayomiCredential, basic?: string): Promise<void> {
    const timestamp = nowIso();
    const accountConnectionId = await connectionId(credential.baseUrl);
    const key = await this.state.getOrCreateCredentialKey();
    const record: ExternalSourceCredentialRecord = {
      id: credentialRecordId(this.connectorId),
      connectorId: this.connectorId,
      accountConnectionId,
      label: `${credential.serverName}${credential.serverVersion ? ` ${credential.serverVersion}` : ''}`,
      credentialEnvelope: await sealExternalSourceCredential(credential, key),
      protection: 'device_key_v1',
      createdAt: this.record?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.state.saveCredential(record);
    await this.saveSharedConnection(credential, record);
    this.record = record;
    this.basicAuthorization = basic;
    this.reauthorizationRequired = false;
    this.installCredential(credential, key);
  }

  async refreshSharedConfiguration(): Promise<void> {
    await this.initialize();
  }

  private async saveSharedConnection(
    credential: SuwayomiCredential,
    record: ExternalSourceCredentialRecord,
  ): Promise<void> {
    const connection: ExternalSourceSharedConnectionV1 = {
      schemaVersion: 1,
      connectorId: this.connectorId,
      accountConnectionId: record.accountConnectionId,
      endpoint: credential.baseUrl,
      authMode: credential.authMode,
      label: record.label,
      updatedAt: record.updatedAt,
    };
    this.sharedConnection = connection;
    await this.state.saveSharedConnection?.(connection);
  }

  private installCredential(credential: SuwayomiCredential, key: CryptoKey): void {
    this.clearThumbnailObjectUrls();
    this.credential = credential;
    this.credentialKey = key;
    this.client = new SuwayomiGraphqlClient(
      credential.baseUrl,
      this.fetchImpl,
      () => ({
        mode: this.credential?.authMode ?? credential.authMode,
        accessToken: this.credential?.accessToken,
        refreshToken: this.credential?.refreshToken,
        basicAuthorization: this.basicAuthorization,
      }),
      async (accessToken) => this.saveRefreshedAccessToken(accessToken),
    );
  }

  private async saveRefreshedAccessToken(accessToken: string): Promise<void> {
    if (!this.credential || !this.record || !this.credentialKey || this.credential.authMode !== 'ui_login') {
      throw new SuwayomiAuthenticationError();
    }
    const credential = { ...this.credential, accessToken };
    const record: ExternalSourceCredentialRecord = {
      ...this.record,
      credentialEnvelope: await sealExternalSourceCredential(credential, this.credentialKey),
      updatedAt: nowIso(),
    };
    await this.state.saveCredential(record);
    this.credential = credential;
    this.record = record;
  }

  private async validateCredential(
    credential: SuwayomiCredential,
    record: ExternalSourceCredentialRecord,
  ): Promise<void> {
    if (
      !credential.baseUrl ||
      !credential.serverName ||
      !['none', 'ui_login', 'basic_auth'].includes(credential.authMode)
    ) {
      throw new Error('invalid credential');
    }
    if (credential.authMode === 'ui_login' && (!credential.accessToken || !credential.refreshToken)) {
      throw new Error('invalid credential');
    }
    void normalizeBaseUrl(credential.baseUrl);
    if ((await connectionId(credential.baseUrl)) !== record.accountConnectionId) {
      throw new Error('invalid connection identity');
    }
  }

  private authMode(value: string | undefined): SuwayomiConnectionAuthMode {
    return ['none', 'ui_login', 'basic_auth'].includes(value ?? '') ? (value as SuwayomiConnectionAuthMode) : 'auto';
  }

  private requireUserPassword(username: string, password: string): void {
    if (!username || !password) throw new Error('Suwayomi 인증 사용자 이름과 비밀번호를 입력해 주세요.');
  }
}
