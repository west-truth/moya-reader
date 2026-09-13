import type { SourceExtensionEntry, SourceExtensionInventory, SourceExtensionManager } from '../extension-management';
import type { SuwayomiGraphqlClient } from './suwayomi-graphql-client';

const fields = 'pkgName name lang versionName isInstalled hasUpdate isObsolete';
interface ExtensionRow {
  pkgName: string;
  name: string;
  lang: string;
  versionName: string;
  isInstalled: boolean;
  hasUpdate: boolean;
  isObsolete: boolean;
  repo?: string;
  storeIndexUrl?: string;
}

export function suwayomiRepositoryUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error();
    if (!/\/(?:index\.min|repo)\.json$/.test(url.pathname))
      url.pathname = url.pathname.replace(/\/$/, '') + '/index.min.json';
    return url.href;
  } catch {
    throw new Error('HTTPS 저장소 주소를 입력해 주세요.');
  }
}
function legacyBase(url: string) {
  return url.replace(/\/(?:index\.min|repo)\.json$/, '').replace(/\/$/, '');
}
function rowEntry(row: ExtensionRow): SourceExtensionEntry {
  return {
    id: row.pkgName,
    name: row.name,
    lang: row.lang,
    version: row.versionName,
    repository: row.storeIndexUrl || row.repo,
    installed: row.isInstalled,
    hasUpdate: row.hasUpdate,
    obsolete: row.isObsolete,
  };
}

/** Every instance is tied to one authenticated connection. Never retry a failed mutation on another API. */
export class SuwayomiExtensionManager implements SourceExtensionManager {
  private modern?: boolean;
  private busy = false;
  constructor(
    private readonly client: SuwayomiGraphqlClient,
    private readonly isCurrent: () => boolean,
    private readonly changed: () => Promise<void>,
  ) {}
  private async query<T>(document: string, variables: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.isCurrent()) throw new Error('Suwayomi 연결이 변경됐습니다. 설정을 다시 열어 주세요.');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 120000);
    try {
      const value = await this.client.graphql<T>(document, variables, abort.signal);
      abort.signal.throwIfAborted();
      if (!this.isCurrent()) throw new Error('Suwayomi 연결이 변경됐습니다. 설정을 다시 열어 주세요.');
      return value;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    }
  }
  private async mode(signal: AbortSignal): Promise<boolean> {
    if (this.modern !== undefined) return this.modern;
    const value = await this.query<{ __type: { name: string } | null }>(
      'query MoyaExtensionApi { __type(name: "ExtensionStoreType") { name } }',
      {},
      signal,
    );
    if (!Object.prototype.hasOwnProperty.call(value, '__type'))
      throw new Error('Suwayomi 확장 관리 API를 확인하지 못했습니다.');
    return (this.modern = value.__type !== null);
  }
  private async repos(signal: AbortSignal) {
    if (await this.mode(signal)) {
      const value = await this.query<{
        extensionStores: { nodes: { indexUrl: string; name: string }[]; totalCount: number };
      }>(
        'query MoyaExtensionStores { extensionStores(first: 1000) { nodes { indexUrl name } totalCount } }',
        {},
        signal,
      );
      if (value.extensionStores.totalCount > value.extensionStores.nodes.length)
        throw new Error('저장소가 너무 많아 전체 목록을 확인하지 못했습니다.');
      return value.extensionStores.nodes.map((row) => ({ url: row.indexUrl, name: row.name }));
    }
    const value = await this.query<{ settings: { extensionRepos: string[] } }>(
      'query MoyaExtensionRepos { settings { extensionRepos } }',
      {},
      signal,
    );
    return value.settings.extensionRepos.map((url) => ({ url, name: url }));
  }
  async list(signal: AbortSignal): Promise<SourceExtensionInventory> {
    const modern = await this.mode(signal);
    const repositories = await this.repos(signal);
    const rows: ExtensionRow[] = [];
    for (let offset = 0; offset < 20000;) {
      const data = await this.query<{ extensions: { nodes: ExtensionRow[]; totalCount: number } }>(
        `query MoyaExtensions($offset: Int!) { extensions(first: 500, offset: $offset) { nodes { ${fields} ${modern ? 'storeIndexUrl' : 'repo'} } totalCount } }`,
        { offset },
        signal,
      );
      rows.push(...data.extensions.nodes);
      if (rows.length >= data.extensions.totalCount) {
        return {
          repositories,
          extensions: rows.map(rowEntry),
          excludedCount: 0,
        };
      }
      if (!data.extensions.nodes.length) break;
      offset += data.extensions.nodes.length;
    }
    throw new Error('확장 목록을 모두 읽지 못했습니다. 다시 확인해 주세요.');
  }
  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('다른 확장 작업이 끝난 뒤 다시 시도해 주세요.');
    this.busy = true;
    try {
      return await task();
    } finally {
      this.busy = false;
    }
  }
  async refresh(signal: AbortSignal) {
    return this.exclusive(async () => {
      const result = await this.query<{ fetchExtensions: unknown }>(
        'mutation MoyaFetchExtensions { fetchExtensions(input: {}) { clientMutationId } }',
        {},
        signal,
      );
      if (!result.fetchExtensions) throw new Error('저장소 갱신을 완료하지 못했습니다.');
      return this.list(signal);
    });
  }
  private async editRepository(url: string, add: boolean, signal: AbortSignal) {
    return this.exclusive(async () => {
      const normalized = suwayomiRepositoryUrl(url);
      const modern = await this.mode(signal);
      const current = await this.repos(signal);
      const existing = current.find((entry) => legacyBase(entry.url) === legacyBase(normalized));
      if (add && existing) return;
      if (!add && !existing) throw new Error('저장소 목록이 변경됐습니다. 새로고침해 주세요.');
      if (add && current.length >= 16) throw new Error('저장소는 최대 16개까지 추가할 수 있습니다.');
      if (modern) {
        const operation = add ? 'addExtensionStore' : 'removeExtensionStore';
        const input = add ? 'AddExtensionStoreInput' : 'RemoveExtensionStoreInput';
        const result = await this.query<Record<string, unknown>>(
          `mutation MoyaEditExtensionStore($input: ${input}!) { ${operation}(input: $input) { clientMutationId } }`,
          { input: { indexUrl: add ? normalized : existing!.url } },
          signal,
        );
        if (!result[operation]) throw new Error('저장소 변경을 완료하지 못했습니다.');
      } else {
        // Read immediately before writing; preserve every other configured repository verbatim.
        const urls = add
          ? [...current.map((entry) => entry.url), normalized.replace(/\/repo\.json$/, '/index.min.json')]
          : current.filter((entry) => entry.url !== existing!.url).map((entry) => entry.url);
        const result = await this.query<{ setSettings: unknown }>(
          'mutation MoyaEditExtensionRepos($input: SetSettingsInput!) { setSettings(input: $input) { settings { extensionRepos } } }',
          { input: { settings: { extensionRepos: urls } } },
          signal,
        );
        if (!result.setSettings) throw new Error('저장소 변경을 완료하지 못했습니다.');
      }
    });
  }
  addRepository(url: string, signal: AbortSignal) {
    return this.editRepository(url, true, signal);
  }
  removeRepository(url: string, signal: AbortSignal) {
    return this.editRepository(url, false, signal);
  }
  async change(id: string, action: 'install' | 'update' | 'uninstall', signal: AbortSignal) {
    return this.exclusive(async () => {
      if (!['install', 'update', 'uninstall'].includes(action)) throw new Error('지원하지 않는 확장 작업입니다.');
      const current = await this.query<{ extension: ExtensionRow | null }>(
        `query MoyaExtensionState($id: String!) { extension(pkgName: $id) { ${fields} } }`,
        { id },
        signal,
      );
      const row = current.extension ? rowEntry(current.extension) : undefined;
      if (
        !row ||
        (action === 'install' && (row.installed || row.obsolete)) ||
        (action === 'update' && (!row.installed || !row.hasUpdate || row.obsolete)) ||
        (action === 'uninstall' && !row.installed)
      )
        throw new Error('확장 상태가 변경됐습니다. 목록을 새로고침해 주세요.');
      const result = await this.query<{ updateExtension: { extension: ExtensionRow | null } | null }>(
        `mutation MoyaChangeExtension($input: UpdateExtensionInput!) { updateExtension(input: $input) { extension { ${fields} } } }`,
        { input: { id, patch: { [action]: true } } },
        signal,
      );
      const extension = result.updateExtension?.extension;
      if (
        !result.updateExtension ||
        (action === 'uninstall'
          ? extension?.isInstalled
          : !extension?.isInstalled || (action === 'update' && extension.hasUpdate))
      )
        throw new Error('확장 작업 결과를 확인하지 못했습니다. 새로고침 후 상태를 확인해 주세요.');
      await this.changed();
    });
  }
}
