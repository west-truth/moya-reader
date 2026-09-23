import type {
  ContentConnectionRequest,
  ContentConnectionStatus,
} from '../../../packages/extension-contracts/source-content-service';
import { InstalledPackageSourceRegistry } from '../../external-sources/installed-package-source-registry';
import { IndexedDbPackageInstallStore, type PackageInstallStore } from './package-install-store';
import { PackageRuntimeCatalog, type PackageExecutionPort } from './package-runtime-catalog';
import { PackageRepositories } from './package-repositories';
import { NativeApkCatalog, type NativeApkTransport } from './native-apk-catalog';
import type { SourceAuthenticationRequest } from '@noveldesk/extension-contracts/package';
import type {
  InstalledExtensionManager,
  InstalledExtensionsSnapshot,
  PackageReview,
} from './installed-extension-manager';

/** Device installation is separate from server inventory and ordinary library backups. */
export class LocalInstalledExtensions extends InstalledPackageSourceRegistry implements InstalledExtensionManager {
  private features?: { credentialVault: boolean; mangayomi: boolean; apk: boolean };
  get apk(): import('./apk-extension-manager').ApkExtensionManager | undefined {
    return this.features?.apk === false ? undefined : this.apkCatalog?.manager;
  }
  get mangayomi(): import('./apk-extension-manager').ApkExtensionManager | undefined {
    return this.features?.mangayomi === false ? undefined : this.mgCatalog?.manager;
  }
  private mgCatalog?: NativeApkCatalog;
  private mgSources?: InstalledPackageSourceRegistry<NativeApkCatalog>;
  private apkCatalog?: NativeApkCatalog;
  private apkSources?: InstalledPackageSourceRegistry<NativeApkCatalog>;
  readonly target = 'device' as const;
  private snapshot: InstalledExtensionsSnapshot = {
    revision: 0,
    available: false,
    packages: [],
    sources: [],
    errors: [],
  };
  private listeners = new Set<() => void>();
  private pending?: Promise<void>;
  private repositories: PackageRepositories;
  constructor(
    private readonly execution: PackageExecutionPort & {
      ready?(): Promise<unknown>;
      portableVaultStatus?: () => Promise<import('./installed-extension-manager').PortableVaultStatus>;
      portableVaultUnlock?: (
        passphrase: string,
      ) => Promise<import('./installed-extension-manager').PortableVaultStatus>;
      portableVaultLock?: () => Promise<import('./installed-extension-manager').PortableVaultStatus>;
      networkSettings?: (
        request?: import('../../../packages/extension-contracts/source-network-settings').SourceNetworkSettingsRequest,
        signal?: AbortSignal,
      ) => Promise<import('../../../packages/extension-contracts/source-network-settings').SourceNetworkSettings>;
      apk?: NativeApkTransport;
      mangayomi?: NativeApkTransport;
    },
    private readonly store: PackageInstallStore = new IndexedDbPackageInstallStore(),
  ) {
    super(new PackageRuntimeCatalog(store, execution));
    this.repositories = new PackageRepositories(store, execution);
    if (execution.mangayomi) {
      this.mgCatalog = new NativeApkCatalog(execution.mangayomi, () => this.refresh());
      this.mgSources = new InstalledPackageSourceRegistry(this.mgCatalog);
    }
    if (execution.apk) {
      this.apkCatalog = new NativeApkCatalog(execution.apk, () => this.refresh());
      this.apkSources = new InstalledPackageSourceRegistry(this.apkCatalog);
    }
  }
  getSnapshot = () => this.snapshot;
  portableVaultStatus = () => this.execution.portableVaultStatus?.() ?? Promise.reject(new Error('unsupported'));
  portableVaultUnlock = async (passphrase: string) => {
    const status = await (this.execution.portableVaultUnlock?.(passphrase) ?? Promise.reject(new Error('unsupported')));
    await this.refresh();
    return status;
  };
  portableVaultLock = async () => {
    const status = await (this.execution.portableVaultLock?.() ?? Promise.reject(new Error('unsupported')));
    await this.refresh();
    return status;
  };
  networkSettings = (
    request?: import('../../../packages/extension-contracts/source-network-settings').SourceNetworkSettingsRequest,
    signal?: AbortSignal,
  ) => {
    if (!this.execution.networkSettings) return Promise.reject(new Error('source_network_unavailable'));
    return this.execution.networkSettings(request, signal);
  };
  listRepositories = () => this.repositories.list();
  refreshRepository = (url: string, signal?: AbortSignal) => this.repositories.refresh(url, signal);
  removeRepository = (url: string, revision: number) => this.repositories.remove(url, revision);
  async selectRepositoryPackage(url: string, id: string, sha256: string, signal?: AbortSignal) {
    const file = new File([await this.repositories.download(url, id, sha256, signal)], 'repository.moyaext');
    const plan = await this.inspect(file, signal);
    if (plan.publisherChanged) throw new Error('package_update_publisher_mismatch');
    return { file, plan };
  }
  async checkUpdate(id: string, revision: number, signal?: AbortSignal) {
    const archive = await this.catalog.checkUpdate(id, revision, signal);
    if (!archive) return undefined;
    const file = new File([archive], 'update.moyaext');
    const plan = await this.inspect(file, signal);
    if (plan.expectedRevision !== revision) throw new Error('package_install_conflict');
    return { file, plan };
  }
  contentConnection = (
    id: string,
    request: ContentConnectionRequest,
    signal?: AbortSignal,
  ): Promise<ContentConnectionStatus> => this.catalog.contentConnection(id, request, signal);
  preferences = (
    id: string,
    request: import('../../../packages/extension-contracts/source-preferences').SourcePreferencesRequest,
    signal?: AbortSignal,
  ) => this.catalog.preferences(id, request, signal);
  authenticate = (id: string, request: SourceAuthenticationRequest, signal?: AbortSignal) =>
    this.catalog.authenticate(id, request, signal);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  refresh = (): Promise<void> => {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const connection = await this.execution.ready?.();
        this.features =
          connection && typeof connection === 'object' && 'features' in connection
            ? (connection.features as typeof this.features)
            : undefined;
        await this.catalog.refresh();
        if (this.apk) await this.apkCatalog?.refresh().catch(() => undefined);
        if (this.mangayomi) await this.mgCatalog?.refresh().catch(() => undefined);
        const value = {
          available: true,
          packages: await this.store.list(),
          sources: this.getExternalSources(),
          errors: this.catalog.getErrors(),
          error:
            this.features?.credentialVault === false
              ? '보안 저장소를 열지 못했습니다. 로그인과 소스 설정은 앱을 닫으면 사라집니다.'
              : undefined,
        };
        const { revision, ...previous } = this.snapshot;
        if (JSON.stringify(value) === JSON.stringify(previous)) return;
        this.snapshot = { ...value, revision: revision + 1 };
      } catch (error) {
        this.snapshot = {
          ...this.snapshot,
          revision: this.snapshot.revision + 1,
          available: false,
          error:
            typeof error === 'string' && /[가-힣]/.test(error)
              ? error
              : '기기의 확장 정보를 읽지 못했습니다. 저장 공간과 앱 상태를 확인해 주세요.',
        };
      }
      for (const listener of this.listeners) listener();
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  };
  async inspect(file: File, signal?: AbortSignal): Promise<PackageReview> {
    if (!file.name.toLowerCase().endsWith('.moyaext')) throw new Error('.moyaext 파일을 선택해 주세요.');
    const { package: pkg, ...review } = await this.catalog.installer.inspect(file, signal);
    return {
      ...review,
      package: { digest: pkg.digest, manifest: pkg.manifest, publisherFingerprint: pkg.publisherFingerprint },
    };
  }
  async install(file: File, review: PackageReview, signal?: AbortSignal) {
    const plan = await this.catalog.installer.inspect(file, signal);
    await this.catalog.installer.install(
      { ...plan, expectedRevision: review.expectedRevision },
      { digest: review.package.digest, publisherChange: review.publisherChanged, downgrade: review.downgrade },
      signal,
    );
    await this.pending;
    await this.refresh();
  }
  async change(id: string, revision: number, action: 'enable' | 'disable' | 'rollback' | 'remove') {
    if (action === 'remove') await this.catalog.installer.remove(id, revision);
    else if (action === 'rollback') await this.catalog.installer.rollback(id, revision);
    else await this.catalog.installer.setEnabled(id, revision, action === 'enable');
    await this.pending;
    await this.refresh();
  }
  override async disconnectExternalSource(id: string) {
    if (this.mgCatalog?.getSource(id)) {
      await this.mgCatalog.disable(id);
      return;
    }
    if (this.apkCatalog?.getSource(id)) {
      await this.apkCatalog.disable(id);
      return;
    }
    await this.catalog.disable(id);
    await this.pending;
    await this.refresh();
  }
  override getExternalSources() {
    return [
      ...super.getExternalSources(),
      ...(this.apkSources?.getExternalSources() ?? []),
      ...(this.mgSources?.getExternalSources() ?? []),
    ];
  }
  override getExternalSourceStatus(id: string) {
    return this.compatible(id) ? this.compatible(id)!.getExternalSourceStatus(id) : super.getExternalSourceStatus(id);
  }
  override async connectExternalSource(id: string) {
    return this.compatible(id) ? this.compatible(id)!.connectExternalSource(id) : super.connectExternalSource(id);
  }
  override async listExternalSource(...args: Parameters<InstalledPackageSourceRegistry['listExternalSource']>) {
    return this.compatible(args[0])
      ? this.compatible(args[0])!.listExternalSource(...args)
      : super.listExternalSource(...args);
  }
  override async downloadExternalSource(...args: Parameters<InstalledPackageSourceRegistry['downloadExternalSource']>) {
    return this.compatible(args[0])
      ? this.compatible(args[0])!.downloadExternalSource(...args)
      : super.downloadExternalSource(...args);
  }
  override async resolveExternalSourceCover(
    ...args: Parameters<InstalledPackageSourceRegistry['resolveExternalSourceCover']>
  ) {
    return this.compatible(args[0])
      ? this.compatible(args[0])!.resolveExternalSourceCover(...args)
      : super.resolveExternalSourceCover(...args);
  }
  private compatible(id: string) {
    return this.apkCatalog?.getSource(id)
      ? this.apkSources
      : this.mgCatalog?.getSource(id)
        ? this.mgSources
        : undefined;
  }
  override releaseCovers() {
    super.releaseCovers();
    this.apkSources?.releaseCovers();
    this.mgSources?.releaseCovers();
  }
  override dispose() {
    super.dispose();
    this.apkSources?.dispose();
    this.apkCatalog?.dispose();
    this.mgSources?.dispose();
    this.mgCatalog?.dispose();
  }
}
