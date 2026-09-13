/** Trusted source-server management. APK bytes and server credentials never enter UI components. */
export interface SourceExtensionRepository {
  readonly url: string;
  readonly name: string;
}
export interface SourceExtensionEntry {
  readonly id: string;
  readonly name: string;
  readonly lang: string;
  readonly version: string;
  readonly repository?: string;
  readonly installed: boolean;
  readonly hasUpdate: boolean;
  readonly obsolete: boolean;
}
export interface SourceExtensionInventory {
  readonly repositories: readonly SourceExtensionRepository[];
  readonly extensions: readonly SourceExtensionEntry[];
  readonly excludedCount: number;
}
export interface SourceExtensionManager {
  list(signal: AbortSignal): Promise<SourceExtensionInventory>;
  refresh(signal: AbortSignal): Promise<SourceExtensionInventory>;
  addRepository(url: string, signal: AbortSignal): Promise<void>;
  removeRepository(url: string, signal: AbortSignal): Promise<void>;
  change(id: string, action: 'install' | 'update' | 'uninstall', signal: AbortSignal): Promise<void>;
}
