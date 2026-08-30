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
import { canonicalizeIncomingSyncEvent, SyncIdentityTranslationError } from './sync-contract-translation.js';

type SourceEvent = SyncEvent;

interface SourceEventResult {
  readonly sourceEventId: string;
  readonly inserted: boolean;
  readonly rejection?: RejectedSyncEvent;
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

async function processSourceEvent(
  client: pg.PoolClient,
  config: ServerConfig,
  envelopeContract: ResolvedSyncContract,
  sourceEvent: SourceEvent,
): Promise<SourceEventResult> {
  const sourceEventId = typeof sourceEvent?.id === 'string' ? sourceEvent.id : '';
  let translated;
  try {
    const eventContract = resolveSyncContract(sourceEvent);
    if (eventContract.contractVersion > envelopeContract.contractVersion) {
      throw new SyncIdentityTranslationError(
        'event_contract_exceeds_envelope',
        'An event contract cannot exceed the push envelope contract.',
      );
    }
    translated = await canonicalizeIncomingSyncEvent(client, config.defaultUserId, sourceEvent);
  } catch (error) {
    return {
      sourceEventId,
      inserted: false,
      rejection: {
        id: sourceEventId,
        reason: 'invalid',
        message: error instanceof Error ? error.message : 'sync identity translation failed',
      },
    };
  }
  const event = translated.event;
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
      for (const group of eventGroups(events)) {
        const operationId = compoundOperationId(group[0]);
        if (operationId) await client.query('savepoint sync_compound_operation');
        const groupResults: SourceEventResult[] = [];
        try {
          for (const sourceEvent of group) {
            const result = await processSourceEvent(client, config, envelopeContract, sourceEvent);
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
