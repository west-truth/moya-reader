import { validContentConnectionRequest } from '../../packages/extension-contracts/source-content-service';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { verifyMoyaExtension, type VerifiedMoyaPackage } from '../../src/extensions/packages/package-archive';
import { SOURCE_METHODS, validateSourceInput, type SourceMethod } from '@noveldesk/extension-contracts/source-protocol';
import { createNodePackageExecution } from '../../apps/server/src/extensions/node-package-execution';
import type { SourceStateValues } from '../../src/extensions/packages/source-state';
import { validateSourceAuthenticationRequest } from '@noveldesk/extension-contracts/package';
import type { SourceCredentialVault } from '../../apps/server/src/extensions/source-credential-vault';
import type { SourceTransport } from '../../apps/server/src/extensions/source-authentication';
import type { SourceContentResolver } from '../../apps/server/src/extensions/source-content-service';
import type { ApkExtensionHost } from '../../apps/server/src/extensions/apk-extension-host';
import type { MangayomiExtensionHost } from '../../apps/server/src/extensions/mangayomi/host';
import { dispatchApkCommand } from '../../apps/server/src/extensions/apk-command';
import { SOURCE_DOWNLOAD_TIMEOUT_MS } from '../../packages/extension-runtime/content-limits.mjs';

const MAX_ARCHIVE = 10 * 1024 * 1024;
const MAX_METADATA = 2 * 1024 * 1024;
const SAFE_ERRORS = new Set([
  'compatibility_repository_mismatch',
  'compatibility_repository_invalid',
  'compatibility_feature_unsupported',
  'compatibility_preferences_invalid',
  'package_repository_mangayomi',
  'apk_input_invalid',
  'compatibility_file_invalid',
  'compatibility_filter_unsupported',
  'invalid_source_filters',
  'apk_worker_unavailable',
  'apk_publisher_changed',
  'apk_version_not_newer',
  'source_address_denied',
  'source_http_failed',
  'source_connection_failed',
  'source_request_timeout',
  'source_browser_unavailable',
  'source_browser_failed',
  'invalid_source_preferences',
  'source_preferences_conflict',
  'source_work_unavailable',
  'source_release_unavailable',
  'invalid_source_assets',
  'apk_worker_busy',
  'apk_request_timeout',
  'apk_page_limit',
  'apk_review_limit',
  'apk_install_conflict',
  'apk_repository_conflict',
  'apk_verification_failed',
  'apk_android_feature_unsupported',
  'apk_review_expired',
  'source_content_service_required',
  'source_content_service_denied',
  'source_content_service_auth',
  'source_content_service_timeout',
  'source_content_service_invalid',
  'source_content_service_failed',
  'source_content_verification_required',
  'execution_busy',
  'execution_timeout',
  'source_auth_required',
  'source_auth_forbidden',
  'source_auth_unavailable',
  'package_update_publisher_mismatch',
  'package_repository_integrity',
  'invalid_package_repository',
  'package_repository_suwayomi',
  'source_rate_limited',
  'source_body_limit',
  'source_storage_limit',
  'source_storage_conflict',
  'cancelled',
  'unsupported_package_runtime',
  'unsupported_package_capability',
  'source_manifest_mismatch',
]);
async function body(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of request) {
    length += part.length;
    if (length > maximum) throw new Error('source_body_limit');
    parts.push(part);
  }
  return Buffer.concat(parts, length);
}

async function sendAssets(
  reply: ServerResponse,
  value: { result: unknown; assets: ReadonlyMap<string, Blob>; stateChanges?: unknown },
  signal: AbortSignal,
) {
  const metadata = Buffer.from(
    JSON.stringify({
      result: value.result,
      stateChanges: value.stateChanges,
      assets: [...value.assets].map(([handle, blob]) => ({ handle, size: blob.size, type: blob.type })),
    }),
  );
  if (metadata.length > MAX_METADATA) throw new Error('source_body_limit');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(metadata.length);
  const size = 4 + metadata.length + [...value.assets.values()].reduce((sum, blob) => sum + blob.size, 0);
  reply.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
  const stream = Readable.from(
    (async function* () {
      yield prefix;
      yield metadata;
      for (const blob of value.assets.values())
        for await (const chunk of Readable.fromWeb(blob.stream() as import('node:stream/web').ReadableStream)) {
          signal.throwIfAborted();
          yield chunk;
        }
    })(),
  );
  stream.on('error', () => reply.destroy());
  reply.once('close', () => stream.destroy());
  // Keep cancellation connected until every response byte was sent.
  await new Promise<void>((resolve) => {
    reply.once('finish', resolve);
    reply.once('close', resolve);
    stream.pipe(reply);
  });
}

/** Authenticated loopback execution only. No file paths, library data or OS objects are exposed. */
export async function startNativeExtensionHost(
  token: string,
  origin: string,
  options: {
    vault?: SourceCredentialVault;
    transport?: SourceTransport;
    contentResolver?: SourceContentResolver;
    apk?: ApkExtensionHost;
    mangayomi?: MangayomiExtensionHost;
  } = {},
) {
  if (
    !/^[A-Za-z0-9_-]{43,128}$/.test(token) ||
    !/^(?:https?:\/\/(?:tauri\.localhost|127\.0\.0\.1)(?::\d{1,5})?|tauri:\/\/localhost)$/.test(origin)
  )
    throw new Error('invalid_native_configuration');
  const expected = Buffer.from(`Bearer ${token}`);
  const execution = createNodePackageExecution('tauri-native', options);
  const prepared = new Map<string, VerifiedMoyaPackage>();
  const active = new Set<AbortController>();
  const completions = new Set<Promise<void>>();
  const json = (reply: ServerResponse, status: number, value: unknown) =>
    reply.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  const server = createServer(async (request, reply) => {
    reply.setHeader('Cache-Control', 'no-store');
    reply.setHeader('X-Content-Type-Options', 'nosniff');
    const address = server.address();
    if (
      !address ||
      typeof address === 'string' ||
      request.headers.host !== `127.0.0.1:${address.port}` ||
      (request.headers.origin && request.headers.origin !== origin)
    ) {
      json(reply, 403, { error: 'native_access_denied' });
      return;
    }
    if (request.headers.origin) {
      reply.setHeader('Access-Control-Allow-Origin', origin);
      reply.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      reply.setHeader('Access-Control-Allow-Methods', 'POST');
      reply.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
      reply.writeHead(204).end();
      return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      json(reply, 401, { error: 'native_access_denied' });
      return;
    }
    if (
      request.method !== 'POST' ||
      ![
        '/prepare',
        '/invoke',
        '/authentication',
        '/content-connection',
        '/preferences',
        '/credentials-retain',
        '/update',
        '/repository-list',
        '/repository-download',
        '/apk',
        '/mangayomi',
      ].includes(request.url ?? '')
    ) {
      json(reply, 404, { error: 'native_route_unavailable' });
      return;
    }
    if (active.size >= 4) {
      json(reply, 429, { error: 'execution_busy' });
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    completions.add(completion);
    const cancel = () => {
      if (!reply.writableFinished) controller.abort();
    };
    request.once('aborted', cancel);
    reply.once('close', cancel);
    const timer = setTimeout(
      () => controller.abort(),
      request.url === '/mangayomi' || request.url === '/apk' ? SOURCE_DOWNLOAD_TIMEOUT_MS : 60000,
    );
    try {
      if (request.url === '/apk' || request.url === '/mangayomi') {
        const input = JSON.parse((await body(request, 45 * 1024 * 1024)).toString('utf8'));
        const response = await dispatchApkCommand(
          request.url === '/apk' ? options.apk : options.mangayomi,
          input,
          controller.signal,
        );
        if (response.kind === 'assets') await sendAssets(reply, response.value, controller.signal);
        else json(reply, 200, response.value);
      } else if (request.url === '/prepare') {
        const archive = await body(request, MAX_ARCHIVE);
        const pkg = await verifyMoyaExtension(new Blob([Uint8Array.from(archive)]), controller.signal);
        await execution.prepare(pkg, controller.signal);
        controller.signal.throwIfAborted();
        if (prepared.size >= 4) prepared.delete(prepared.keys().next().value!);
        prepared.set(pkg.digest, pkg);
        json(reply, 200, { digest: pkg.digest });
      } else if (request.url === '/repository-list' || request.url === '/repository-download') {
        const input = JSON.parse((await body(request, 8192)).toString('utf8'));
        if (typeof input?.url !== 'string') throw new Error('invalid_package_repository');
        if (request.url === '/repository-list') {
          json(reply, 200, await execution.listRepository!(input.url, controller.signal));
        } else {
          const archive = await execution.downloadRepository!(input.url, input.entry, controller.signal);
          const bytes = Buffer.from(await archive.arrayBuffer());
          controller.signal.throwIfAborted();
          reply
            .writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length })
            .end(bytes);
        }
      } else if (request.url === '/update') {
        const input = JSON.parse((await body(request, 1024)).toString('utf8'));
        if (typeof input?.digest !== 'string') throw new Error('invalid_package_update');
        const pkg = prepared.get(input.digest);
        if (!pkg) {
          json(reply, 409, { error: 'package_not_prepared' });
          return;
        }
        if (!execution.checkUpdate) throw new Error('package_update_unavailable');
        const archive = await execution.checkUpdate(pkg, controller.signal);
        if (!archive) {
          reply.writeHead(204).end();
          return;
        }
        const bytes = Buffer.from(await archive.arrayBuffer());
        controller.signal.throwIfAborted();
        reply.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }).end(bytes);
      } else if (request.url === '/credentials-retain') {
        const value = JSON.parse((await body(request, 1024)).toString('utf8'));
        if (
          typeof value?.packageId !== 'string' ||
          value.packageId.length > 256 ||
          (value.epoch !== undefined &&
            (typeof value.epoch !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.epoch)))
        )
          throw new Error('invalid_source_authentication');
        await execution.retainAuthentication?.(value.packageId, value.epoch);
        json(reply, 200, { retained: true });
      } else if (request.url === '/preferences') {
        const value = JSON.parse((await body(request, 64 * 1024)).toString('utf8'));
        const { validSourcePreferencesRequest } =
          await import('../../packages/extension-contracts/source-preferences.js');
        if (
          typeof value?.digest !== 'string' ||
          typeof value.sourceId !== 'string' ||
          typeof value.epoch !== 'string' ||
          !validSourcePreferencesRequest(value.request)
        )
          throw new Error('invalid_source_preferences');
        const pkg = prepared.get(value.digest);
        if (!pkg) {
          json(reply, 409, { error: 'package_not_prepared' });
          return;
        }
        if (!execution.preferences) throw new Error('invalid_source_preferences');
        json(
          reply,
          200,
          await execution.preferences(pkg, value.sourceId, value.epoch, value.request, controller.signal),
        );
      } else if (request.url === '/content-connection') {
        const value = JSON.parse((await body(request, 16 * 1024)).toString('utf8'));
        if (
          typeof value?.digest !== 'string' ||
          typeof value.sourceId !== 'string' ||
          typeof value.epoch !== 'string' ||
          !validContentConnectionRequest(value.request)
        )
          throw new Error('source_content_service_denied');
        const pkg = prepared.get(value.digest);
        if (!pkg) {
          json(reply, 409, { error: 'package_not_prepared' });
          return;
        }
        if (!execution.contentConnection) throw new Error('source_content_service_required');
        json(
          reply,
          200,
          await execution.contentConnection(pkg, value.sourceId, value.epoch, value.request, controller.signal),
        );
      } else if (request.url === '/authentication') {
        const value = JSON.parse((await body(request, 16 * 1024)).toString('utf8'));
        if (
          typeof value?.digest !== 'string' ||
          typeof value.sourceId !== 'string' ||
          typeof value.epoch !== 'string' ||
          !validateSourceAuthenticationRequest(value.request)
        )
          throw new Error('invalid_source_authentication');
        const pkg = prepared.get(value.digest);
        if (!pkg) {
          json(reply, 409, { error: 'package_not_prepared' });
          return;
        }
        if (!execution.authenticate) throw new Error('source_auth_unavailable');
        json(
          reply,
          200,
          await execution.authenticate(pkg, value.sourceId, value.epoch, value.request, controller.signal),
        );
      } else {
        const input = JSON.parse((await body(request, MAX_METADATA)).toString('utf8')) as {
          digest?: unknown;
          method?: unknown;
          input?: unknown;
          state?: SourceStateValues;
          credentialEpoch?: string;
        };
        if (
          typeof input?.digest !== 'string' ||
          typeof input.method !== 'string' ||
          !SOURCE_METHODS.includes(input.method as SourceMethod) ||
          !validateSourceInput(input.method as SourceMethod, input.input)
        )
          throw new Error('invalid_source_invocation');
        const pkg = prepared.get(input.digest);
        if (!pkg) {
          json(reply, 409, { error: 'package_not_prepared' });
          return;
        }
        const value = await execution.invoke(
          pkg,
          input.method as SourceMethod,
          input.input,
          controller.signal,
          input.state,
          input.credentialEpoch,
        );
        controller.signal.throwIfAborted();
        await sendAssets(reply, value, controller.signal);
      }
    } catch (error) {
      if (!reply.headersSent)
        json(reply, 422, {
          error:
            error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : 'extension_operation_failed',
        });
      else reply.destroy();
    } finally {
      clearTimeout(timer);
      active.delete(controller);
      request.removeListener('aborted', cancel);
      reply.removeListener('close', cancel);
      completions.delete(completion);
      complete();
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('native_start_failed');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    async close() {
      options.apk?.close();
      options.mangayomi?.close();
      for (const controller of active) controller.abort();
      prepared.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // The runtime settles only after child close; do not orphan a running guest on app exit.
      await Promise.all(completions);
    },
  };
}
