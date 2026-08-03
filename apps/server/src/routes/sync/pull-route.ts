import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { validateV2SyncEvent } from '../../../../../src/sync/event-contract-validation.js';
import { querySyncEventsAfter } from './pull-query.js';
import { parseSyncCursor, pullSyncContract, type PullSyncQuery } from './request-contracts.js';
import { mapPullSyncResponse } from './response-mappers.js';
import { mapSyncEventRow } from './row-mappers.js';
import {
  canonicalizeIncomingSyncEvent,
  SyncIdentityTranslationError,
  translateCanonicalSyncEventToV1,
} from './sync-contract-translation.js';

export function registerSyncPullRoute(app: FastifyInstance, pool: pg.Pool, config: ServerConfig): void {
  app.get<{ Querystring: PullSyncQuery }>('/api/sync', async (request, reply) => {
    const since = parseSyncCursor(request.query.since);
    let requestedContract;
    try {
      requestedContract = pullSyncContract(request.query);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid sync contract.' });
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      const rows = await querySyncEventsAfter(client, config.defaultUserId, since);
      const events = [];
      for (const row of rows) {
        const stored = mapSyncEventRow(row);
        const canonical =
          stored.contractVersion === 2
            ? stored
            : (await canonicalizeIncomingSyncEvent(client, config.defaultUserId, stored)).event;
        validateV2SyncEvent(canonical);
        if (requestedContract.contractVersion === 2) {
          events.push(canonical);
          continue;
        }
        const sourceEventId =
          Number(row.source_contract_version) === 1
            ? (row.source_event_id ?? (stored.contractVersion === 1 ? row.id : undefined))
            : stored.contractVersion === 1
              ? row.id
              : undefined;
        events.push(await translateCanonicalSyncEventToV1(client, config.defaultUserId, canonical, sourceEventId));
      }
      const cursor = rows.reduce((value, row) => Math.max(value, Number(row.sequence)), since);
      await client.query('commit');
      return mapPullSyncResponse(events, cursor, requestedContract);
    } catch (error) {
      await client.query('rollback');
      if (error instanceof SyncIdentityTranslationError) {
        return reply.code(409).send({
          error: 'sync_v1_translation_incomplete',
          message: error.message,
          cursor: since,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  });
}
