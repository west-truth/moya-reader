import { WebNovelMetadataCollectorBroker } from '../services/webnovel-metadata-collector-broker';
import { WebNovelMetadataCollectorClient } from '../services/webnovel-metadata-collector-client';
import type { PlatformRuntimeInfo } from './runtime';
import { NativeWebNovelMetadataCollectorClient } from './tauri/native-webnovel-metadata-collector';

export const SELF_HOSTED_WEBNOVEL_METADATA_COLLECTOR_PATH = '/integrations/webnovel-metadata';

export interface WebNovelMetadataCollectorServerConnection {
  readonly apiBaseUrl: string;
  readonly getAuthToken: () => string | undefined;
}

function collectorGatewayEndpoint(apiBaseUrl: string): string {
  const base = new URL(apiBaseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !base.pathname.replace(/\/+$/u, '').endsWith('/api')
  ) {
    throw new Error('Invalid server API URL for metadata collector.');
  }
  base.pathname = `${base.pathname.replace(/\/+$/u, '')}${SELF_HOSTED_WEBNOVEL_METADATA_COLLECTOR_PATH}`;
  return base.toString().replace(/\/$/u, '');
}

export function resolveSelfHostedWebNovelMetadataCollectorEndpoint(input: {
  readonly backendMode: string | undefined;
  readonly apiBaseUrl: string | undefined;
  readonly browserOrigin: string | undefined;
}): string | undefined {
  if (input.backendMode !== 'remote' || !input.browserOrigin) return undefined;
  try {
    const browserOrigin = new URL(input.browserOrigin);
    const base = new URL(input.apiBaseUrl?.trim() || '/api', browserOrigin);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.origin !== browserOrigin.origin ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      return undefined;
    }
    base.pathname = `${base.pathname.replace(/\/+$/u, '')}${SELF_HOSTED_WEBNOVEL_METADATA_COLLECTOR_PATH}`;
    return base.toString().replace(/\/$/u, '');
  } catch {
    return undefined;
  }
}

export function createPlatformWebNovelMetadataCollector(
  runtime: PlatformRuntimeInfo,
  serverConnection?: WebNovelMetadataCollectorServerConnection,
): WebNovelMetadataCollectorBroker {
  if (serverConnection) {
    const endpoint = collectorGatewayEndpoint(serverConnection.apiBaseUrl);
    const gateway = new URL(endpoint);
    const fetchGateway: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== gateway.origin || !url.pathname.startsWith(`${gateway.pathname}/`)) {
        throw new Error('Metadata collector request left the authenticated server gateway.');
      }
      const headers = new Headers(init?.headers);
      const token = serverConnection.getAuthToken()?.trim();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      else headers.delete('Authorization');
      return globalThis.fetch(input, { ...init, headers, credentials: 'omit', redirect: 'error' });
    };
    const client = new WebNovelMetadataCollectorClient(endpoint, fetchGateway, { allowHttp: true });
    return new WebNovelMetadataCollectorBroker({ managedRuntime: { client, stop: async () => undefined } });
  }
  if (runtime.kind === 'tauri-desktop') {
    const client = new NativeWebNovelMetadataCollectorClient();
    return new WebNovelMetadataCollectorBroker({
      managedRuntime: {
        client,
        stop: () => client.stop(),
      },
    });
  }
  const selfHostedEndpoint = resolveSelfHostedWebNovelMetadataCollectorEndpoint({
    backendMode: import.meta.env.VITE_READER_BACKEND,
    apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
    browserOrigin: globalThis.location?.origin,
  });
  if (!selfHostedEndpoint) return new WebNovelMetadataCollectorBroker();
  const client = new WebNovelMetadataCollectorClient(selfHostedEndpoint, globalThis.fetch.bind(globalThis), {
    credentials: 'same-origin',
    allowHttp: true,
  });
  return new WebNovelMetadataCollectorBroker({
    managedRuntime: {
      client,
      stop: async () => undefined,
    },
  });
}
