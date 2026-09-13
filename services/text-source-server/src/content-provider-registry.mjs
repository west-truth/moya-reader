import { SourceError } from './catalog.mjs';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new SourceError(500, 'invalid_content_provider_configuration');

/** Trusted composition only. Configuration cannot import code or choose a provider at request time. */
export function createContentProviderRegistry({
  definitions = [],
  factories = new Map(),
  legacy = { protocol: 'job-v1' },
} = {}) {
  if (
    !(factories instanceof Map) ||
    [...factories].some(
      ([id, factory]) => typeof id !== 'string' || !ID.test(id) || id === 'job-v1' || typeof factory !== 'function',
    )
  )
    throw new SourceError(500, 'invalid_content_provider_registry');
  const drivers = new Map([
    ...factories,
    [
      'job-v1',
      async (options) => {
        const { createContentJobProvider } = await import('./content-job-provider.mjs');
        return createContentJobProvider(options);
      },
    ],
  ]);
  if (!Array.isArray(definitions) || definitions.length > 32) throw invalid();
  const configured = new Map();
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
    if (!drivers.has(definition.protocol)) throw new SourceError(500, 'unsupported_content_provider_protocol');
    configured.set(definition.id, definition);
  }
  // Keep the existing global connection for old adapters and static catalogs. No endpoint means no provider.
  if (!drivers.has(legacy.protocol)) throw new SourceError(500, 'unsupported_content_provider_protocol');
  if (legacy.endpoint) configured.set('default', { protocol: legacy.protocol, options: legacy.options });
  const instances = new Map();
  let disposed = false;
  const validateSelection = (id) => {
    if (id === null || id === undefined) return;
    if (typeof id !== 'string' || !ID.test(id) || !configured.has(id))
      throw new SourceError(500, 'content_provider_not_configured');
  };
  return {
    validateSelection,
    async select(id) {
      validateSelection(id);
      if (disposed) throw new SourceError(503, 'content_provider_unavailable');
      if (id === null) return undefined;
      const selected = id ?? 'default';
      const definition = configured.get(selected);
      if (!definition) return undefined;
      if (!instances.has(selected)) {
        instances.set(
          selected,
          Promise.resolve().then(async () => {
            try {
              const provider = await drivers.get(definition.protocol)(definition.options);
              if (typeof provider !== 'function') throw invalid();
              return provider;
            } catch {
              // Third-party factory errors can contain endpoint/key values.
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
            ? [Promise.resolve().then(() => result.value.dispose())]
            : [],
        ),
      );
    },
  };
}
