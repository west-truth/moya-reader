import { BlobReader, TextWriter, ZipReader, type FileEntry } from '@zip.js/zip.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  ExternalCatalogCachePage,
  ExternalSourceCredentialRecord,
  ExternalSourceLink,
  ExternalSourceSelectionRecord,
} from '../contracts';
import { createExternalSourceCredentialKey, unsealExternalSourceCredential } from '../device-credential-crypto';
import type { ExternalSourceDefaultFolder, ExternalSourceLocalState } from '../local-state';
import { SuwayomiSourceAccountBroker } from './suwayomi-source-account-broker';

const CONNECTOR_ID = 'moya.external.suwayomi.sources';
const SUWAYOMI_BASIC_HEADER = `Basic ${btoa('reader:session-password')}`;

function memoryState(key: CryptoKey): ExternalSourceLocalState & {
  credential: () => ExternalSourceCredentialRecord | undefined;
} {
  let credential: ExternalSourceCredentialRecord | undefined;
  const cache = new Map<string, ExternalCatalogCachePage>();
  const links = new Map<string, ExternalSourceLink>();
  const folders = new Map<string, ExternalSourceDefaultFolder>();
  const selections = new Map<string, ExternalSourceSelectionRecord>();
  return {
    credential: () => credential,
    getOrCreateCredentialKey: async () => key,
    getCredential: async () => credential,
    saveCredential: async (record) => {
      credential = record;
    },
    deleteCredential: async () => {
      credential = undefined;
    },
    getCachePage: async (id) => cache.get(id),
    saveCachePage: async (page) => {
      cache.set(page.id, page);
    },
    clearCache: async () => cache.clear(),
    listLinks: async () => [...links.values()],
    saveLink: async (link) => {
      links.set(link.id, link);
    },
    getDefaultFolder: async (connectorId, accountConnectionId) =>
      folders.get(`${connectorId}::${accountConnectionId ?? ''}`),
    saveDefaultFolder: async (folder) => {
      folders.set(`${folder.connectorId}::${folder.accountConnectionId ?? ''}`, folder);
    },
    deleteDefaultFolder: async (connectorId, accountConnectionId) => {
      folders.delete(`${connectorId}::${accountConnectionId ?? ''}`);
    },
    getCatalogPreference: async () => undefined,
    saveCatalogPreference: async () => undefined,
    listSubscriptions: async () => [],
    saveSubscription: async () => undefined,
    deleteSubscription: async () => undefined,
    listSelectedItems: async (connectorId, accountConnectionId) =>
      [...selections.values()].filter(
        (record) => record.connectorId === connectorId && record.accountConnectionId === accountConnectionId,
      ),
    saveSelectedItem: async (record) => {
      selections.set(record.id, record);
    },
    deleteSelectedItem: async (id) => {
      selections.delete(id);
    },
  };
}

function graphqlRequest(init: RequestInit | undefined): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const installedSource = {
  id: '1234567890123456789',
  name: '테스트 소스',
  displayName: '테스트 소스 (KO)',
  lang: 'ko',
  iconUrl: '/api/v1/extension/icon/test.png',
  supportsLatest: true,
  filters: [
    { __typename: 'SelectFilter', name: '장르', selectDefault: 0, values: ['전체', '판타지'] },
    {
      __typename: 'GroupFilter',
      name: '정렬',
      filters: [
        {
          __typename: 'SortFilter',
          name: '기준',
          sortDefault: { index: 0, ascending: false },
          values: ['인기', '업데이트'],
        },
      ],
    },
  ],
  extension: { name: 'Test', pkgName: 'eu.kanade.test', versionName: '1.2.3', isInstalled: true },
};

const manga = {
  id: 41,
  sourceId: installedSource.id,
  title: '원격 작품',
  thumbnailUrl: '/api/v1/manga/41/thumbnail',
  author: '작가',
  artist: '그림',
  description: '작품 설명',
  genre: ['판타지'],
  status: 'ONGOING',
  lastFetchedAt: 1_788_000_000,
  chaptersLastFetchedAt: 1_788_000_100,
};

const chapter = {
  id: 73,
  name: '제1화',
  mangaId: 41,
  uploadDate: 1_788_000_200,
  chapterNumber: 1,
  sourceOrder: 0,
  fetchedAt: 1_788_000_300,
  pageCount: 1,
};

describe('SuwayomiSourceAccountBroker', () => {
  it('pre-fills a configured deployment endpoint while retaining the local default elsewhere', async () => {
    const state = memoryState(await createExternalSourceCredentialKey());
    const broker = new SuwayomiSourceAccountBroker(CONNECTOR_ID, state, {
      defaultBaseUrl: 'https://suwayomi.example.test/',
    });

    const baseUrlField = broker.connectionForm().fields.find((field) => field.id === 'baseUrl');
    expect(baseUrlField).toMatchObject({
      defaultValue: 'https://suwayomi.example.test',
      placeholder: 'https://suwayomi.example.test',
    });
    expect(
      () =>
        new SuwayomiSourceAccountBroker(CONNECTOR_ID, state, {
          defaultBaseUrl: 'https://suwayomi.example.test/mihon',
        }),
    ).toThrow('HTTP(S) origin');
  });

  it('browses installed sources, works and chapters and downloads the official chapter CBZ', async () => {
    const state = memoryState(await createExternalSourceCredentialKey());
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/chapter/73/download')) {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          headers: { 'Content-Type': 'application/vnd.comicbook+zip', 'Content-Length': '4' },
        });
      }
      const { query } = graphqlRequest(init);
      if (query.includes('MoyaSuwayomiServerInfo'))
        return json({ data: { aboutServer: { name: 'Suwayomi', version: '2.0' } } });
      if (query.includes('MoyaSuwayomiSources')) return json({ data: { sources: { nodes: [installedSource] } } });
      if (query.includes('MoyaSuwayomiBrowse')) {
        return json({ data: { fetchSourceManga: { mangas: [manga], hasNextPage: false } } });
      }
      if (query.includes('MoyaSuwayomiManga')) {
        return json({ data: { fetchMangaAndChapters: { manga, chapters: [chapter] } } });
      }
      return new Response(null, { status: 404 });
    });
    const broker = new SuwayomiSourceAccountBroker(CONNECTOR_ID, state, fetchImpl as typeof fetch);

    await broker.connect({ baseUrl: 'http://127.0.0.1:4567/', authMode: 'none' });
    const connection = broker.status();
    expect(connection).toMatchObject({ state: 'connected', label: 'Suwayomi 2.0' });

    const root = await broker.list(
      { accountConnectionId: connection.accountConnectionId },
      new AbortController().signal,
    );
    expect(root.items).toEqual([
      expect.objectContaining({
        kind: 'folder',
        title: '테스트 소스 (KO)',
        navigationRef: `source:${installedSource.id}`,
        thumbnailUrl: 'http://127.0.0.1:4567/api/v1/extension/icon/test.png',
      }),
    ]);
    const works = await broker.list(
      { accountConnectionId: connection.accountConnectionId, parentRef: root.items[0]!.navigationRef },
      new AbortController().signal,
    );
    expect(works.items[0]).toMatchObject({ kind: 'work', title: '원격 작품', navigationRef: 'manga:41' });
    const chapters = await broker.list(
      { accountConnectionId: connection.accountConnectionId, parentRef: works.items[0]!.navigationRef },
      new AbortController().signal,
    );
    expect(chapters.detail).toMatchObject({ title: '원격 작품', author: '작가', status: '연재 중' });
    expect(chapters.items[0]).toMatchObject({
      kind: 'file',
      title: '제1화',
      importFileName: '원격 작품 - 제1화.cbz',
      remoteRevision: '73:1788000200',
      collection: { remoteId: 'manga:41', title: '원격 작품' },
      release: { title: '제1화', chapterNumber: 1, sourceOrder: 0 },
      importability: 'supported',
    });
    await expect(
      broker.download(
        {
          key: chapters.items[0]!.key,
          fileName: chapters.items[0]!.importFileName!,
          remoteRevision: chapters.items[0]!.remoteRevision,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ file: expect.objectContaining({ name: '원격 작품 - 제1화.cbz', size: 4 }) });
  });

  it('uses supported latest/search modes and maps extension filters into Suwayomi changes', async () => {
    const state = memoryState(await createExternalSourceCredentialKey());
    const browseInputs: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const { query, variables } = graphqlRequest(init);
      if (query.includes('MoyaSuwayomiServerInfo')) return json({ data: { aboutServer: { name: 'Suwayomi' } } });
      if (query.includes('MoyaSuwayomiSources')) return json({ data: { sources: { nodes: [installedSource] } } });
      if (query.includes('MoyaSuwayomiBrowse')) {
        browseInputs.push(variables.input as Record<string, unknown>);
        return json({ data: { fetchSourceManga: { mangas: [], hasNextPage: false } } });
      }
      return new Response(null, { status: 404 });
    });
    const broker = new SuwayomiSourceAccountBroker(CONNECTOR_ID, state, fetchImpl as typeof fetch);
    await broker.connect({ authMode: 'none' });
    const root = await broker.list({}, new AbortController().signal);
    const parentRef = root.items[0]!.navigationRef;

    const latest = await broker.list(
      {
        parentRef,
        browseMode: 'latest',
        filters: [
          { position: 0, value: 1 },
          { position: 1, groupPosition: 0, value: { index: 1, ascending: true } },
        ],
      },
      new AbortController().signal,
    );
    await broker.list(
      {
        parentRef,
        browseMode: 'search',
        filters: [
          { position: 0, value: 1 },
          { position: 1, groupPosition: 0, value: { index: 1, ascending: true } },
        ],
      },
      new AbortController().signal,
    );
    await broker.list({ parentRef, query: '검색어', browseMode: 'latest' }, new AbortController().signal);

    expect(latest.browse).toMatchObject({
      activeMode: 'latest',
      availableModes: ['popular', 'latest', 'search'],
      filters: [
        { kind: 'select', label: '장르', options: ['전체', '판타지'] },
        { kind: 'header', label: '정렬' },
        { kind: 'sort', label: '기준', options: ['인기', '업데이트'] },
      ],
    });
    expect(browseInputs).toEqual([
      expect.objectContaining({
        type: 'LATEST',
        filters: [
          { position: 0, selectState: 1 },
          { position: 1, groupChange: { position: 0, sortState: { index: 1, ascending: true } } },
        ],
      }),
      expect.objectContaining({
        type: 'SEARCH',
        filters: [
          { position: 0, selectState: 1 },
          { position: 1, groupChange: { position: 0, sortState: { index: 1, ascending: true } } },
        ],
      }),
      expect.objectContaining({ type: 'SEARCH', query: '검색어' }),
    ]);
  });

  it('stores UI-login tokens but never stores the submitted password, then refreshes once on auth expiry', async () => {
    const key = await createExternalSourceCredentialKey();
    const state = memoryState(key);
    let sourceRequests = 0;
    let refreshRequests = 0;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const { query } = graphqlRequest(init);
      if (query.includes('MoyaSuwayomiServerInfo'))
        return json({ data: { aboutServer: { name: 'Suwayomi', version: '2.0' } } });
      if (query.includes('MoyaSuwayomiLogin')) {
        expect(String(init?.body)).toContain('do-not-store-this');
        return json({ data: { login: { accessToken: 'access-1', refreshToken: 'refresh-1' } } });
      }
      if (query.includes('MoyaSuwayomiRefresh')) {
        refreshRequests += 1;
        return json({ data: { refreshToken: { accessToken: 'access-2' } } });
      }
      if (query.includes('MoyaSuwayomiSources')) {
        sourceRequests += 1;
        if (sourceRequests === 2) return json({ data: null, errors: [{ message: 'Unauthorized' }] });
        const expectedToken = sourceRequests === 1 ? 'Bearer access-1' : 'Bearer access-2';
        expect(new Headers(init?.headers).get('Authorization')).toBe(expectedToken);
        return json({ data: { sources: { nodes: [installedSource] } } });
      }
      return new Response(null, { status: 404 });
    });
    const broker = new SuwayomiSourceAccountBroker(CONNECTOR_ID, state, fetchImpl as typeof fetch);

    await broker.connect({
      baseUrl: 'http://127.0.0.1:4567',
      authMode: 'ui_login',
      username: 'reader',
      password: 'do-not-store-this',
    });
    const stored = state.credential();
    expect(stored).toBeDefined();
    const decrypted = await unsealExternalSourceCredential<Record<string, unknown>>(stored!.credentialEnvelope, key);
    expect(decrypted).toMatchObject({ authMode: 'ui_login', accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect(JSON.stringify(decrypted)).not.toContain('do-not-store-this');
    expect(JSON.stringify(decrypted)).not.toContain('reader');

    await expect(broker.list({}, new AbortController().signal)).resolves.toMatchObject({ items: [expect.anything()] });
    const refreshed = await unsealExternalSourceCredential<Record<string, unknown>>(
      state.credential()!.credentialEnvelope,
      key,
    );
    expect(refreshed.accessToken).toBe('access-2');
    expect(sourceRequests).toBe(3);
    await expect(broker.list({}, new AbortController().signal)).resolves.toMatchObject({ items: [expect.anything()] });
    expect(sourceRequests).toBe(4);
    expect(refreshRequests).toBe(1);
  });

  it.each([400, 404, 405, 500])(
    'falls back to fetched pages and packages a bounded CBZ when direct download returns HTTP %i',
    async (directStatus) => {
      const state = memoryState(await createExternalSourceCredentialKey());
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/chapter/73/download')) return new Response(null, { status: directStatus });
        if (url.includes('/page/0')) return new Response(jpeg, { headers: { 'Content-Type': 'image/jpg' } });
        const { query } = graphqlRequest(init);
        if (query.includes('MoyaSuwayomiServerInfo')) return json({ data: { aboutServer: { name: 'Suwayomi' } } });
        if (query.includes('MoyaSuwayomiSources')) return json({ data: { sources: { nodes: [installedSource] } } });
        if (query.includes('MoyaSuwayomiChapterPages')) {
          return json({
            data: {
              fetchChapterPages: { pages: ['/api/v1/manga/41/chapter/0/page/0'], chapter },
            },
          });
        }
        return new Response(null, { status: 404 });
      });
      const broker = new SuwayomiSourceAccountBroker(CONNECTOR_ID, state, fetchImpl as typeof fetch);
      await broker.connect({ authMode: 'none' });
      const downloaded = await broker.download(
        {
          key: {
            connectorId: CONNECTOR_ID,
            accountConnectionId: broker.status().accountConnectionId,
            remoteId: 'chapter:73',
          },
          fileName: '회차.cbz',
        },
        new AbortController().signal,
      );
      const zip = new ZipReader(new BlobReader(downloaded.file));
      const entries = await zip.getEntries();
      expect(entries.map((entry) => entry.filename)).toEqual(['ComicInfo.xml', '00001.jpg']);
      const comicInfo = await (entries[0] as FileEntry).getData!(new TextWriter());
      expect(comicInfo).toContain('<Title>제1화</Title>');
      await zip.close();
    },
  );

  it('projects authenticated source icons and work covers as revocable object URLs', async () => {
    const state = memoryState(await createExternalSourceCredentialKey());
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:source-icon')
      .mockReturnValueOnce('blob:work-cover');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/extension/icon/') || url.includes('/manga/41/thumbnail')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access-1');
        return new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) } });
      }
      const { query } = graphqlRequest(init);
      if (query.includes('MoyaSuwayomiLogin')) {
        return json({ data: { login: { accessToken: 'access-1', refreshToken: 'refresh-1' } } });
      }
      if (query.includes('MoyaSuwayomiServerInfo')) {
        return json({ data: { aboutServer: { name: 'Suwayomi', version: '2.0' } } });
      }
      if (query.includes('MoyaSuwayomiSources')) return json({ data: { sources: { nodes: [installedSource] } } });
      if (query.includes('MoyaSuwayomiBrowse')) {
        return json({ data: { fetchSourceManga: { mangas: [manga], hasNextPage: false } } });
      }
      return new Response(null, { status: 404 });
    });
    const broker = new SuwayomiSourceAccountBroker(CONNECTOR_ID, state, fetchImpl as typeof fetch);

    try {
      await broker.connect({ authMode: 'ui_login', username: 'reader', password: 'session-password' });
      const root = await broker.list({}, new AbortController().signal);
      expect(root.items[0]?.thumbnailUrl).toBe('blob:source-icon');
      const works = await broker.list({ parentRef: root.items[0]?.navigationRef }, new AbortController().signal);
      expect(works.items[0]?.thumbnailUrl).toBe('blob:work-cover');
      await broker.disconnect();
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:source-icon');
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:work-cover');
    } finally {
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
    }
  });

  it('auto-detects Basic auth before server info, keeps its password session-only and accepts negative source IDs', async () => {
    const key = await createExternalSourceCredentialKey();
    const state = memoryState(key);
    const basicSource = { ...installedSource, id: '-9223372036854775808' };
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('Authorization');
      if (authorization !== SUWAYOMI_BASIC_HEADER) return new Response(null, { status: 401 });
      const { query } = graphqlRequest(init);
      if (query.includes('MoyaSuwayomiServerInfo')) {
        return json({ data: { aboutServer: { name: 'Suwayomi Basic', version: '2.0' } } });
      }
      if (query.includes('MoyaSuwayomiSources')) return json({ data: { sources: { nodes: [basicSource] } } });
      return new Response(null, { status: 404 });
    });
    const broker = new SuwayomiSourceAccountBroker(CONNECTOR_ID, state, fetchImpl as typeof fetch);

    await broker.connect({ authMode: 'auto', username: 'reader', password: 'session-password' });
    expect(broker.status()).toMatchObject({ state: 'connected', label: 'Suwayomi Basic 2.0' });
    const page = await broker.list({}, new AbortController().signal);
    expect(page.items[0]).toMatchObject({
      navigationRef: 'source:-9223372036854775808',
      thumbnailUrl: undefined,
    });
    const decrypted = await unsealExternalSourceCredential<Record<string, unknown>>(
      state.credential()!.credentialEnvelope,
      key,
    );
    expect(decrypted.authMode).toBe('basic_auth');
    expect(JSON.stringify(decrypted)).not.toContain('session-password');

    const restored = new SuwayomiSourceAccountBroker(CONNECTOR_ID, state, fetchImpl as typeof fetch);
    await restored.initialize();
    expect(restored.status().state).toBe('reauthorization_required');
  });

  it('does not expose a remote GraphQL error body to callers', async () => {
    const state = memoryState(await createExternalSourceCredentialKey());
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const { query } = graphqlRequest(init);
      if (query.includes('MoyaSuwayomiServerInfo')) return json({ data: { aboutServer: { name: 'Suwayomi' } } });
      return json({ data: null, errors: [{ message: 'provider secret raw-body-123' }] });
    });
    const broker = new SuwayomiSourceAccountBroker(CONNECTOR_ID, state, fetchImpl as typeof fetch);

    await expect(broker.connect({ authMode: 'none' })).rejects.toThrow('Suwayomi 서버가 요청을 처리하지 못했습니다.');
    await expect(broker.connect({ authMode: 'none' })).rejects.not.toThrow(/raw-body-123|provider secret/);
  });
});
