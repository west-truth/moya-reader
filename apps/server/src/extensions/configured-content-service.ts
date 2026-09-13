import { createContentProviderRegistry, type ContentProviderDefinition } from './content-provider-registry.js';
import { approveSourceUrl } from '@moya/extension-runtime/source-http';
import type { ContentServiceScope, SourceContentResolver } from './source-content-service.js';

export interface ContentServiceBinding {
  ownerId: string;
  packageId: string;
  sourceId: string;
  publisherFingerprint?: string;
  digest?: string;
  provider: string;
  origins: string[];
}
const invalid = () => new Error('invalid_extension_content_configuration');
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        cancel = () => reject(new Error('cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
      }),
    ]);
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel);
  }
}
function parse(raw: string | undefined): unknown[] {
  if (!raw) return [];
  try {
    if (Buffer.byteLength(raw) > 65536) throw invalid();
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 100) throw invalid();
    return value;
  } catch {
    throw invalid();
  }
}

/** Explicit operator binding to an existing connection; no credentials are granted by installing a package alone. */
export function createConfiguredContentService(
  environment: Record<string, string | undefined>,
  ownerId: string,
  options: { lookup?: Parameters<typeof approveSourceUrl>[2] } = {},
) {
  return createBoundContentService(
    {
      bindings: parse(environment.EXTENSION_CONTENT_BINDINGS),
      definitions: () => parse(environment.CONTENT_PROVIDERS) as unknown as ContentProviderDefinition[],
      legacy: {
        protocol: environment.CONTENT_PROVIDER_PROTOCOL || 'job-v1',
        endpoint: environment.CONTENT_PROVIDER_ENDPOINT,
        options: { endpoint: environment.CONTENT_PROVIDER_ENDPOINT, key: environment.CONTENT_PROVIDER_KEY },
      },
    },
    ownerId,
    options,
  );
}

/** Installed connections are structured host data, not a synthetic legacy server environment. */
export function createBoundContentService(
  configuration: {
    bindings: readonly unknown[];
    definitions: () => readonly ContentProviderDefinition[];
    legacy?: NonNullable<Parameters<typeof createContentProviderRegistry>[0]>['legacy'];
  },
  ownerId: string,
  options: { lookup?: Parameters<typeof approveSourceUrl>[2] } = {},
) {
  const bindings = configuration.bindings;
  if (bindings.length > 100) throw invalid();
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (
      !object(binding) ||
      Object.keys(binding).some(
        (key) =>
          !['ownerId', 'packageId', 'sourceId', 'publisherFingerprint', 'digest', 'provider', 'origins'].includes(key),
      ) ||
      typeof binding.ownerId !== 'string' ||
      !binding.ownerId ||
      binding.ownerId.length > 128 ||
      typeof binding.packageId !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{1,254}$/.test(binding.packageId) ||
      typeof binding.sourceId !== 'string' ||
      !binding.sourceId.startsWith(binding.packageId + '.') ||
      binding.sourceId.length > 255 ||
      !(binding.publisherFingerprint === undefined
        ? typeof binding.digest === 'string' && /^[a-f0-9]{64}$/.test(binding.digest)
        : binding.digest === undefined &&
          typeof binding.publisherFingerprint === 'string' &&
          /^[a-f0-9]{64}$/.test(binding.publisherFingerprint)) ||
      typeof binding.provider !== 'string' ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(binding.provider) ||
      !Array.isArray(binding.origins) ||
      !binding.origins.length ||
      binding.origins.length > 16 ||
      new Set(binding.origins).size !== binding.origins.length
    )
      throw invalid();
    for (const origin of binding.origins) {
      try {
        if (typeof origin !== 'string' || origin.length > 256) throw invalid();
        const url = new URL(origin);
        if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw invalid();
      } catch {
        throw invalid();
      }
    }
    const key = JSON.stringify([binding.ownerId, binding.packageId, binding.sourceId]);
    if (seen.has(key)) throw invalid();
    seen.add(key);
  }
  const owned = (bindings as ContentServiceBinding[]).filter((entry) => entry.ownerId === ownerId);
  // When nothing is approved, do not inspect, instantiate or require existing provider credentials.
  const registry = owned.length
    ? createContentProviderRegistry({
        definitions: configuration.definitions(),
        ...(configuration.legacy ? { legacy: configuration.legacy } : {}),
      })
    : undefined;
  for (const binding of owned) registry!.validateSelection(binding.provider);
  const lifetime = new AbortController();
  const pending = new Set<Promise<Uint8Array>>();
  const resolve: SourceContentResolver = async (scope: ContentServiceScope) => {
    const binding = owned.find(
      (entry) =>
        entry.packageId === scope.packageId &&
        entry.sourceId === scope.sourceId &&
        (entry.digest ? entry.digest === scope.digest : entry.publisherFingerprint === scope.publisherFingerprint),
    );
    if (!binding) throw new Error('source_content_service_required');
    if (lifetime.signal.aborted) throw new Error('cancelled');
    if (pending.size >= 2) throw new Error('execution_busy');
    const signal = AbortSignal.any([scope.signal, lifetime.signal]);
    const task = (async () => {
      signal.throwIfAborted();
      await abortable(approveSourceUrl(scope.url, binding.origins, options.lookup), signal);
      signal.throwIfAborted();
      const provider = await registry!.select(binding.provider);
      signal.throwIfAborted();
      if (!provider) throw new Error('source_content_service_required');
      return provider(scope.url, signal);
    })();
    pending.add(task);
    try {
      return await task;
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Driver errors may contain credentials; never retain them in API/log causes.
      if (signal.aborted) throw new Error('cancelled');
      const code = error instanceof Error ? error.message : '';
      const mapped: Record<string, string> = {
        source_url_denied: 'source_content_service_denied',
        source_address_denied: 'source_content_service_denied',
        content_provider_authentication_required: 'source_content_service_auth',
        content_provider_request_timeout: 'source_content_service_timeout',
        content_provider_body_timeout: 'source_content_service_timeout',
        content_provider_busy: 'source_rate_limited',
        source_access_required: 'source_auth_forbidden',
        source_verification_required: 'source_content_verification_required',
        source_size_limit: 'source_body_limit',
      };
      // eslint-disable-next-line preserve-caught-error -- Only fixed public codes may leave this credential-owning boundary.
      throw new Error(mapped[code] ?? 'source_content_service_failed');
    } finally {
      pending.delete(task);
    }
  };
  return {
    resolve,
    configured(scope: Pick<ContentServiceScope, 'packageId' | 'sourceId' | 'digest' | 'publisherFingerprint'>) {
      return owned.some(
        (entry) =>
          entry.packageId === scope.packageId &&
          entry.sourceId === scope.sourceId &&
          (entry.digest ? entry.digest === scope.digest : entry.publisherFingerprint === scope.publisherFingerprint),
      );
    },
    async dispose() {
      lifetime.abort();
      await Promise.allSettled(pending);
      await registry?.dispose();
    },
  };
}
