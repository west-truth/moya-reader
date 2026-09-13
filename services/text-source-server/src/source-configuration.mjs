import { SourceError } from './catalog.mjs';
import { createContentProviderRegistry } from './content-provider-registry.mjs';

export async function createConfiguredSources({
  contentProviderProtocol = 'job-v1',
  contentProviderEndpoint,
  contentProviderKey,
  contentProviderLimits,
  contentProviders = [],
  contentProviderFactories = new Map(),
  sourceAdapters = [],
  sourceHttpTransport = 'http',
  sourceBrowserChannel,
  sourceAdapterFactories = new Map(),
} = {}) {
  if (
    !(sourceAdapterFactories instanceof Map) ||
    [...sourceAdapterFactories.values()].some((factory) => typeof factory !== 'function')
  )
    throw new SourceError(500, 'invalid_source_registry');
  if (
    !['http', 'browser'].includes(sourceHttpTransport) ||
    (sourceHttpTransport === 'http' && sourceBrowserChannel !== undefined)
  )
    throw new SourceError(500, 'invalid_source_http_transport');
  if (!Array.isArray(sourceAdapters) || sourceAdapters.length > 100)
    throw new SourceError(500, 'invalid_source_configuration');
  const providers = createContentProviderRegistry({
    definitions: contentProviders,
    factories: contentProviderFactories,
    legacy: {
      protocol: contentProviderProtocol,
      endpoint: contentProviderEndpoint,
      options: { ...contentProviderLimits, endpoint: contentProviderEndpoint, key: contentProviderKey },
    },
  });
  const seen = new Set();
  for (const source of sourceAdapters) {
    if (
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      typeof source.id !== 'string' ||
      !sourceAdapterFactories.has(source.id) ||
      seen.has(source.id)
    )
      throw new SourceError(500, 'invalid_source_configuration');
    seen.add(source.id);
    providers.validateSelection(source.contentProviderId);
  }
  const additionalAdapters = [];
  let transport;
  const dispose = async () => {
    await Promise.allSettled([providers.dispose(), Promise.resolve().then(() => transport?.dispose())]);
  };
  try {
    const contentProvider = await providers.select();
    if (sourceHttpTransport === 'browser') {
      const { createBrowserSourceHttp } = await import('./browser-source-http.mjs');
      transport = createBrowserSourceHttp({ channel: sourceBrowserChannel });
    }
    for (const source of sourceAdapters) {
      // Binding is host configuration, not source-specific data or an endpoint/key visible to the adapter.
      const { contentProviderId, ...settings } = source;
      additionalAdapters.push(
        await sourceAdapterFactories.get(source.id)(
          settings,
          await providers.select(contentProviderId),
          transport?.fetchImpl,
        ),
      );
    }
    return { contentProvider, additionalAdapters, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export function configuredSourcesFromEnvironment(
  environment,
  { sourceAdapterFactories, contentProviderFactories } = {},
) {
  let sourceAdapters;
  try {
    sourceAdapters = JSON.parse(environment.SOURCE_ADAPTERS || '[]');
  } catch {
    throw new SourceError(500, 'invalid_source_configuration');
  }
  let contentProviders;
  try {
    const raw = environment.CONTENT_PROVIDERS || '[]';
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) throw new Error();
    contentProviders = JSON.parse(raw);
  } catch {
    throw new SourceError(500, 'invalid_content_provider_configuration');
  }
  return createConfiguredSources({
    contentProviderProtocol: environment.CONTENT_PROVIDER_PROTOCOL || 'job-v1',
    contentProviderEndpoint: environment.CONTENT_PROVIDER_ENDPOINT || undefined,
    contentProviderKey: environment.CONTENT_PROVIDER_KEY,
    contentProviders,
    contentProviderFactories,
    sourceAdapters,
    sourceHttpTransport: environment.SOURCE_HTTP_TRANSPORT || 'http',
    sourceBrowserChannel: environment.SOURCE_BROWSER_CHANNEL || undefined,
    sourceAdapterFactories,
  });
}
