import { SourceError } from './catalog.mjs';

// Only bundled, trusted implementations can be selected. Configuration is data, never module paths.
const contentProviderFactories = new Map([
  [
    'job-v1',
    async (options) => {
      const { createContentJobProvider } = await import('./content-job-provider.mjs');
      return createContentJobProvider(options);
    },
  ],
]);

export async function createConfiguredSources({
  contentProviderProtocol = 'job-v1',
  contentProviderEndpoint,
  contentProviderKey,
  contentProviderLimits,
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
  const providerFactory = contentProviderFactories.get(contentProviderProtocol);
  if (!providerFactory) throw new SourceError(500, 'unsupported_content_provider_protocol');
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
  }
  const contentProvider = contentProviderEndpoint
    ? await providerFactory({ endpoint: contentProviderEndpoint, key: contentProviderKey, ...contentProviderLimits })
    : undefined;
  const additionalAdapters = [];
  let transport;
  if (sourceHttpTransport === 'browser') {
    const { createBrowserSourceHttp } = await import('./browser-source-http.mjs');
    transport = createBrowserSourceHttp({ channel: sourceBrowserChannel });
  }
  const dispose = async () => {
    await transport?.dispose();
  };
  try {
    for (const source of sourceAdapters)
      additionalAdapters.push(
        await sourceAdapterFactories.get(source.id)(source, contentProvider, transport?.fetchImpl),
      );
    return { contentProvider, additionalAdapters, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export function configuredSourcesFromEnvironment(environment, { sourceAdapterFactories } = {}) {
  let sourceAdapters;
  try {
    sourceAdapters = JSON.parse(environment.SOURCE_ADAPTERS || '[]');
  } catch {
    throw new SourceError(500, 'invalid_source_configuration');
  }
  return createConfiguredSources({
    contentProviderProtocol: environment.CONTENT_PROVIDER_PROTOCOL || 'job-v1',
    contentProviderEndpoint: environment.CONTENT_PROVIDER_ENDPOINT || undefined,
    contentProviderKey: environment.CONTENT_PROVIDER_KEY,
    sourceAdapters,
    sourceHttpTransport: environment.SOURCE_HTTP_TRANSPORT || 'http',
    sourceBrowserChannel: environment.SOURCE_BROWSER_CHANNEL || undefined,
    sourceAdapterFactories,
  });
}
