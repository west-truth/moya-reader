import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { RejectedSyncEvent, ResolvedSyncContract, SyncEvent } from '@noveldesk/contracts/sync';
import { resolveSyncContract } from '../../../../../src/sync/contract.js';
import type { ServerConfig } from '../../config.js';
import { hasExistingBookForEvent, shouldAcceptSyncEvent } from './revision-conflict-policy.js';
import { validateSyncEventPayload } from './event-contracts.js';
import { applySyncEvent } from './event-application.js';
import { pushSyncContract, type PushEventsBody } from './request-contracts.js';
import { mapPushSyncResponse } from './response-mappers.js';
import { insertSyncEvent } from './sync-event-persistence.js';
import {
  canonicalizeIncomingSyncEvent,
  SyncIdentityTranslationError,
  type CanonicalIncomingSyncEvent,
} from './sync-contract-translation.js';
import { isReadingPositionEvent, lockReaderState } from '../../services/reader-state-lock.js';
import { isBookLifecycleEvent, lockImageSeriesBookLifecycle } from '../../services/book-operation-lock.js';

type SourceEvent = SyncEvent;

interface SourceEventResult {
  readonly sourceEventId: string;
  readonly inserted: boolean;
  readonly rejection?: RejectedSyncEvent;
}

interface PreparedSourceEvent {
  readonly sourceEventId: string;
  readonly translated?: CanonicalIncomingSyncEvent;
  readonly rejection?: RejectedSyncEvent;
}

/**
 * Acquire only the cross-route locks needed by this push envelope.
 *
 * Lifecycle locks share the namespace used by append/purge/cover mutations,
 * while reader locks share the namespace used by direct reading-position
 * writes.  Each class is sorted independently and every push acquires the
 * classes in the same lifecycle-then-reader order to avoid lock-order cycles.
 */
export async function lockSyncPushBooks(
  client: pg.PoolClient,
  userId: string,
  events: readonly SyncEvent[],
): Promise<void> {
  const lifecycleBookIds = [
    ...new Set(events.flatMap((event) => (event.novelId && isBookLifecycleEvent(event.type) ? [event.novelId] : []))),
  ].sort();
  const readingBookIds = [
    ...new Set(events.flatMap((event) => (event.novelId && isReadingPositionEvent(event.type) ? [event.novelId] : []))),
  ].sort();

  for (const bookId of lifecycleBookIds) await lockImageSeriesBookLifecycle(client, bookId);
  for (const bookId of readingBookIds) await lockReaderState(client, userId, bookId);
}

function compoundOperationId(event: SourceEvent): string | undefined {
  const payload = event?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>).compoundOperationId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function eventGroups(events: SourceEvent[]): SourceEvent[][] {
  const units: SourceEvent[][] = [];
  const groupByOperation = new Map<string, SourceEvent[]>();
  for (const event of events) {
    const operationId = compoundOperationId(event);
    if (!operationId) {
      units.push([event]);
      continue;
    }
    let group = groupByOperation.get(operationId);
    if (!group) {
      group = [];
      groupByOperation.set(operationId, group);
      units.push(group);
    }
    group.push(event);
  }
  return units;
}

async function prepareSourceEvent(
  client: pg.PoolClient,
  userId: string,
  envelopeContract: ResolvedSyncContract,
  sourceEvent: SourceEvent,
): Promise<PreparedSourceEvent> {
  const sourceEventId = typeof sourceEvent?.id === 'string' ? sourceEvent.id : '';
  try {
    const eventContract = resolveSyncContract(sourceEvent);
    if (eventContract.contractVersion > envelopeContract.contractVersion) {
      throw new SyncIdentityTranslationError(
        'event_contract_exceeds_envelope',
        'An event contract cannot exceed the push envelope contract.',
      );
    }
    return {
      sourceEventId,
      translated: await canonicalizeIncomingSyncEvent(client, userId, sourceEvent),
    };
  } catch (error) {
    return {
      sourceEventId,
      rejection: {
        id: sourceEventId,
        reason: 'invalid',
        message: error instanceof Error ? error.message : 'sync identity translation failed',
      },
    };
  }
}

async function processSourceEvent(
  client: pg.PoolClient,
  config: ServerConfig,
  prepared: PreparedSourceEvent,
): Promise<SourceEventResult> {
  if (!prepared.translated) {
    return {
      sourceEventId: prepared.sourceEventId,
      inserted: false,
      rejection: prepared.rejection,
    };
  }
  const translated = prepared.translated;
  const sourceEventId = prepared.sourceEventId;
  const event = translated.event;
  if (isBookLifecycleEvent(event.type)) {
    const duplicate = await client.query(
      `select 1 from sync_events
        where user_id = $1 and (id = $2 or source_event_id = $3)
        limit 1`,
      [config.defaultUserId, event.id, sourceEventId],
    );
    if (duplicate.rows[0]) return { sourceEventId, inserted: false };
  }
  if (!(await hasExistingBookForEvent(client, config.defaultUserId, event))) {
    return {
      sourceEventId,
      inserted: false,
      rejection: {
        id: sourceEventId,
        reason: 'invalid',
        message: 'server book does not exist yet; upload or attach the book before syncing this event',
      },
    };
  }
  const validation = await validateSyncEventPayload(client, event);
  if (!validation.ok) {
    return {
      sourceEventId,
      inserted: false,
      rejection: { id: sourceEventId, reason: 'invalid', message: validation.message },
    };
  }
  if (!(await shouldAcceptSyncEvent(client, config.defaultUserId, event))) {
    return {
      sourceEventId,
      inserted: false,
      rejection: { id: sourceEventId, reason: 'stale', message: 'server has a newer version of this entity' },
    };
  }
  const inserted = await insertSyncEvent(client, config.defaultUserId, event, {
    eventId: translated.sourceEventId,
    contract: translated.sourceContract,
  });
  if (inserted) await applySyncEvent(client, config.defaultUserId, event);
  return { sourceEventId, inserted };
}

export function registerSyncPushRoute(app: FastifyInstance, pool: pg.Pool, config: ServerConfig): void {
  app.post<{ Body: PushEventsBody }>('/api/sync/events', async (request, reply) => {
    const events = request.body?.events;
    if (!Array.isArray(events)) {
      return reply.code(400).send({ error: 'events array is required' });
    }
    let envelopeContract;
    try {
      envelopeContract = pushSyncContract(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid sync contract.' });
    }

    const client = await pool.connect();
    let accepted = 0;
    const acceptedIds: string[] = [];
    const rejected: RejectedSyncEvent[] = [];
    try {
      await client.query('begin');
      const preparedBySource = new Map<SourceEvent, PreparedSourceEvent>();
      for (const sourceEvent of events) {
        preparedBySource.set(
          sourceEvent,
          await prepareSourceEvent(client, config.defaultUserId, envelopeContract, sourceEvent),
        );
      }
      await lockSyncPushBooks(
        client,
        config.defaultUserId,
        [...preparedBySource.values()].flatMap((prepared) => (prepared.translated ? [prepared.translated.event] : [])),
      );
      for (const group of eventGroups(events)) {
        const operationId = compoundOperationId(group[0]);
        if (operationId) await client.query('savepoint sync_compound_operation');
        const groupResults: SourceEventResult[] = [];
        try {
          for (const sourceEvent of group) {
            const result = await processSourceEvent(client, config, preparedBySource.get(sourceEvent)!);
            groupResults.push(result);
            if (result.rejection) break;
          }
        } catch (error) {
          if (operationId) await client.query('rollback to savepoint sync_compound_operation');
          throw error;
        }
        const failed = groupResults.find((result) => result.rejection)?.rejection;
        if (failed && operationId) {
          await client.query('rollback to savepoint sync_compound_operation');
          await client.query('release savepoint sync_compound_operation');
          rejected.push(
            ...group.map((event) => ({
              id: typeof event?.id === 'string' ? event.id : '',
              reason: 'invalid' as const,
              message: `compound operation ${operationId} was rejected: ${failed.message ?? failed.reason}`,
            })),
          );
          continue;
        }
        if (operationId) await client.query('release savepoint sync_compound_operation');
        for (const result of groupResults) {
          if (result.rejection) rejected.push(result.rejection);
          else {
            if (result.inserted) accepted += 1;
            acceptedIds.push(result.sourceEventId);
          }
        }
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    return mapPushSyncResponse(accepted, acceptedIds, rejected);
  });
}
