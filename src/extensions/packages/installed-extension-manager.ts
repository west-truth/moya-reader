import type {
  ContentConnectionRequest,
  ContentConnectionStatus,
} from '../../../packages/extension-contracts/source-content-service';
import type { ExternalSourceProviderRegistryPort } from '../../external-sources/app-external-source-registry';
import type { ExternalSourceContributionDescriptor } from '@noveldesk/extension-contracts';
import type { InstalledPackageSummary } from './package-install-store';
import type { PackageInstallPlan } from './package-installer';
import type { RepositoryRecord } from './repository-contract';
import type { SourceAuthenticationRequest, SourceAuthenticationStatus } from '@noveldesk/extension-contracts/package';

export type PackageReview = Omit<PackageInstallPlan, 'package'> & {
  package: Pick<PackageInstallPlan['package'], 'digest' | 'manifest' | 'publisherFingerprint'>;
};
export interface InstalledExtensionsSnapshot {
  packages: readonly InstalledPackageSummary[];
  sources: readonly {
    descriptor: ExternalSourceContributionDescriptor;
    apkPackageId?: string;
    mangayomiPackageId?: string;
    generation?: string;
  }[];
  errors: readonly { packageId: string; code: string }[];
  revision: number;
  available: boolean;
  error?: string;
}

export interface InstalledExtensionManager extends ExternalSourceProviderRegistryPort {
  preferences?(
    sourceId: string,
    request: import('../../../packages/extension-contracts/source-preferences').SourcePreferencesRequest,
    signal?: AbortSignal,
  ): Promise<import('./compatibility-preferences').CompatibilityPreferences>;
  readonly apk?: import('./apk-extension-manager').ApkExtensionManager;
  readonly mangayomi?: import('./apk-extension-manager').ApkExtensionManager;
  listRepositories?(): Promise<readonly RepositoryRecord[]>;
  refreshRepository?(url: string, signal?: AbortSignal): Promise<RepositoryRecord>;
  removeRepository?(url: string, revision: number): Promise<void>;
  selectRepositoryPackage?(
    url: string,
    id: string,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<{ file: File; plan: PackageReview }>;
  checkUpdate?(
    id: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<{ file: File; plan: PackageReview } | undefined>;
  contentConnection?(
    sourceId: string,
    request: ContentConnectionRequest,
    signal?: AbortSignal,
  ): Promise<ContentConnectionStatus>;
  authenticate?(
    sourceId: string,
    request: SourceAuthenticationRequest,
    signal?: AbortSignal,
  ): Promise<SourceAuthenticationStatus>;
  readonly target: 'server' | 'device';
  getSnapshot(): InstalledExtensionsSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  inspect(file: File, signal?: AbortSignal): Promise<PackageReview>;
  install(file: File, review: PackageReview): Promise<void>;
  change(id: string, revision: number, action: 'enable' | 'disable' | 'rollback' | 'remove'): Promise<void>;
  releaseCovers(): void;
}
