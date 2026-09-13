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
  readonly apk?: import('./apk-extension-manager').ApkExtensionManager;
  readonly mangayomi?: import('./apk-extension-manager').ApkExtensionManager;
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
      this.mangayomi = this.mgCatalog.manager;
    }
    if (execution.apk) {
      this.apkCatalog = new NativeApkCatalog(execution.apk, () => this.refresh());
      this.apkSources = new InstalledPackageSourceRegistry(this.apkCatalog);
      this.apk = this.apkCatalog.manager;
    }
  }
  getSnapshot = () => this.snapshot;
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
        await this.execution.ready?.();
        await this.catalog.refresh();
        await this.apkCatalog?.refresh().catch(() => undefined);
        await this.mgCatalog?.refresh().catch(() => undefined);
        const value = {
          available: true,
          packages: await this.store.list(),
          sources: this.getExternalSources(),
          errors: this.catalog.getErrors(),
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
  async install(file: File, review: PackageReview) {
    const plan = await this.catalog.installer.inspect(file);
    await this.catalog.installer.install(
      { ...plan, expectedRevision: review.expectedRevision },
      { digest: review.package.digest, publisherChange: review.publisherChanged, downgrade: review.downgrade },
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
