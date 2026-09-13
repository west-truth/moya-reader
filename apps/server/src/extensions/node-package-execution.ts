import { runExtension } from '@moya/extension-runtime';
import { createSourceBroker } from '@moya/extension-runtime/source-broker';
import {
  validateSourceInput,
  validateSourceResult,
  validateSourceContentRequest,
} from '@noveldesk/extension-contracts/source-protocol';
import type { SourceAsset, SourceContent } from '@noveldesk/extension-contracts/source-sdk';
import type { PackageExecutionPort } from '../../../../src/extensions/packages/package-runtime-catalog.js';
import { createSourceStateSession } from '../../../../src/extensions/packages/source-state.js';
import { createSourceAuthentication, type SourceTransport } from './source-authentication.js';
import type { SourceCredentialVault } from './source-credential-vault.js';
import { downloadPackageUpdate, fetchRepositoryIndex, fetchRepositoryArchive } from './package-repository.js';
import { materializeSourceContent, type SourceContentResolver } from './source-content-service.js';
import { createStoredContentService } from './stored-content-service.js';
import { sourceWebViewHost } from './source-webview.js';
import type { SourceWebViewRequest } from '../../../../packages/extension-contracts/source-webview.js';
import { createSourcePreferences } from './source-preferences.js';
import { compatibilityHttp, type CompatibilityHttpInput } from './mangayomi/http.js';
import { sourceBrowserHttp } from './source-browser-cookies.js';
import { setTimeout as sleep } from 'node:timers/promises';

/** Installed packages never supply the host transport or reach Node's realm. */
export function createNodePackageExecution(
  runtime: 'self-host-gateway' | 'tauri-native' = 'self-host-gateway',
  options: {
    vault?: SourceCredentialVault;
    transport?: SourceTransport;
    contentResolver?: SourceContentResolver;
    contentConfigured?: (scope: Parameters<SourceContentResolver>[0]) => boolean;
  } = {},
): PackageExecutionPort {
  const authentication = options.vault ? createSourceAuthentication(options.vault, options.transport) : undefined;
  const storedContent = options.vault ? createStoredContentService(options.vault) : undefined;
  const preferences = options.vault ? createSourcePreferences(options.vault) : undefined;
  return {
    preferences: async (pkg, source, epoch, request, signal) => {
      if (!preferences) throw new Error('invalid_source_preferences');
      return preferences.manage(pkg, source, epoch, request, signal);
    },
    runtime,
    contentConnection: async (pkg, sourceId, epoch, request, signal) => {
      if (
        options.contentConfigured?.({
          packageId: pkg.manifest.extension.id,
          sourceId,
          digest: pkg.digest,
          publisherFingerprint: pkg.publisherFingerprint,
          url: '',
          signal,
        })
      ) {
        if (request.action !== 'status') throw new Error('source_content_service_denied');
        return { configured: true, managed: true };
      }
      if (!storedContent) throw new Error('source_content_service_required');
      return storedContent.manage(pkg, sourceId, epoch, request, signal);
    },
    listRepository: (url, signal) => fetchRepositoryIndex(url, signal, options.transport),
    downloadRepository: (url, entry, signal) => fetchRepositoryArchive(url, entry, signal, options.transport),
    checkUpdate: (pkg, signal) => downloadPackageUpdate(pkg, signal, options.transport),
    authenticate: authentication?.manage,
    retainAuthentication: authentication?.retain,
    async prepare(pkg, signal) {
      if (pkg.manifest.extension.contributes?.bookEnrichmentProviders?.length)
        throw new Error('unsupported_package_capability');
      const sources = pkg.manifest.extension.contributes?.externalSources ?? [];
      if (
        !sources.length ||
        sources.some(
          (source) =>
            source.schemaVersion !== 2 ||
            source.kind !== 'catalog' ||
            !source.runtimes.includes(runtime) ||
            !source.seriesProfile,
        )
      )
        throw new Error('unsupported_package_runtime');
      const result = (await runExtension({ source: pkg.source, method: 'describe', signal })) as {
        apiVersion?: unknown;
        sources?: { id?: unknown; cover?: unknown }[];
      } | null;
      if (
        !result ||
        result.apiVersion !== 1 ||
        !Array.isArray(result.sources) ||
        result.sources.length !== sources.length ||
        !sources.every(
          (source) =>
            result.sources!.filter(
              (entry) =>
                entry?.id === source.id &&
                typeof entry.cover === 'boolean' &&
                (!source.capabilities.includes('cover-read') || entry.cover),
            ).length === 1,
        )
      )
        throw new Error('source_manifest_mismatch');
    },
    async invoke(pkg, method, input, signal, state, credentialEpoch) {
      if (
        !validateSourceInput(method, input) ||
        !pkg.manifest.extension.contributes?.externalSources?.some((source) => source.id === input.sourceId)
      )
        throw new Error('invalid_source_invocation');
      const broker = createSourceBroker(
        {
          origins: pkg.manifest.requestedAccess.networkOrigins,
          allowDownloads: pkg.manifest.extension.permissions.includes('external.source.download'),
        },
        credentialEpoch && authentication
          ? authentication.transport(pkg, String(input.sourceId), credentialEpoch)
          : options.transport,
      );
      const storage = createSourceStateSession(state, pkg.manifest.requestedAccess.storageKiB);
      const sourceOptions =
        credentialEpoch && preferences
          ? preferences.values(pkg, String(input.sourceId), credentialEpoch)
          : { values: {} as Record<string, string | number | boolean>, privateOrigins: [] };
      let requestedBytes = 0;
      try {
        const result = await runExtension({
          source: pkg.source,
          method,
          input,
          broker: {
            ...broker.methods,
            ...storage.methods,
            'source.sleep': async (request, requestSignal) => {
              const milliseconds = (request as { milliseconds?: unknown })?.milliseconds;
              if (!Number.isInteger(milliseconds) || Number(milliseconds) < 0 || Number(milliseconds) > 10000)
                throw new Error('invalid_source_invocation');
              await sleep(Number(milliseconds), undefined, { signal: requestSignal });
              return null;
            },
            'preferences.get': async (request) => {
              const key = (request as { key?: unknown })?.key;
              if (typeof key !== 'string') throw new Error('invalid_source_preferences');
              return Object.hasOwn(sourceOptions.values, key) ? sourceOptions.values[key] : null;
            },
            'source.request': async (request, requestSignal) => {
              const http = request as CompatibilityHttpInput;
              const origin = new URL(http.url).origin;
              if (![...pkg.manifest.requestedAccess.networkOrigins, ...sourceOptions.privateOrigins].includes(origin))
                throw new Error('source_url_denied');
              // Return redirects to the guest: subsequent targets must pass this same origin check.
              const response = await sourceBrowserHttp(
                http,
                requestSignal,
                {
                  key: JSON.stringify([
                    pkg.manifest.extension.id,
                    `browser:${input.sourceId}`,
                    credentialEpoch ?? pkg.digest,
                  ]),
                  vault: options.vault,
                  privateOrigins: sourceOptions.privateOrigins,
                  outboundProxy: process.env.SOURCE_OUTBOUND_PROXY,
                  browserMode: 'browserMode' in sourceOptions ? sourceOptions.browserMode : undefined,
                },
                2 * 1024 * 1024,
                compatibilityHttp,
              );
              requestedBytes += response.bytes.length;
              if (requestedBytes > 32 * 1024 * 1024) throw new Error('source_body_limit');
              return {
                statusCode: response.statusCode,
                headers: response.headers,
                body: new TextDecoder('utf-8', { fatal: true }).decode(response.bytes),
              };
            },
            'webview.evaluate': async (request, requestSignal) => {
              if (!pkg.manifest.requestedAccess.webview) throw new Error('permission_denied');
              return sourceWebViewHost.evaluate(
                request as SourceWebViewRequest,
                {
                  key: JSON.stringify([
                    pkg.manifest.extension.id,
                    `browser:${input.sourceId}`,
                    credentialEpoch ?? pkg.digest,
                  ]),
                  vault: options.vault,
                  origins: pkg.manifest.requestedAccess.networkOrigins,
                  privateOrigins: sourceOptions.privateOrigins,
                  outboundProxy: process.env.SOURCE_OUTBOUND_PROXY,
                  browserMode: 'browserMode' in sourceOptions ? sourceOptions.browserMode : undefined,
                },
                requestSignal,
              );
            },
          },
          signal,
          timeoutMs:
            method === 'source.listReleases' ? 10 * 60_000 : pkg.manifest.requestedAccess.webview ? 120000 : 30000,
          profile: pkg.manifest.requestedAccess.webview ? 'source-webview-v1' : undefined,
        });
        if (method === 'source.getContent' && validateSourceContentRequest(result)) {
          broker.dispose(); // Nothing from the completed guest realm is needed during the host job.
          return {
            ...(await materializeSourceContent(pkg, String(input.sourceId), result, signal, async (scope) => {
              if (options.contentResolver) {
                try {
                  return await options.contentResolver(scope);
                } catch (error) {
                  if (!(error instanceof Error) || error.message !== 'source_content_service_required') throw error;
                }
              }
              if (!storedContent) throw new Error('source_content_service_required');
              return storedContent.resolve(scope, credentialEpoch);
            })),
            stateChanges: storage.changes(),
          };
        }
        if (!validateSourceResult(method, result)) throw new Error('invalid_source_result');
        const content = method === 'source.getContent' ? (result as SourceContent) : undefined;
        const refs = content
          ? content.kind === 'text'
            ? [content.asset]
            : content.assets
          : method === 'source.getCover' && result
            ? [result as SourceAsset]
            : [];
        return {
          result,
          stateChanges: storage.changes(),
          assets: new Map(
            refs.map((ref) => {
              const asset = broker.takeAsset(ref.handle);
              return [ref.handle, new Blob([Uint8Array.from(asset.bytes)], { type: asset.contentType })];
            }),
          ),
        };
      } finally {
        broker.dispose();
      }
    },
  };
}
