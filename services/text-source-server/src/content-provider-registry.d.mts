import type { ContentProviderDefinition, ContentProviderFactory, ManagedContentProvider } from '../contracts';
export function createContentProviderRegistry(options?: {
  definitions?: readonly ContentProviderDefinition[];
  factories?: Map<string, ContentProviderFactory>;
  legacy?: { protocol: string; endpoint?: string; options?: Record<string, unknown> };
}): {
  validateSelection(id?: string | null): void;
  select(id?: string | null): Promise<ManagedContentProvider | undefined>;
  dispose(): Promise<void>;
};
