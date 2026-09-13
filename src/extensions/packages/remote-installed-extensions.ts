import { compatibilityFileUpload } from './compatibility-file';
import type {
  ContentConnectionRequest,
  ContentConnectionStatus,
} from '../../../packages/extension-contracts/source-content-service';
import { SOURCE_DOWNLOAD_TIMEOUT_MS } from '../../../packages/extension-runtime/content-limits.mjs';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { RepositoryRecord } from './repository-contract';
import type { SourceAuthenticationRequest, SourceAuthenticationStatus } from '@noveldesk/extension-contracts/package';
import type {
  ExternalItemKey,
  ExternalItemPage,
  ExternalSourceDownloadRef,
  ExternalSourceListInput,
  TrustedExternalSourceHostContext,
} from '../../external-sources/contracts';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import { translatePackageOperationError } from './package-operation-error';
import type {
  InstalledExtensionManager,
  InstalledExtensionsSnapshot,
  PackageReview,
} from './installed-extension-manager';
type Inventory = Pick<InstalledExtensionsSnapshot, 'packages' | 'sources' | 'errors'> & {
  preparedImageImports?: boolean;
  preparedDocumentImports?: boolean;
};
const EMPTY: InstalledExtensionsSnapshot = { revision: 0, available: false, packages: [], sources: [], errors: [] };

/** Reuses the authenticated API client and existing source coordinator. No periodic polling. */
export class RemoteInstalledExtensions implements InstalledExtensionManager {
  readonly apk: import('./apk-extension-manager').ApkExtensionManager;
  readonly mangayomi: import('./apk-extension-manager').ApkExtensionManager;
  readonly target = 'server' as const;
  private preparedImageImports = false;
  private preparedDocumentImports = false;
  getHostedDocumentImport(
    id: ExtensionContributionId,
  ): import('../../services/import/hosted-document-import').HostedDocumentImportPort | undefined {
    if (!this.preparedDocumentImports || !this.getExternalSources().some((source) => source.descriptor.id === id))
      return undefined;
    const prefix = `/extensions/sources/${encodeURIComponent(id)}/prepared-documents`;
    return {
      download: (ref, signal) =>
        this.api.request(prefix, { method: 'POST', body: JSON.stringify(ref), signal }, SOURCE_DOWNLOAD_TIMEOUT_MS),
      assemble: async (input, signal) => {
        try {
          return await this.api.request(
            `${prefix}/assemble`,
            { method: 'POST', body: JSON.stringify(input), signal },
            SOURCE_DOWNLOAD_TIMEOUT_MS,
          );
        } catch (error) {
          if (error instanceof Error && error.message.includes('import_expected_base_conflict'))
            throw Object.assign(new Error('작품이 다른 작업에서 변경되었습니다. 최신 목록에서 다시 시도해 주세요.'), {
              name: 'ContentRevisionConflictError',
            });
          throw error;
        }
      },
      discard: async (id) => {
        await this.api.request(`${prefix}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      },
      cancelPrepared: async (id) => {
        await this.api.request(`/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });
      },
    };
  }
  getHostedImageImport(
    id: ExtensionContributionId,
  ): import('../../services/import/hosted-image-import').HostedImageImportPort | undefined {
    if (!this.preparedImageImports) return undefined;
    if (!this.getExternalSources().some((source) => source.descriptor.id === id)) return undefined;
    const prefix = `/extensions/sources/${encodeURIComponent(id)}/prepared-images`;
    return {
      download: (ref, signal) =>
        this.api.request(prefix, { method: 'POST', body: JSON.stringify(ref), signal }, SOURCE_DOWNLOAD_TIMEOUT_MS),
      assemble: (input, signal) =>
        this.api.request(
          `${prefix}/assemble`,
          { method: 'POST', body: JSON.stringify(input), signal },
          SOURCE_DOWNLOAD_TIMEOUT_MS,
        ),
      discard: async (artifactId) => {
        await this.api.request(`${prefix}/${encodeURIComponent(artifactId)}`, { method: 'DELETE' });
      },
    };
  }
  private snapshot: InstalledExtensionsSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private pending?: Promise<void>;
  private covers = new Map<string, string>();
  constructor(private readonly api: Pick<RemoteApiClient, 'request' | 'requestBlob'>) {
    this.mangayomi = this.compatibilityManager('/mangayomi-extensions');
    const action = async (name: string, body: unknown, signal?: AbortSignal) =>
      this.api.request(`/apk-extensions/${name}`, { method: 'POST', body: JSON.stringify(body), signal }, 120000);
    this.apk = {
      preferences: (pkg) =>
        this.api.request('/apk-extensions/preferences', {
          method: 'POST',
          body: JSON.stringify({ pkg }),
        }),
      savePreferences: async (pkg, revision, values, privateOrigins) => {
        await action('preferences-save', { pkg, revision, values, privateOrigins });
        await this.refresh();
      },
      list: () => this.api.request('/apk-extensions'),
      discardReview: async (id) => {
        await action('discard', { id });
      },
      refreshRepository: async (url, signal) => {
        await action('repository-refresh', { url }, signal);
      },
      removeRepository: async (url) => {
        await action('repository-remove', { url });
      },
      inspectFile: async (file, signal, sourceIndex) =>
        this.api.request(
          '/apk-extensions/inspect-file',
          { method: 'POST', body: JSON.stringify(await compatibilityFileUpload(file, sourceIndex)), signal },
          120000,
        ),
      inspectRepository: (url, pkg, code, signal) =>
        this.api.request(
          '/apk-extensions/inspect',
          { method: 'POST', body: JSON.stringify({ url, pkg, code }), signal },
          120000,
        ),
      install: async (review, signal) => {
        await action('install', { id: review.id, revision: review.revision, trusted: true }, signal);
        await this.refresh();
      },
      change: async (pkg, revision, change) => {
        await action('change', { pkg, revision, action: change });
        await this.refresh();
      },
    };
  }
  private compatibilityManager(prefix: string): import('./apk-extension-manager').ApkExtensionManager {
    const action = async (name: string, body: unknown, signal?: AbortSignal) =>
      this.api.request(prefix + '/' + name, { method: 'POST', body: JSON.stringify(body), signal }, 150000);
    return {
      list: () => this.api.request(prefix),
      discardReview: async (id) => {
        await action('discard', { id });
      },
      refreshRepository: async (url, signal) => {
        await action('repository-refresh', { url }, signal);
      },
      removeRepository: async (url) => {
        await action('repository-remove', { url });
      },
      inspectFile: async (file, signal, sourceIndex) =>
        this.api.request(
          prefix + '/inspect-file',
          { method: 'POST', body: JSON.stringify(await compatibilityFileUpload(file, sourceIndex)), signal },
          30000,
        ),
      inspectRepository: (url, pkg, code, signal) =>
        this.api.request(
          prefix + '/inspect',
          { method: 'POST', body: JSON.stringify({ url, pkg, code }), signal },
          30000,
        ),
      install: async (review, signal) => {
        await action('install', { id: review.id, revision: review.revision, trusted: true }, signal);
        await this.refresh();
      },
      change: async (pkg, revision, change) => {
        await action('change', { pkg, revision, action: change });
        await this.refresh();
      },
      preferences: (pkg) =>
        this.api.request(prefix + '/preferences', { method: 'POST', body: JSON.stringify({ pkg }) }),
      savePreferences: async (pkg, revision, values, privateOrigins) => {
        await action('preferences-save', { pkg, revision, values, privateOrigins });
        await this.refresh();
      },
    };
  }
  releaseCovers() {
    for (const url of this.covers.values()) URL.revokeObjectURL(url);
    this.covers.clear();
  }
  getSnapshot = () => this.snapshot;
  listRepositories = (): Promise<readonly RepositoryRecord[]> => this.api.request('/extensions/repositories');
  refreshRepository = (url: string, signal?: AbortSignal): Promise<RepositoryRecord> =>
    this.api.request(
      '/extensions/repositories/refresh',
      { method: 'POST', body: JSON.stringify({ url }), signal },
      30000,
    );
  async removeRepository(url: string, revision: number) {
    await this.api.request('/extensions/repositories/remove', {
      method: 'POST',
      body: JSON.stringify({ url, revision }),
    });
  }
  async selectRepositoryPackage(url: string, id: string, sha256: string, signal?: AbortSignal) {
    const result = await this.api.requestBlob('/extensions/repositories/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, id, sha256 }),
      signal,
    });
    const file = new File([result.blob], 'repository.moyaext');
    const plan = await this.inspect(file, signal);
    if (plan.publisherChanged) throw new Error('package_update_publisher_mismatch');
    return { file, plan };
  }
  async checkUpdate(id: string, revision: number, signal?: AbortSignal) {
    const result = await this.api.requestBlob(`/extensions/packages/${encodeURIComponent(id)}/update`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
      headers: { 'Content-Type': 'application/json' },
      signal,
    });
    if (result.status === 204) return undefined;
    const file = new File([result.blob], 'update.moyaext');
    const plan = await this.inspect(file, signal);
    if (plan.expectedRevision !== revision) throw new Error('package_install_conflict');
    return { file, plan };
  }
  contentConnection = (
    id: string,
    request: ContentConnectionRequest,
    signal?: AbortSignal,
  ): Promise<ContentConnectionStatus> =>
    this.api.request(
      `/extensions/sources/${encodeURIComponent(id)}/content-connection`,
      { method: 'POST', body: JSON.stringify(request), signal },
      30000,
    );
  preferences = (
    id: string,
    request: import('../../../packages/extension-contracts/source-preferences').SourcePreferencesRequest,
    signal?: AbortSignal,
  ): Promise<import('./compatibility-preferences').CompatibilityPreferences> =>
    this.api.request(
      `/extensions/sources/${encodeURIComponent(id)}/preferences`,
      { method: 'POST', body: JSON.stringify(request), signal },
      30000,
    );
  authenticate = (
    id: string,
    request: SourceAuthenticationRequest,
    signal?: AbortSignal,
  ): Promise<SourceAuthenticationStatus> =>
    this.api.request(
      `/extensions/sources/${encodeURIComponent(id)}/authentication`,
      { method: 'POST', body: JSON.stringify(request), signal },
      30000,
    );
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: Omit<InstalledExtensionsSnapshot, 'revision'>) {
    const { revision, ...previous } = this.snapshot;
    if (JSON.stringify(previous) === JSON.stringify(value)) return;
    this.snapshot = { ...value, revision: revision + 1 };
    if (
      JSON.stringify(previous.sources) !== JSON.stringify(value.sources) ||
      JSON.stringify(previous.packages) !== JSON.stringify(value.packages)
    )
      this.releaseCovers();
    for (const listener of this.listeners) listener();
  }
  refresh = (): Promise<void> => {
    if (this.pending) return this.pending;
    this.pending = this.api
      .request<Inventory>('/extensions/packages')
      .then((value) => {
        if (!value || !Array.isArray(value.packages) || !Array.isArray(value.sources) || !Array.isArray(value.errors))
          throw new Error('invalid_inventory');
        this.preparedImageImports = value.preparedImageImports === true;
        this.preparedDocumentImports = value.preparedDocumentImports === true;
        this.publish({ ...value, available: true });
      })
      .catch(() => {
        // An older/unreachable server must not break built-in sources or log the user out for a source failure.
        const { revision: _revision, ...previous } = this.snapshot;
        this.publish({
          ...previous,
          error: '서버의 확장 기능을 확인할 수 없습니다. 서버 버전과 연결을 확인해 주세요.',
        });
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  };
  async inspect(file: File, signal?: AbortSignal): Promise<PackageReview> {
    if (!file.name.toLowerCase().endsWith('.moyaext') || file.size > 10 * 1024 * 1024)
      throw new Error('10 MiB 이하의 .moyaext 파일을 선택해 주세요.');
    return this.api.request('/extensions/packages/inspect', {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
      signal,
    });
  }
  async install(file: File, review: PackageReview): Promise<void> {
    const query = new URLSearchParams({ digest: review.package.digest, revision: String(review.expectedRevision) });
    if (review.publisherChanged) query.set('publisherChange', '1');
    if (review.downgrade) query.set('downgrade', '1');
    await this.api.request(
      `/extensions/packages/install?${query}`,
      { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } },
      60000,
    );
    await this.pending;
    await this.refresh();
  }
  async change(id: string, revision: number, action: 'enable' | 'disable' | 'rollback' | 'remove'): Promise<void> {
    await this.api.request(
      `/extensions/packages/${encodeURIComponent(id)}/change`,
      { method: 'POST', body: JSON.stringify({ revision, action }) },
      60000,
    );
    await this.pending;
    await this.refresh();
  }
  getExternalSources() {
    return this.snapshot.sources;
  }
  private owner(id: string) {
    return this.snapshot.packages.find(
      (pkg) =>
        pkg.enabled && pkg.active?.manifest.extension.contributes?.externalSources?.some((source) => source.id === id),
    );
  }
  getExternalSourceStatus(id: string) {
    const apk = this.snapshot.sources.find(
      (source) => source.descriptor.id === id && (source.apkPackageId || source.mangayomiPackageId),
    );
    if (apk) return { state: 'connected' as const, connectionGeneration: apk.generation };
    const owner = this.owner(id);
    return owner && this.snapshot.sources.some((source) => source.descriptor.id === id)
      ? {
          state: 'connected' as const,
          connectionGeneration: `${owner.revision}:${owner.active!.digest}`,
        }
      : { state: 'unavailable' as const, reason: '확장 설정에서 상태를 확인해 주세요.' };
  }
  async connectExternalSource(id: ExtensionContributionId) {
    if (
      this.snapshot.sources.some(
        (source) => source.descriptor.id === id && (source.apkPackageId || source.mangayomiPackageId),
      )
    )
      return;
    if (!this.owner(id)) throw new Error('확장을 먼저 켜 주세요.');
  }
  async disconnectExternalSource(id: ExtensionContributionId) {
    const mg = this.snapshot.sources.find((source) => source.descriptor.id === id && source.mangayomiPackageId);
    if (mg?.mangayomiPackageId) {
      const inventory = await this.mangayomi.list();
      await this.mangayomi.change(mg.mangayomiPackageId, inventory.revision, 'disable');
      return;
    }
    const apk = this.snapshot.sources.find((source) => source.descriptor.id === id && source.apkPackageId);
    if (apk?.apkPackageId) {
      const inventory = await this.apk.list();
      await this.apk.change(apk.apkPackageId, inventory.revision, 'disable');
      return;
    }
    const owner = this.owner(id);
    if (owner) await this.change(owner.id, owner.revision, 'disable');
  }
  async listExternalSource(
    id: ExtensionContributionId,
    _context: TrustedExternalSourceHostContext,
    input: ExternalSourceListInput,
    signal: AbortSignal,
  ): Promise<ExternalItemPage> {
    return this.api
      .request<ExternalItemPage>(
        `/extensions/sources/${encodeURIComponent(id)}/list`,
        { method: 'POST', body: JSON.stringify(input), signal },
        input.parentRef ? 11 * 60_000 : 60000,
      )
      .catch(translatePackageOperationError);
  }
  async downloadExternalSource(
    id: ExtensionContributionId,
    _context: TrustedExternalSourceHostContext,
    ref: ExternalSourceDownloadRef,
    signal: AbortSignal,
  ) {
    const { blob } = await this.api
      .requestBlob(
        `/extensions/sources/${encodeURIComponent(id)}/download`,
        {
          method: 'POST',
          body: JSON.stringify(ref),
          headers: { 'Content-Type': 'application/json' },
          signal,
        },
        this.snapshot.sources.some(
          (source) => source.descriptor.id === id && (source.mangayomiPackageId || source.apkPackageId),
        )
          ? SOURCE_DOWNLOAD_TIMEOUT_MS
          : 150000,
      )
      .catch(translatePackageOperationError);
    const file = new File([blob], ref.fileName, { type: blob.type });
    const descriptor = this.snapshot.sources.find((source) => source.descriptor.id === id)?.descriptor;
    if (descriptor?.schemaVersion !== 2 || !descriptor.seriesProfile) throw new Error('package_source_unavailable');
    return descriptor.seriesProfile.kind === 'document_series'
      ? {
          content: {
            kind: 'document' as const,
            file,
            format: 'txt' as const,
            encoding: 'utf-8' as const,
            chapterSplitMode: 'single' as const,
          },
          remoteRevision: ref.remoteRevision,
        }
      : {
          content: { kind: 'image_archive' as const, file, format: 'cbz' as const },
          remoteRevision: ref.remoteRevision,
        };
  }
  async resolveExternalSourceCover(
    id: ExtensionContributionId,
    _context: TrustedExternalSourceHostContext,
    key: ExternalItemKey,
    signal: AbortSignal,
  ) {
    const generation = this.getExternalSourceStatus(id).connectionGeneration;
    const cacheKey = JSON.stringify([id, generation, key.remoteId]);
    const cached = this.covers.get(cacheKey);
    if (cached) return cached;
    const { blob } = await this.api.requestBlob(`/extensions/sources/${encodeURIComponent(id)}/cover`, {
      method: 'POST',
      body: JSON.stringify({ workId: key.remoteId }),
      headers: { 'Content-Type': 'application/json' },
      signal,
    });
    signal.throwIfAborted();
    if (generation !== this.getExternalSourceStatus(id).connectionGeneration)
      throw new Error('package_generation_changed');
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type) || blob.size > 16 * 1024 * 1024)
      throw new Error('invalid_source_cover');
    const url = URL.createObjectURL(blob);
    if (this.covers.size >= 64) {
      const first = this.covers.keys().next().value!;
      URL.revokeObjectURL(this.covers.get(first)!);
      this.covers.delete(first);
    }
    this.covers.set(cacheKey, url);
    return url;
  }
}
