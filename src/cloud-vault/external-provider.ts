import type { CloudVaultFileProvider } from './contracts';
import type { CloudVaultLocalConfig } from './local-state';

/** Optional product-owned OAuth boundary. Tokens never enter shared configuration or UI props. */
export interface CloudVaultExternalProvider {
  readonly available: boolean;
  subscribe(listener: () => void): () => void;
  getSnapshot(): unknown;
  connect(expectedAccountId?: string): Promise<{ accountId: string; label: string }>;
  createProvider(config: CloudVaultLocalConfig): Promise<CloudVaultFileProvider>;
  isReady(config: CloudVaultLocalConfig): boolean;
  disconnect(): void;
}
