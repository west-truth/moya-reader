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
export interface ApkExtensionManager {
  preferences?(pkg: string): Promise<CompatibilityPreferences>;
  savePreferences?(
    pkg: string,
    revision: number,
    values: Record<string, unknown>,
    privateOrigins: readonly string[],
  ): Promise<void>;
  list(): Promise<ApkManagerSnapshot>;
  refreshRepository(url: string, signal?: AbortSignal): Promise<void>;
  removeRepository(url: string): Promise<void>;
  inspectFile?(file: File, signal?: AbortSignal, sourceIndex?: number): Promise<ApkInstallReview>;
  inspectRepository(url: string, pkg: string, code: number, signal?: AbortSignal): Promise<ApkInstallReview>;
  discardReview?(id: string): Promise<void>;
  install(review: ApkInstallReview, signal?: AbortSignal): Promise<void>;
  change(pkg: string, revision: number, action: 'enable' | 'disable' | 'remove'): Promise<void>;
}
