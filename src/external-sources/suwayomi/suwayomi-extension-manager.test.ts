import { describe, expect, it, vi } from 'vitest';
import { SuwayomiGraphqlClient } from './suwayomi-graphql-client';
import { SuwayomiExtensionManager, suwayomiRepositoryUrl } from './suwayomi-extension-manager';
import { validateRepositoryIndex } from '../../extensions/packages/repository-contract';

const index = 'https://catalog.example/index.min.json';
const entry = {
  pkgName: 'org.example.manga',
  name: 'Example Manga',
  lang: 'ko',
  versionName: '1.2',
  isInstalled: false,
  hasUpdate: false,
  isObsolete: false,
  repo: index,
  storeIndexUrl: 'https://catalog.example/repo.json',
};
function fixture(modern = true, pageLimit = 500) {
  let repositories = ['https://existing.example/index.min.json'];
  let rows = [{ ...entry }, { ...entry, pkgName: 'org.example.novel', name: 'Example Novel' }];
  let connected = true;
  let failMutation = false;
  const calls: {
    query: string;
    variables: {
      offset?: number;
      input: { id: string; indexUrl: string; settings: { extensionRepos: string[] }; patch: Record<string, boolean> };
    };
  }[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    calls.push({ query, variables });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-session');
    const payload = (data: unknown) => new Response(JSON.stringify({ data }));
    if (query.includes('MoyaExtensionApi')) return payload({ __type: modern ? { name: 'ExtensionStoreType' } : null });
    if (query.includes('MoyaExtensionStores'))
      return payload({
        extensionStores: {
          nodes: repositories.map((indexUrl) => ({ indexUrl, name: indexUrl })),
          totalCount: repositories.length,
        },
      });
    if (query.includes('MoyaExtensionRepos')) return payload({ settings: { extensionRepos: repositories } });
    if (query.includes('MoyaExtensions('))
      return payload({
        extensions: { nodes: rows.slice(variables.offset, variables.offset + pageLimit), totalCount: rows.length },
      });
    if (query.includes('MoyaExtensionState'))
      return payload({ extension: rows.find((row) => row.pkgName === variables.id) ?? null });
    if (failMutation) return new Response(JSON.stringify({ errors: [{ message: 'Failed mutation' }] }));
    if (query.includes('MoyaEditExtensionStore')) {
      const add = query.includes('addExtensionStore');
      if (add) repositories.push(variables.input.indexUrl.replace('/index.min.json', '/repo.json'));
      else repositories = repositories.filter((url) => url !== variables.input.indexUrl);
      return payload({ [add ? 'addExtensionStore' : 'removeExtensionStore']: { clientMutationId: null } });
    }
    if (query.includes('MoyaEditExtensionRepos')) {
      repositories = variables.input.settings.extensionRepos;
      return payload({ setSettings: { settings: { extensionRepos: repositories } } });
    }
    if (query.includes('MoyaFetchExtensions')) return payload({ fetchExtensions: { clientMutationId: null } });
    if (query.includes('MoyaChangeExtension')) {
      const row = rows.find((item) => item.pkgName === variables.input.id)!;
      row.isInstalled = !variables.input.patch.uninstall;
      row.hasUpdate = false;
      return payload({ updateExtension: { extension: row } });
    }
    throw new Error(query);
  });
  const client = new SuwayomiGraphqlClient(
    'https://server.example',
    fetchImpl,
    () => ({ mode: 'ui_login', accessToken: 'private-session' }),
    async () => {},
  );
  const changed = vi.fn(async () => {});
  const manager = new SuwayomiExtensionManager(client, () => connected, changed);
  return {
    manager,
    calls,
    changed,
    fetchImpl,
    disconnect: () => {
      connected = false;
    },
    fail: () => {
      failMutation = true;
    },
    setRows: (value: typeof rows) => {
      rows = value;
    },
  };
}
const signal = () => new AbortController().signal;

describe('Suwayomi repository management', () => {
  it.each([true, false])(
    'preserves multiple repositories and removes only the chosen one (modern=%s)',
    async (modern) => {
      const f = fixture(modern);
      await f.manager.addRepository(index, signal());
      await f.manager.addRepository('https://second.example/index.min.json', signal());
      const saved = (await f.manager.list(signal())).repositories;
      expect(saved).toHaveLength(3);
      expect(saved[0].url).toBe('https://existing.example/index.min.json');
      await f.manager.addRepository(index, signal());
      expect((await f.manager.list(signal())).repositories).toHaveLength(3);
      await f.manager.removeRepository(index, signal());
      const remaining = (await f.manager.list(signal())).repositories;
      expect(remaining).toHaveLength(2);
      expect(remaining[0].url).toBe(saved[0].url);
      if (!modern) {
        const write = f.calls.find((call) => call.query.includes('MoyaEditExtensionRepos'))!;
        expect(write.variables.input.settings).toEqual({
          extensionRepos: ['https://existing.example/index.min.json', index],
        });
      }
    },
  );
  it('includes novel-labelled image sources in paginated lists and installation', async () => {
    const f = fixture();
    f.setRows(
      Array.from({ length: 502 }, (_, i) => ({ ...entry, pkgName: `org.example.manga${i}` })).concat({
        ...entry,
        pkgName: 'org.example.novel',
        name: 'Novel',
      }),
    );
    const value = await f.manager.list(signal());
    expect(value.extensions).toHaveLength(503);
    expect(value.excludedCount).toBe(0);
    expect(
      f.calls.filter((call) => call.query.includes('MoyaExtensions(')).map((call) => call.variables.offset),
    ).toEqual([0, 500]);
    await f.manager.change('org.example.novel', 'install', signal());
    expect((await f.manager.list(signal())).extensions.find((row) => row.id === 'org.example.novel')?.installed).toBe(
      true,
    );
  });
  it('installs, updates and uninstalls through the authenticated server and invalidates source cache', async () => {
    const f = fixture();
    await f.manager.refresh(signal());
    await f.manager.change(entry.pkgName, 'install', signal());
    expect((await f.manager.list(signal())).extensions[0].installed).toBe(true);
    f.setRows([{ ...entry, isInstalled: true, hasUpdate: true }]);
    await f.manager.change(entry.pkgName, 'update', signal());
    await f.manager.change(entry.pkgName, 'uninstall', signal());
    expect(f.changed).toHaveBeenCalledTimes(3);
    expect(
      f.calls.filter((call) => call.query.includes('MoyaChangeExtension')).map((call) => call.variables.input.patch),
    ).toEqual([{ install: true }, { update: true }, { uninstall: true }]);
  });
  it('does not skip rows when the upstream applies a smaller page size', async () => {
    const f = fixture(true, 2);
    f.setRows(Array.from({ length: 5 }, (_, i) => ({ ...entry, pkgName: `org.example.manga${i}` })));
    expect((await f.manager.list(signal())).extensions.map((row) => row.id)).toEqual(
      Array.from({ length: 5 }, (_, i) => `org.example.manga${i}`),
    );
    expect(
      f.calls.filter((call) => call.query.includes('MoyaExtensions(')).map((call) => call.variables.offset),
    ).toEqual([0, 2, 4]);
  });
  it('never retries a failed modern mutation by overwriting legacy settings', async () => {
    const f = fixture();
    f.fail();
    await expect(f.manager.addRepository(index, signal())).rejects.toThrow();
    expect(f.calls.filter((call) => call.query.startsWith('mutation'))).toHaveLength(1);
    expect(f.calls.some((call) => call.query.includes('MoyaEditExtensionRepos'))).toBe(false);
  });
  it('rejects old-connection operations and cancelled operations without requesting the server', async () => {
    const f = fixture();
    f.disconnect();
    await expect(f.manager.list(signal())).rejects.toThrow('연결이 변경');
    const abort = new AbortController();
    abort.abort();
    await expect(f.manager.addRepository(index, abort.signal)).rejects.toThrow();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('discards a response arriving after the server connection changes', async () => {
    const f = fixture();
    let finish!: (response: Response) => void;
    f.fetchImpl.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const result = f.manager.list(signal());
    f.disconnect();
    finish(new Response(JSON.stringify({ data: { __type: { name: 'ExtensionStoreType' } } })));
    await expect(result).rejects.toThrow('연결이 변경');
    expect(f.calls).toHaveLength(0);
  });
  it('does not overlap repository mutations while another server operation is pending', async () => {
    const f = fixture();
    await f.manager.list(signal());
    let finish!: (response: Response) => void;
    f.fetchImpl.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = f.manager.refresh(signal());
    await expect(f.manager.addRepository(index, signal())).rejects.toThrow('다른 확장 작업');
    finish(new Response(JSON.stringify({ data: { fetchExtensions: { clientMutationId: null } } })));
    await refresh;
    expect(f.calls.some((call) => call.query.includes('MoyaEditExtension'))).toBe(false);
  });
  it('rejects obsolete installs and stale update requests', async () => {
    const f = fixture();
    f.setRows([{ ...entry, isObsolete: true }]);
    await expect(f.manager.change(entry.pkgName, 'install', signal())).rejects.toThrow();
    await expect(f.manager.change(entry.pkgName, 'update', signal())).rejects.toThrow();
    expect(f.changed).not.toHaveBeenCalled();
  });
  it('recognizes APK indexes without allowing them into the JS package runtime', () => {
    expect(() => validateRepositoryIndex([{ pkg: entry.pkgName, apk: 'example.apk', sources: [] }], index)).toThrow(
      'package_repository_suwayomi',
    );
    expect(() => validateRepositoryIndex([], index)).toThrow('invalid_package_repository');
    expect(suwayomiRepositoryUrl('https://catalog.example')).toBe(index);
    for (const url of ['http://catalog.example', 'https://secret@catalog.example', 'https://catalog.example/#hash'])
      expect(() => suwayomiRepositoryUrl(url)).toThrow();
  });
});
