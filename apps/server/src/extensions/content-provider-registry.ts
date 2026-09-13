import { createJobV1ContentProvider } from './job-v1-content-provider.js';

export type ManagedContentProvider = ((url: string, signal?: AbortSignal) => Promise<Uint8Array>) & {
  dispose?(): void | Promise<void>;
};
export type ContentProviderFactory = (
  options: Record<string, unknown>,
) => ManagedContentProvider | Promise<ManagedContentProvider>;
export interface ContentProviderDefinition {
  id: string;
  protocol: string;
  options: Record<string, unknown>;
}

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('invalid_content_provider_configuration');

/** Host-owned protocol registry. Configuration cannot import code or select a driver per request. */
export function createContentProviderRegistry({
  definitions = [],
  factories = new Map<string, ContentProviderFactory>(),
  legacy = { protocol: 'job-v1' },
}: {
  definitions?: readonly ContentProviderDefinition[];
  factories?: Map<string, ContentProviderFactory>;
  legacy?: { protocol: string; endpoint?: string; options?: Record<string, unknown> };
} = {}) {
  if (
    !(factories instanceof Map) ||
    [...factories].some(
      ([id, factory]) => typeof id !== 'string' || !ID.test(id) || id === 'job-v1' || typeof factory !== 'function',
    )
  )
    throw new Error('invalid_content_provider_registry');
  const drivers = new Map<string, ContentProviderFactory>([
    ...factories,
    ['job-v1', async (options) => createJobV1ContentProvider(options)],
  ]);
  if (!Array.isArray(definitions) || definitions.length > 32) throw invalid();
  const configured = new Map<string, { protocol: string; options: Record<string, unknown> }>();
  for (const definition of definitions) {
    if (
      !object(definition) ||
      Object.keys(definition).some((key) => !['id', 'protocol', 'options'].includes(key)) ||
      typeof definition.id !== 'string' ||
      !ID.test(definition.id) ||
      definition.id === 'default' ||
      configured.has(definition.id) ||
      typeof definition.protocol !== 'string' ||
      !object(definition.options)
    )
      throw invalid();
    if (!drivers.has(definition.protocol)) throw new Error('unsupported_content_provider_protocol');
    configured.set(definition.id, { protocol: definition.protocol, options: definition.options });
  }
  if (!drivers.has(legacy.protocol)) throw new Error('unsupported_content_provider_protocol');
  if (legacy.endpoint)
    configured.set('default', { protocol: legacy.protocol, options: legacy.options ?? { endpoint: legacy.endpoint } });
  const instances = new Map<string, Promise<ManagedContentProvider>>();
  let disposed = false;
  const validateSelection = (id?: string | null) => {
    if (id === null || id === undefined) return;
    if (typeof id !== 'string' || !ID.test(id) || !configured.has(id))
      throw new Error('content_provider_not_configured');
  };
  return {
    validateSelection,
    async select(id?: string | null) {
      validateSelection(id);
      if (disposed) throw new Error('content_provider_unavailable');
      if (id === null) return undefined;
      const selected = id ?? 'default';
      const definition = configured.get(selected);
      if (!definition) return undefined;
      if (!instances.has(selected)) {
        instances.set(
          selected,
          Promise.resolve().then(async () => {
            try {
              const provider = await drivers.get(definition.protocol)!(definition.options);
              if (typeof provider !== 'function') throw invalid();
              return provider;
            } catch {
              throw invalid();
            }
          }),
        );
      }
      return instances.get(selected);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const ready = await Promise.allSettled(instances.values());
      await Promise.allSettled(
        ready.flatMap((result) =>
          result.status === 'fulfilled' && typeof result.value.dispose === 'function'
            ? [Promise.resolve().then(() => result.value.dispose!())]
            : [],
        ),
      );
    },
  };
}
