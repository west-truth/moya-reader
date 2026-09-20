import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { defaultSettings } from '../../../../../src/repositories/reader-defaults.js';
import {
  normalizeDiscoveryConfig,
  type DiscoverySettings,
} from '../../../../../src/integration-settings/discovery-settings.js';

export function registerDiscoverySettingsRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig) {
  app.get('/api/discovery-settings', async () => {
    const result = await pool.query(
      "select settings -> '_moyaDiscovery' as discovery_settings from reader_settings where user_id = $1",
      [config.defaultUserId],
    );
    return { settings: result.rows[0]?.discovery_settings ?? undefined };
  });

  app.put<{ Body: { config?: unknown; expectedRevision?: unknown } }>(
    '/api/discovery-settings',
    async (request, reply) => {
      const layout = normalizeDiscoveryConfig(request.body?.config);
      const expectedRevision = request.body?.expectedRevision;
      if (
        !layout ||
        typeof expectedRevision !== 'number' ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        expectedRevision >= Number.MAX_SAFE_INTEGER
      ) {
        return reply.code(400).send({ error: 'discovery settings are invalid' });
      }
      const settings: DiscoverySettings = {
        config: layout,
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
      };
      const result = await pool.query(
        `with updated as (
         update reader_settings
            set settings = jsonb_set(reader_settings.settings, '{_moyaDiscovery}', $3::jsonb, true), updated_at = now()
          where user_id = $1
            and coalesce(reader_settings.settings -> '_moyaDiscovery' ->> 'revision', '0') = $4::text
        returning settings -> '_moyaDiscovery' as discovery_settings
       ), inserted as (
         insert into reader_settings (user_id, settings, updated_at)
         select $1, jsonb_set($2::jsonb, '{_moyaDiscovery}', $3::jsonb, true), now()
          where $4::bigint = 0 and not exists (select 1 from reader_settings where user_id = $1)
         on conflict (user_id) do nothing
         returning settings -> '_moyaDiscovery' as discovery_settings
       )
       select discovery_settings from updated union all select discovery_settings from inserted`,
        [config.defaultUserId, JSON.stringify(defaultSettings), JSON.stringify(settings), expectedRevision],
      );
      if (!result.rows.length) return reply.code(409).send({ error: 'discovery settings changed' });
      return { settings };
    },
  );
}
