import type { MangaApkEntry } from '../../../packages/extension-contracts/apk-repository';
import type { CompatibilityPreferences } from './compatibility-preferences';
export interface ApkRepositoryRecord {
  url: string;
  entries: readonly (MangaApkEntry & {
    format?: 'mangayomi-js' | 'mangayomi-dart';
    appMinVerReq?: string;
    hasCloudflare?: boolean;
  })[];
  updatedAt: number;
}
export interface ApkInstalledRecord {
  pkg: string;
  version: string;
  code: number;
  digest: string;
  enabled?: boolean;
  sources: readonly { id: string; name: string; lang: string }[];
}
export interface ApkManagerSnapshot {
  available: boolean;
  revision: number;
  packages: readonly ApkInstalledRecord[];
  repositories: readonly ApkRepositoryRecord[];
}
export interface ApkInstallReview {
  id: string;
  revision: number;
  digest: string;
  pkg: string;
  version: string;
  signers: readonly string[];
  format?: 'mangayomi-js';
  origin?: string;
  sourceIndex?: number;
  fileSources?: readonly { name: string; lang: string }[];
}

export function boundedCompatibilitySignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; close(): void } {
  const timeout = new AbortController();
  const timer = globalThis.setTimeout(() => timeout.abort(new Error('apk_install_unconfirmed')), timeoutMs);
  return {
    signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
    close: () => globalThis.clearTimeout(timer),
  };
}

export function throwCompatibilityTimeout(signal: AbortSignal): void {
  if (signal.reason instanceof Error && signal.reason.message === 'apk_install_unconfirmed') throw signal.reason;
}

export function confirmedCompatibilityInstall(
  review: ApkInstallReview,
  snapshot: ApkManagerSnapshot,
): ApkManagerSnapshot {
  const installed = snapshot.packages.find((pkg) => pkg.pkg === review.pkg);
  if (
    snapshot.revision <= review.revision ||
    installed?.digest !== review.digest ||
    installed.version !== review.version
  )
    throw new Error('apk_install_unconfirmed');
  return snapshot;
}

export interface ApkExtensionManager {
  preferences?(pkg: string): Promise<CompatibilityPreferences>;
  savePreferences?(
    pkg: string,
    revision: number,
    values: Record<string, unknown>,
    privateOrigins: readonly string[],
  ): Promise<void>;
  list(signal?: AbortSignal): Promise<ApkManagerSnapshot>;
  refreshRepository(url: string, signal?: AbortSignal): Promise<void>;
  removeRepository(url: string): Promise<void>;
  inspectFile?(file: File, signal?: AbortSignal, sourceIndex?: number): Promise<ApkInstallReview>;
  inspectRepository(url: string, pkg: string, code: number, signal?: AbortSignal): Promise<ApkInstallReview>;
  discardReview?(id: string): Promise<void>;
  install(review: ApkInstallReview, signal?: AbortSignal): Promise<ApkManagerSnapshot>;
  change(pkg: string, revision: number, action: 'enable' | 'disable' | 'remove'): Promise<void>;
}
