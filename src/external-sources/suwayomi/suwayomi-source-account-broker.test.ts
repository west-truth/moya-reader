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

  it('falls back to fetched pages and packages a bounded CBZ when the direct download route is unavailable', async () => {
    const state = memoryState(await createExternalSourceCredentialKey());
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/chapter/73/download')) return new Response(null, { status: 404 });
      if (url.includes('/page/0')) return new Response(png, { headers: { 'Content-Type': 'image/png' } });
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
    expect(entries.map((entry) => entry.filename)).toEqual(['ComicInfo.xml', '00001.png']);
    const comicInfo = await (entries[0] as FileEntry).getData!(new TextWriter());
    expect(comicInfo).toContain('<Title>제1화</Title>');
    await zip.close();
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
