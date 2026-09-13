import { validContentConnectionRequest } from '../../../../packages/extension-contracts/source-content-service.js';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { validateSourceAuthenticationRequest } from '@noveldesk/extension-contracts/package';
import type { PackageInstallStore } from '../../../../src/extensions/packages/package-install-store.js';
import { PackageRepositories } from '../../../../src/extensions/packages/package-repositories.js';
import {
  PackageRuntimeCatalog,
  type PackageExecutionPort,
} from '../../../../src/extensions/packages/package-runtime-catalog.js';
import { InstalledPackageSourceRegistry } from '../../../../src/external-sources/installed-package-source-registry.js';
import { AppExternalSourceRegistry } from '../../../../src/external-sources/app-external-source-registry.js';
import type { ExternalSourceDownloadRef, ExternalSourceListInput } from '../../../../src/external-sources/contracts.js';
import type { ApkExtensionHost } from '../extensions/apk-extension-host.js';
import type { MangayomiExtensionHost } from '../extensions/mangayomi/host.js';
import { compositeSourceRegistry } from '../../../../src/external-sources/composite-source-registry.js';
import { registerPreparedSourceImages, type StageServerImageImport } from './prepared-source-images.js';
import { registerPreparedSourceDocuments, type ServerDocumentImports } from './prepared-source-documents.js';

const PREFIX = '/api/extensions';
const context = { brokers: { get: () => undefined } };
const safeCodes = new Set([
  'import_expected_base_conflict',
  'prepared_download_unavailable',
  'compatibility_feature_unsupported',
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
  'source_address_denied',
  'apk_android_feature_unsupported',
  'apk_worker_busy',
  'apk_request_timeout',
  'apk_page_limit',
  'source_content_service_required',
  'source_content_service_denied',
  'source_content_service_auth',
  'source_content_service_timeout',
  'source_content_service_invalid',
  'source_content_service_failed',
  'source_content_verification_required',
  'package_version_conflict',
  'package_approval_mismatch',
  'package_install_conflict',
  'publisher_change_requires_review',
  'package_downgrade_requires_review',
  'package_limit',
  'invalid_package',
  'invalid_package_manifest',
  'unsupported_package_api',
  'unsupported_package_runtime',
  'unsupported_package_capability',
  'source_manifest_mismatch',
  'execution_busy',
  'execution_timeout',
  'source_auth_required',
  'source_auth_forbidden',
  'source_auth_unavailable',
  'invalid_package_repository',
  'package_repository_suwayomi',
  'package_repository_mangayomi',
  'package_repository_integrity',
  'package_update_publisher_mismatch',
  'package_repository_conflict',
  'package_repository_limit',
  'package_repository_origin_denied',
  'source_rate_limited',
  'source_body_limit',
  'source_storage_limit',
  'source_storage_conflict',
  'package_source_unavailable',
]);

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function withCancellation<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => {
    if (!reply.raw.writableFinished) controller.abort();
  };
  request.raw.once('aborted', cancel);
  reply.raw.once('close', cancel);
  return run(controller.signal).finally(() => {
    request.raw.removeListener('aborted', cancel);
    reply.raw.removeListener('close', cancel);
  });
}

/** Call only after the application's authentication hook. The store is already fixed to the server owner. */
export async function registerExtensionPackageRoutes(
  app: FastifyInstance,
  store: PackageInstallStore,
  execution: PackageExecutionPort,
  apk?: ApkExtensionHost,
  mangayomi?: MangayomiExtensionHost,
  migratedTextSources: ReadonlySet<string> = new Set(),
  stageImageImport?: StageServerImageImport,
  documentImports?: ServerDocumentImports,
): Promise<PackageRuntimeCatalog> {
  const catalog = new PackageRuntimeCatalog(store, execution);
  const repositories = new PackageRepositories(store, execution);
  const installed = new InstalledPackageSourceRegistry(catalog);
  const apkRegistry = apk ? new InstalledPackageSourceRegistry(apk.catalog) : undefined;
  const mgRegistry = mangayomi ? new InstalledPackageSourceRegistry(mangayomi.catalog) : undefined;
  const imageRegistry = apkRegistry ? compositeSourceRegistry(installed, apkRegistry) : installed;
  const registry = new AppExternalSourceRegistry(
    [],
    mgRegistry ? compositeSourceRegistry(imageRegistry, mgRegistry) : imageRegistry,
  );
  app.addHook('onClose', async () => {
    installed.dispose();
    apkRegistry?.dispose();
    mgRegistry?.dispose();
    catalog.dispose();
  });
  const handle = async (reply: FastifyReply, run: () => Promise<unknown>) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = safeCodes.has(message) ? message : 'extension_operation_failed';
      const status =
        code === 'execution_busy' || code === 'source_rate_limited'
          ? 429
          : code === 'execution_timeout'
            ? 504
            : code === 'package_limit' || code === 'source_body_limit'
              ? 413
              : code.includes('conflict')
                ? 409
                : 422;
      // Guest/provider errors cannot become 401 and invalidate the user's Moya login.
      return reply.code(status).send({ error: code });
    }
  };

  app.get(`${PREFIX}/packages`, (_request, reply) =>
    handle(reply, async () => {
      await catalog.refresh();
      return {
        preparedImageImports: Boolean(stageImageImport),
        preparedDocumentImports: Boolean(documentImports),
        packages: await store.list(),
        sources: registry
          .getExternalSources()
          .filter((source) => !migratedTextSources.has(source.descriptor.id))
          .map((source) => {
            const entry = apk?.catalog.getSource(source.descriptor.id);
            const mg = mangayomi?.catalog.getSource(source.descriptor.id);
            if (mg) return { ...source, mangayomiPackageId: mg.packageId, generation: mg.generation };
            return entry ? { ...source, apkPackageId: entry.packageId, generation: entry.generation } : source;
          }),
        errors: catalog.getErrors(),
      };
    }),
  );
  app.get(`${PREFIX}/repositories`, (_request, reply) => handle(reply, () => repositories.list()));
  for (const action of ['refresh', 'remove', 'download'] as const)
    app.post(`${PREFIX}/repositories/${action}`, { bodyLimit: 8192 }, (request, reply) =>
      handle(reply, () =>
        withCancellation(request, reply, async (signal) => {
          const body = request.body;
          if (
            !object(body) ||
            typeof body.url !== 'string' ||
            Object.keys(body).some((key) => !['url', 'revision', 'id', 'sha256'].includes(key))
          )
            return reply.code(400).send({ error: 'invalid_package_repository' });
          if (action === 'refresh') return repositories.refresh(body.url, signal);
          if (action === 'remove') {
            if (!revision(body.revision)) return reply.code(400).send({ error: 'invalid_package_repository' });
            await repositories.remove(body.url, body.revision);
            return { removed: true };
          }
          if (typeof body.id !== 'string' || typeof body.sha256 !== 'string')
            return reply.code(400).send({ error: 'invalid_package_repository' });
          const archive = await repositories.download(body.url, body.id, body.sha256, signal);
          reply.header('Content-Type', 'application/octet-stream').header('Content-Length', archive.size);
          return reply.send(Readable.fromWeb(archive.stream() as import('node:stream/web').ReadableStream));
        }),
      ),
    );

  app.post(`${PREFIX}/packages/inspect`, { bodyLimit: 10 * 1024 * 1024 }, (request, reply) =>
    handle(reply, () =>
      withCancellation(request, reply, async (signal) => {
        if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: 'package_body_required' });
        const plan = await catalog.installer.inspect(new Blob([Uint8Array.from(request.body)]), signal);
        const { package: pkg, ...review } = plan;
        return {
          ...review,
          package: { digest: pkg.digest, manifest: pkg.manifest, publisherFingerprint: pkg.publisherFingerprint },
        };
      }),
    ),
  );

  app.post(`${PREFIX}/packages/install`, { bodyLimit: 10 * 1024 * 1024 }, (request, reply) =>
    handle(reply, () =>
      withCancellation(request, reply, async (signal) => {
        const query = request.query;
        if (
          !Buffer.isBuffer(request.body) ||
          !object(query) ||
          typeof query.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(query.digest) ||
          typeof query.revision !== 'string' ||
          !/^\d{1,15}$/.test(query.revision) ||
          Object.keys(query).some((key) => !['digest', 'revision', 'publisherChange', 'downgrade'].includes(key)) ||
          [query.publisherChange, query.downgrade].some((value) => value !== undefined && value !== '1')
        )
          return reply.code(400).send({ error: 'invalid_package_approval' });
        const plan = await catalog.installer.inspect(new Blob([Uint8Array.from(request.body)]), signal);
        if (plan.expectedRevision !== Number(query.revision))
          return reply.code(409).send({ error: 'package_install_conflict' });
        await catalog.installer.install(
          plan,
          { digest: query.digest, publisherChange: query.publisherChange === '1', downgrade: query.downgrade === '1' },
          signal,
        );
        await catalog.refresh();
        return { installed: true };
      }),
    ),
  );

  app.post<{ Params: { id: string } }>(`${PREFIX}/packages/:id/change`, { bodyLimit: 4096 }, (request, reply) =>
    handle(reply, async () => {
      const body = request.body;
      if (
        !object(body) ||
        !revision(body.revision) ||
        !['enable', 'disable', 'rollback', 'remove'].includes(String(body.action)) ||
        Object.keys(body).some((key) => !['revision', 'action'].includes(key))
      )
        return reply.code(400).send({ error: 'invalid_package_change' });
      const id = request.params.id;
      if (body.action === 'remove') await catalog.installer.remove(id, body.revision);
      else if (body.action === 'rollback') await catalog.installer.rollback(id, body.revision);
      else await catalog.installer.setEnabled(id, body.revision, body.action === 'enable');
      await catalog.refresh();
      return { changed: true };
    }),
  );

  app.post<{ Params: { id: string } }>(`${PREFIX}/packages/:id/update`, { bodyLimit: 1024 }, (request, reply) =>
    handle(reply, () =>
      withCancellation(request, reply, async (signal) => {
        if (
          !object(request.body) ||
          !revision(request.body.revision) ||
          Object.keys(request.body).some((key) => key !== 'revision')
        )
          return reply.code(400).send({ error: 'invalid_package_update' });
        const archive = await catalog.checkUpdate(request.params.id, request.body.revision, signal);
        if (!archive) return reply.code(204).send();
        reply.header('Content-Type', 'application/octet-stream').header('Content-Length', archive.size);
        return reply.send(Readable.fromWeb(archive.stream() as import('node:stream/web').ReadableStream));
      }),
    ),
  );

  app.post<{ Params: { id: string } }>(`${PREFIX}/sources/:id/list`, { bodyLimit: 16 * 1024 }, (request, reply) =>
    handle(reply, () =>
      withCancellation(request, reply, async (signal) => {
        if (!object(request.body)) return reply.code(400).send({ error: 'invalid_source_input' });
        await catalog.refresh();
        return registry.listExternalSource(
          request.params.id as ExtensionContributionId,
          context,
          request.body as ExternalSourceListInput,
          signal,
        );
      }),
    ),
  );

  app.post<{ Params: { id: string } }>(
    `${PREFIX}/sources/:id/preferences`,
    { bodyLimit: 64 * 1024 },
    (request, reply) =>
      handle(reply, () =>
        withCancellation(request, reply, async (signal) => {
          const { validSourcePreferencesRequest } =
            await import('../../../../packages/extension-contracts/source-preferences.js');
          if (!validSourcePreferencesRequest(request.body))
            return reply.code(400).send({ error: 'invalid_source_preferences' });
          return catalog.preferences(request.params.id, request.body, signal);
        }),
      ),
  );
  app.post<{ Params: { id: string } }>(
    `${PREFIX}/sources/:id/content-connection`,
    { bodyLimit: 16 * 1024 },
    (request, reply) =>
      handle(reply, () =>
        withCancellation(request, reply, async (signal) => {
          if (!validContentConnectionRequest(request.body))
            return reply.code(400).send({ error: 'source_content_service_denied' });
          return catalog.contentConnection(request.params.id, request.body, signal);
        }),
      ),
  );
  app.post<{ Params: { id: string } }>(
    `${PREFIX}/sources/:id/authentication`,
    { bodyLimit: 16 * 1024 },
    (request, reply) =>
      handle(reply, () =>
        withCancellation(request, reply, async (signal) => {
          if (!validateSourceAuthenticationRequest(request.body))
            return reply.code(400).send({ error: 'invalid_source_authentication' });
          return catalog.authenticate(request.params.id, request.body, signal);
        }),
      ),
  );

  app.post<{ Params: { id: string } }>(`${PREFIX}/sources/:id/download`, { bodyLimit: 16 * 1024 }, (request, reply) =>
    handle(reply, () =>
      withCancellation(request, reply, async (signal) => {
        const body = request.body;
        if (
          !object(body) ||
          !object(body.key) ||
          typeof body.fileName !== 'string' ||
          body.fileName.length > 1024 ||
          typeof body.key.remoteId !== 'string' ||
          body.key.remoteId.length > 4096 ||
          body.key.connectorId !== request.params.id
        )
          return reply.code(400).send({ error: 'invalid_source_input' });
        await catalog.refresh();
        const result = await registry.downloadExternalSource(
          request.params.id as ExtensionContributionId,
          context,
          body as unknown as ExternalSourceDownloadRef,
          signal,
        );
        reply.header('Content-Type', result.file.type).header('Content-Length', result.file.size);
        return reply.send(Readable.fromWeb(result.file.stream() as import('node:stream/web').ReadableStream));
      }),
    ),
  );

  app.post<{ Params: { id: string } }>(`${PREFIX}/sources/:id/cover`, { bodyLimit: 4096 }, (request, reply) =>
    handle(reply, () =>
      withCancellation(request, reply, async (signal) => {
        if (!object(request.body) || typeof request.body.workId !== 'string')
          return reply.code(400).send({ error: 'invalid_source_input' });
        await catalog.refresh();
        const sourceCatalog = apk?.catalog.getSource(request.params.id)
          ? apk.catalog
          : mangayomi?.catalog.getSource(request.params.id)
            ? mangayomi.catalog
            : catalog;
        const { result, assets } = await sourceCatalog.invoke(
          request.params.id,
          'source.getCover',
          { workId: request.body.workId },
          signal,
        );
        if (!result) return reply.code(404).send({ error: 'cover_unavailable' });
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(result.contentType))
          return reply.code(422).send({ error: 'invalid_source_image' });
        const blob = assets.get(result.handle)!;
        reply.header('Content-Type', blob.type).header('Content-Length', blob.size);
        return reply.send(Readable.fromWeb(blob.stream() as import('node:stream/web').ReadableStream));
      }),
    ),
  );
  if (stageImageImport)
    registerPreparedSourceImages(app, registry, () => catalog.refresh(), stageImageImport, handle, withCancellation);
  if (documentImports)
    registerPreparedSourceDocuments(app, registry, () => catalog.refresh(), documentImports, handle, withCancellation);
  return catalog;
}
