import type { FastifyInstance } from 'fastify';
import { CURRENT_SYNC_CAPABILITIES } from '../../../../../src/sync/contract.js';

export function registerSyncCapabilitiesRoute(app: FastifyInstance): void {
  app.get('/api/sync/capabilities', async () => CURRENT_SYNC_CAPABILITIES);
}
