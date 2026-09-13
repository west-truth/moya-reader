import type { PackageRuntimeCatalog } from '../../../../src/extensions/packages/package-runtime-catalog.js';
import { createHash } from 'node:crypto';
import { textServerNamespace } from '../../../../src/external-sources/text-server/text-server-client.js';

interface TextMigration {
  identity: { instanceId: string; dataNamespace: string; accountId?: string; label?: string };
  sources: { legacyId: string; packageId: string; sourceId: string }[];
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = (value: unknown): value is string =>
  // eslint-disable-next-line no-control-regex -- Reject control characters in persisted operator identities.
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);

/** Operator-owned identity mapping, never a package claim or inferred title match. */
export function parseInstalledTextMigration(raw: string | undefined): TextMigration | undefined {
  if (!raw) return undefined;
  try {
    if (Buffer.byteLength(raw) > 65536) throw new Error();
    const value = JSON.parse(raw) as TextMigration;
    if (
      !value ||
      !value.identity ||
      !text(value.identity.instanceId) ||
      !text(value.identity.dataNamespace) ||
      (value.identity.accountId !== undefined && !text(value.identity.accountId)) ||
      (value.identity.label !== undefined && !text(value.identity.label)) ||
      !Array.isArray(value.sources) ||
      !value.sources.length ||
      value.sources.length > 100 ||
      new Set(value.sources.map((row) => row.legacyId)).size !== value.sources.length ||
      new Set(value.sources.map((row) => row.sourceId)).size !== value.sources.length ||
      value.sources.some(
        (row) =>
          !row ||
          !id(row.legacyId) ||
          !text(row.packageId) ||
          !text(row.sourceId) ||
          !/^[a-z0-9][a-z0-9._-]+$/.test(row.packageId) ||
          !row.sourceId.startsWith(row.packageId + '.'),
      )
    )
      throw new Error();
    return value;
  } catch {
    throw new Error('invalid_installed_text_migration');
  }
}

/** Keep the existing text protocol identity while executing installed SDK packages in the normal host. */
export function createInstalledTextGateway(catalog: PackageRuntimeCatalog, migration: TextMigration) {
  const namespace = textServerNamespace(migration.identity);
  return async (path: string, signal: AbortSignal): Promise<Response> => {
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json', 'X-Moya-Source-Namespace': namespace },
      });
    try {
      signal.throwIfAborted();
      const url = new URL(path, 'http://moya.invalid');
      if (url.pathname === '/v1/health')
        return json({
          ...migration.identity,
          protocolVersion: 1,
          capabilities: ['catalog', 'txt-content', 'cover-read'],
        });
      await catalog.refresh();
      const available = (binding: TextMigration['sources'][number]) => {
        const source = catalog.getSource(binding.sourceId);
        return source?.packageId === binding.packageId && source.descriptor.seriesProfile?.kind === 'document_series'
          ? source
          : undefined;
      };
      if (url.pathname === '/v1/sources')
        return json({
          items: migration.sources.map((binding) => {
            const source = available(binding);
            return {
              id: binding.legacyId,
              title: source?.descriptor.title ?? binding.legacyId,
              available: !!source,
              capabilities: ['search', 'txt-content', 'cover-read'],
            };
          }),
        });
      const match =
        /^\/v1\/sources\/([A-Za-z0-9_-]+)\/works(?:\/([A-Za-z0-9_-]+)(?:\/(cover|releases)(?:\/([A-Za-z0-9_-]+)\/content)?)?)?$/.exec(
          url.pathname,
        );
      if (!match) return json({ error: 'not_found' }, 404);
      const [, legacyId, workId, action, releaseId] = match;
      const binding = migration.sources.find((row) => row.legacyId === legacyId);
      if (!binding) return json({ error: 'not_found' }, 404);
      const source = available(binding);
      if (!source) return json({ error: 'source_busy' }, 503);
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const request = { workId, releaseId, cursor, query: url.searchParams.get('query') ?? undefined };
      const method = !workId
        ? 'source.listWorks'
        : releaseId
          ? 'source.getContent'
          : action === 'releases'
            ? 'source.listReleases'
            : action === 'cover'
              ? 'source.getCover'
              : 'source.getWork';
      const { result, assets } = await catalog.invoke(binding.sourceId, method, request, signal);
      signal.throwIfAborted();
      if (catalog.getSource(binding.sourceId)?.generation !== source.generation)
        throw new Error('package_generation_changed');
      if (method === 'source.getContent' || method === 'source.getCover') {
        if (!result) return json({ error: 'not_found' }, 404);
        const value = result as { kind?: string; asset?: { handle: string }; handle?: string };
        if (method === 'source.getContent' && value.kind !== 'text') throw new Error('invalid_source_result');
        const blob = assets.get(value.asset?.handle ?? value.handle ?? '');
        if (!blob || blob.size > (method === 'source.getContent' ? 2 : 8) * 1024 * 1024)
          throw new Error('source_body_limit');
        const etag =
          '"' +
          createHash('sha256')
            .update(new Uint8Array(await blob.arrayBuffer()))
            .digest('hex') +
          '"';
        signal.throwIfAborted();
        return new Response(blob, {
          headers: {
            'Content-Type': blob.type,
            'Content-Length': String(blob.size),
            'X-Moya-Source-Namespace': namespace,
            ETag: etag,
          },
        });
      }
      if (method === 'source.getWork')
        return json({
          ...result,
          seriesProfile: { kind: 'document_series', format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
        });
      const page = result as { items: { id: string; title: string; order?: number }[]; nextCursor?: string };
      if (page.items.some((row) => !id(row.id)) || (page.nextCursor && page.nextCursor.length > 512))
        throw new Error('invalid_source_result');
      return json({
        ...page,
        items: page.items.map((row) => (method === 'source.listReleases' ? { ...row, sourceOrder: row.order } : row)),
      });
    } catch (error) {
      signal.throwIfAborted();
      const code = error instanceof Error ? error.message : '';
      const errors: Record<string, string> = {
        source_content_service_required: 'content_provider_not_configured',
        source_content_service_auth: 'content_provider_authentication_required',
        source_content_service_timeout: 'content_provider_request_timeout',
        source_content_verification_required: 'source_verification_required',
        source_auth_required: 'source_authentication_required',
        source_auth_forbidden: 'source_access_required',
        source_body_limit: 'source_size_limit',
        execution_busy: 'source_busy',
      };
      return json({ error: errors[code] ?? 'source_request_failed' }, code === 'source_body_limit' ? 413 : 502);
    }
  };
}
