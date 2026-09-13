import type { InstalledSourceCatalogPort } from '../../src/external-sources/installed-package-source-registry';
import type { ApkInstallations } from './installations.mjs';
import type { JavaApkTools } from './java-tools.mjs';
export class ApkSourceCatalog implements InstalledSourceCatalogPort {
  constructor(
    store: Pick<ApkInstallations, 'root' | 'snapshot' | 'setEnabled'>,
    tools: Pick<JavaApkTools, 'worker'>,
    options?: {
      maxWorkers?: number;
      namespace?: string;
      sourceFile?: string;
      description?: string;
      pageConcurrency?: 1 | 2 | 3;
    },
  );
  getSources: InstalledSourceCatalogPort['getSources'];
  getSource: InstalledSourceCatalogPort['getSource'];
  subscribe: InstalledSourceCatalogPort['subscribe'];
  invoke: InstalledSourceCatalogPort['invoke'];
  disable: InstalledSourceCatalogPort['disable'];
  refresh(): Promise<void>;
  close(): void;
  preferences(
    pkg: string,
    values?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<import('../../src/extensions/packages/compatibility-preferences').CompatibilityPreferences>;
}
