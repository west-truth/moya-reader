import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../config.js';
import { registerSyncCapabilitiesRoute } from './sync/capabilities-route.js';
import { registerSyncPullRoute } from './sync/pull-route.js';
import { registerSyncPushRoute } from './sync/push-route.js';
import { registerPeerReadingPositionRoutes } from './sync/peer-reading-position-routes.js';
import { registerPeerBookContentRoutes } from './sync/peer-book-content-routes.js';

export async function registerSyncRoutes(app: FastifyInstance, pool: pg.Pool, config: ServerConfig): Promise<void> {
  registerSyncCapabilitiesRoute(app);
  registerSyncPullRoute(app, pool, config);
  registerSyncPushRoute(app, pool, config);
  registerPeerReadingPositionRoutes(app, pool, config);
  await registerPeerBookContentRoutes(app, pool, config);
}
