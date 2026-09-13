import { compatibilityFile } from '../extensions/compatibility-file.js';
import type { FastifyInstance } from 'fastify';
import type { CompatibilityHost } from '../extensions/apk-command.js';

export async function registerApkExtensionRoutes(
  app: FastifyInstance,
  host?: CompatibilityHost,
  prefix = '/api/apk-extensions',
) {
  app.get(prefix, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return host?.snapshot() ?? { available: false, revision: 0, packages: [], repositories: [] };
  });
  if (!host) return;
  app.addHook('onClose', () => host.close());
  app.post(prefix + '/inspect-file', { bodyLimit: 45 * 1024 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const controller = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    request.raw.once('aborted', cancel);
    reply.raw.once('close', cancel);
    try {
      if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body))
        throw new Error('compatibility_file_invalid');
      const file = compatibilityFile(request.body as Record<string, unknown>);
      return await host.inspectFile(file.bytes, file.name, file.sourceIndex, controller.signal);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const allowed = [
        'compatibility_file_invalid',
        'compatibility_feature_unsupported',
        'apk_publisher_changed',
        'apk_version_not_newer',
        'apk_verification_failed',
        'apk_review_limit',
        'apk_install_conflict',
      ];
      return reply.code(422).send({ error: allowed.includes(code) ? code : 'apk_operation_failed' });
    } finally {
      request.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', cancel);
    }
  });
  app.post<{ Params: { action: string } }>(prefix + '/:action', { bodyLimit: 65536 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return reply.code(400).send({ error: 'apk_input_invalid' });
    const input = body as Record<string, unknown>;
    const controller = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    request.raw.once('aborted', cancel);
    reply.raw.once('close', cancel);
    try {
      switch (request.params.action) {
        case 'discard':
          if (typeof input.id !== 'string' || input.id.length > 128) break;
          host.discard(input.id);
          return { discarded: true };
        case 'preferences':
          if (typeof input.pkg !== 'string' || !('preferences' in host)) break;
          return await host.preferences(input.pkg);
        case 'preferences-save':
          if (typeof input.pkg !== 'string' || !Number.isSafeInteger(input.revision) || !('savePreferences' in host))
            break;
          await host.savePreferences(input.pkg, input.revision as number, input.values, input.privateOrigins);
          return { saved: true };
        case 'repository-refresh':
          if (typeof input.url !== 'string') break;
          await host.refreshRepository(input.url, controller.signal);
          return { updated: true };
        case 'repository-remove':
          if (typeof input.url !== 'string') break;
          await host.removeRepository(input.url);
          return { removed: true };
        case 'inspect':
          if (typeof input.url !== 'string' || typeof input.pkg !== 'string' || !Number.isSafeInteger(input.code))
            break;
          return await host.inspect(input.url, input.pkg, input.code as number, controller.signal);
        case 'install':
          if (typeof input.id !== 'string' || !Number.isSafeInteger(input.revision) || input.trusted !== true) break;
          await host.install(input.id, input.revision as number, controller.signal);
          return { installed: true };
        case 'change':
          if (
            typeof input.pkg !== 'string' ||
            !Number.isSafeInteger(input.revision) ||
            !['enable', 'disable', 'remove'].includes(String(input.action))
          )
            break;
          await host.change(input.pkg, input.revision as number, input.action as 'enable' | 'disable' | 'remove');
          return { changed: true };
      }
      return reply.code(400).send({ error: 'apk_input_invalid' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const safe = [
        'compatibility_repository_mismatch',
        'compatibility_repository_invalid',
        'compatibility_feature_unsupported',
        'compatibility_preferences_invalid',
        'apk_publisher_changed',
        'apk_version_not_newer',
        'apk_repository_conflict',
        'apk_install_conflict',
        'apk_verification_failed',
        'apk_review_expired',
        'apk_review_limit',
        'source_connection_failed',
        'source_request_timeout',
        'apk_repository_invalid',
        'apk_android_feature_unsupported',
        'apk_worker_unavailable',
        'apk_repository_limit',
        'source_url_denied',
        'source_body_limit',
        'cancelled',
      ];
      return reply
        .code(message.includes('conflict') ? 409 : 422)
        .send({ error: safe.includes(message) ? message : 'apk_operation_failed' });
    } finally {
      request.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', cancel);
    }
  });
}
