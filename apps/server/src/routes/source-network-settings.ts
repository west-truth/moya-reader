import type { FastifyInstance } from 'fastify';
import type { SourceNetworkSettingsRequest } from '../../../../packages/extension-contracts/source-network-settings.js';
import type { createSourceNetworkSettings } from '../extensions/source-network-settings.js';

export async function registerSourceNetworkSettingsRoutes(
  app: FastifyInstance,
  settings: ReturnType<typeof createSourceNetworkSettings>,
) {
  app.get('/api/source-network-settings', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return settings.read();
  });
  app.put<{ Body: SourceNetworkSettingsRequest }>(
    '/api/source-network-settings',
    { bodyLimit: 4096 },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        return settings.save(request.body);
      } catch (error) {
        if (error instanceof Error && error.message === 'source_network_conflict')
          return reply.code(409).send({ error: 'source_network_conflict' });
        if (error instanceof Error && error.message === 'compatibility_preferences_invalid')
          return reply.code(400).send({ error: 'compatibility_preferences_invalid' });
        throw error;
      }
    },
  );
}
