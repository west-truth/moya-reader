import type { SourceCredentialVault } from './source-credential-vault.js';
import type { VerifiedMoyaPackage } from '../../../../src/extensions/packages/package-archive.js';
import {
  validContentConnectionRequest,
  type ContentConnectionRequest,
  type ContentConnectionStatus,
} from '../../../../packages/extension-contracts/source-content-service.js';
import type { ContentServiceScope } from './source-content-service.js';
import { createBoundContentService } from './configured-content-service.js';

/** Per-source settings, encrypted with the existing host vault. No shared connection-profile UI. */
export function createStoredContentService(
  vault: SourceCredentialVault,
  fetchImpl: typeof fetch = fetch,
  options: Parameters<typeof createBoundContentService>[2] = {},
) {
  const scopeKey = (pkg: string, source: string, epoch: string) => JSON.stringify([pkg, `content:${source}`, epoch]);
  const read = (key: string): { endpoint: string; key?: string } | undefined => {
    const saved = vault.read(key);
    return saved ? JSON.parse(saved.secret) : undefined;
  };
  let pending = 0;
  return {
    async manage(
      pkg: VerifiedMoyaPackage,
      sourceId: string,
      epoch: string,
      request: ContentConnectionRequest,
      signal: AbortSignal,
    ): Promise<ContentConnectionStatus> {
      if (
        !/^[A-Za-z0-9_-]{1,100}$/.test(epoch) ||
        !validContentConnectionRequest(request) ||
        !pkg.manifest.requestedAccess.contentServices?.some((s) => s.sourceId === sourceId)
      )
        throw new Error('source_content_service_denied');
      signal.throwIfAborted();
      const scope = scopeKey(pkg.manifest.extension.id, sourceId, epoch),
        saved = read(scope);
      if (request.action === 'remove') {
        vault.write(scope, undefined);
        return { configured: false };
      }
      if (request.action === 'status')
        return { configured: !!saved, ...(saved ? { endpoint: saved.endpoint, keySaved: !!saved.key } : {}) };
      let endpoint: string;
      try {
        const url = new URL(request.endpoint);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== '/'
        )
          throw new Error();
        endpoint = url.origin;
      } catch {
        throw new Error('source_content_service_denied');
      }
      const key = request.key || (saved?.endpoint === endpoint ? saved.key : undefined);
      let response: Response;
      try {
        response = await fetchImpl(endpoint + '/health', {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new Error('source_content_service_auth');
        }
        if (!response.ok || Number(response.headers.get('content-length')) > 65536) {
          await response.body?.cancel();
          throw new Error('source_content_service_failed');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('source_content_service_failed');
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const row = await reader.read();
            if (row.done) break;
            size += row.value.length;
            if (size > 65536) throw new Error('source_content_service_failed');
            parts.push(row.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        const health = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (health.protocol !== 1 || health.ready !== true) throw new Error('source_content_service_failed');
      } catch (error) {
        signal.throwIfAborted();
        // eslint-disable-next-line preserve-caught-error -- Upstream URLs and headers must not leave this vault boundary.
        throw new Error(
          error instanceof Error && error.message === 'source_content_service_auth'
            ? 'source_content_service_auth'
            : 'source_content_service_failed',
        );
      }
      signal.throwIfAborted();
      vault.write(scope, { secret: JSON.stringify({ endpoint, ...(key ? { key } : {}) }) });
      return { configured: true, endpoint, keySaved: !!key };
    },
    async resolve(scope: ContentServiceScope, epoch?: string): Promise<Uint8Array> {
      const config = epoch ? read(scopeKey(scope.packageId, scope.sourceId, epoch)) : undefined;
      if (!config) throw new Error('source_content_service_required');
      if (pending >= 2) throw new Error('execution_busy');
      const service = createBoundContentService(
        {
          definitions: () => [{ id: 'connection', protocol: 'job-v1', options: { ...config } }],
          bindings: [
            {
              ownerId: 'local',
              packageId: scope.packageId,
              sourceId: scope.sourceId,
              digest: scope.digest,
              provider: 'connection',
              origins: [new URL(scope.url).origin],
            },
          ],
        },
        'local',
        options,
      );
      pending++;
      try {
        return await service.resolve(scope);
      } finally {
        pending--;
        await service.dispose();
      }
    },
  };
}
