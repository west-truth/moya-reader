import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { integrityHash } from '@noveldesk/text-core/hash';
import { SYNC_CONTRACT_V1, SYNC_CONTRACT_V2 } from '../../../../../src/sync/contract.js';
import type { JsonValue, SyncEvent } from '@noveldesk/contracts/sync';
import {
  appWithSync,
  bookmarkCreatedEvent,
  canonicalV2Event,
  chapterSegmentsUpdatedEvent,
  characterGraphUpdatedEvent,
  deletedEvent,
  highlightCreatedEvent,
  noteUpdatedEvent,
  readingPositionEvent,
  userCorrectionCreatedEvent,
  userCorrectionDeletedEvent,
  v2PullUrl,
  v2PushEnvelope,
  voiceProfilesUpdatedEvent,
  voiceCastingUpdatedEvent,
} from './sync-route-test-harness.js';
import { translateCanonicalSyncEventToV1 } from './sync-contract-translation.js';

interface AliasPair {
  source: string;
  canonical: string;
}

const fixedAliases: Readonly<Record<string, AliasPair[]>> = {
  book: [{ source: 'book_old', canonical: 'book_1' }],
  chapter: [{ source: 'chapter_old', canonical: 'chapter_1' }],
  content_revision: [{ source: 'content_revision_old', canonical: 'content_revision_1' }],
  paragraph: [{ source: 'paragraph_old', canonical: 'paragraph_1' }],
  reading_position: [{ source: 'position_old', canonical: 'reading_position_book_1' }],
  bookmark: [{ source: 'bookmark_old', canonical: 'bookmark_1' }],
  highlight: [{ source: 'highlight_old', canonical: 'highlight_1' }],
  note: [{ source: 'note_old', canonical: 'note_1' }],
  character: [
    { source: 'character_old_1', canonical: 'char_1' },
    { source: 'character_old_2', canonical: 'char_2' },
  ],
  character_relation: [{ source: 'relation_old', canonical: 'relation_1' }],
  voice_profile: [{ source: 'voice_old', canonical: 'voice_narrator' }],
  labeled_segment: [{ source: 'segment_old', canonical: 'segment_1' }],
  user_correction: [{ source: 'correction_old', canonical: 'correction_1' }],
};

function requireJsonArray(value: JsonValue, property: string): JsonValue[] {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError(`Expected an object payload containing ${property}.`);
  }
  const result = value[property];
  if (!Array.isArray(result)) {
    throw new TypeError(`Expected payload.${property} to be an array.`);
  }
  return result;
}

function allCanonicalEvents(): SyncEvent[] {
  const updatedAt = '2026-07-05T02:00:00.000Z';
  const noteCreated = canonicalV2Event({
    ...noteUpdatedEvent('note_create_seed', updatedAt),
    id: 'note_created',
    type: 'note_created',
  });
  const graph = characterGraphUpdatedEvent(updatedAt);
  const graphEvent = canonicalV2Event({
    ...graph,
    id: 'graph_with_relation',
    payload: {
      mode: 'replace',
      characters: [
        ...requireJsonArray(graph.payload, 'characters'),
        {
          id: 'char_2',
          novelId: 'book_1',
          canonicalName: 'Blake',
          aliases: [],
          color: '#22c55e',
          confidence: 0.8,
          isUserConfirmed: false,
        },
      ],
      relations: [
        {
          id: 'relation_1',
          novelId: 'book_1',
          sourceCharacterId: 'char_1',
          targetCharacterId: 'char_2',
          relationLabel: 'ally',
          termsUsedBySource: ['friend'],
          termsUsedByTarget: ['friend'],
          confidence: 0.7,
        },
      ],
    },
  });
  return [
    canonicalV2Event({
      id: 'book_imported',
      type: 'book_imported',
      deviceId: 'device_a',
      novelId: 'book_1',
      entityId: 'book_1',
      payload: { bookId: 'book_1' },
      createdAt: updatedAt,
    }),
    canonicalV2Event({
      id: 'book_updated',
      type: 'book_updated',
      deviceId: 'device_a',
      novelId: 'book_1',
      entityId: 'book_1',
      payload: { novel: { id: 'book_1', title: 'Updated', favorite: true } },
      createdAt: updatedAt,
    }),
    canonicalV2Event({
      id: 'book_deleted',
      type: 'book_deleted',
      deviceId: 'device_a',
      novelId: 'book_1',
      entityId: 'book_1',
      payload: { id: 'book_1', deletedAt: updatedAt },
      createdAt: updatedAt,
    }),
    readingPositionEvent('position_updated', updatedAt),
    canonicalV2Event({
      id: 'position_deleted',
      type: 'reading_position_deleted',
      deviceId: 'device_a',
      novelId: 'book_1',
      entityId: 'reading_position_book_1',
      payload: { id: 'reading_position_book_1', deletedAt: updatedAt },
      createdAt: updatedAt,
    }),
    bookmarkCreatedEvent('bookmark_created', updatedAt),
    deletedEvent('bookmark_deleted', 'bookmark_1', updatedAt),
    highlightCreatedEvent('highlight_created', updatedAt),
    deletedEvent('highlight_deleted', 'highlight_1', updatedAt),
    noteCreated,
    noteUpdatedEvent('note_updated', updatedAt),
    deletedEvent('note_deleted', 'note_1', updatedAt),
    canonicalV2Event({
      id: 'settings_updated',
      type: 'settings_updated',
      deviceId: 'device_a',
      entityId: 'reader-settings',
      payload: { settings: { id: 'reader-settings', theme: 'sepia' } },
      createdAt: updatedAt,
    }),
    voiceProfilesUpdatedEvent(updatedAt),
    voiceCastingUpdatedEvent(updatedAt),
    userCorrectionCreatedEvent(updatedAt),
    userCorrectionDeletedEvent(updatedAt),
    graphEvent,
    chapterSegmentsUpdatedEvent(updatedAt),
  ];
}

function aliasFor(
  aliases: Readonly<Record<string, AliasPair[]>>,
  entityType: string,
  value: string,
): AliasPair | undefined {
  return aliases[entityType]?.find((alias) => alias.source === value || alias.canonical === value);
}

function matrixClient(events: SyncEvent[], omitAlias?: { entityType: string; canonical: string }) {
  const eventAliases = events.map((event, index) => ({ source: `legacy_event_${index + 1}`, canonical: event.id }));
  const aliases = { ...fixedAliases, sync_event: eventAliases };
  const insertedIds: string[] = [];
  const rows = events.map((event, index) => ({
    sequence: index + 1,
    id: event.id,
    device_id: event.deviceId,
    type: event.type,
    book_id: event.novelId ?? null,
    entity_id: event.entityId ?? null,
    payload: event.payload,
    revision: event.revision ?? null,
    created_at: event.createdAt,
    id_contract: SYNC_CONTRACT_V2.idContract,
    hash_contract: SYNC_CONTRACT_V2.hashContract,
    source_contract_version: 1,
    source_event_id: eventAliases[index].source,
  }));
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rowCount: 0, rows: [] };
      if (sql.includes('where user_id = $1 and sequence > $2')) {
        const since = Number(params?.[1] ?? 0);
        return { rowCount: rows.length, rows: rows.filter((row) => row.sequence > since) };
      }
      if (sql.includes('from id_v2_book_aliases')) {
        const value = String(params?.[1] ?? '');
        const alias = aliasFor(aliases, 'book', value);
        return {
          rowCount: alias ? 1 : 0,
          rows: alias ? [{ source_book_id: alias.source, canonical_book_id: alias.canonical }] : [],
        };
      }
      if (sql.includes('from id_v2_entity_aliases')) {
        const scoped = params?.length === 4;
        const entityType = scoped ? String(params?.[2]) : 'sync_event';
        const value = String(params?.[scoped ? 3 : 1] ?? '');
        const alias = aliasFor(aliases, entityType, value);
        const omitted = alias && omitAlias?.entityType === entityType && omitAlias.canonical === alias.canonical;
        return {
          rowCount: alias && !omitted ? 1 : 0,
          rows: alias && !omitted ? [{ source_id: alias.source, canonical_id: alias.canonical }] : [],
        };
      }
      if (sql.includes('select text') && sql.includes('from paragraph_search')) {
        return { rowCount: 1, rows: [{ text: 'Hello' }] };
      }
      if (sql.includes('from paragraph_search') && sql.includes('paragraph_id = any')) {
        return { rowCount: 1, rows: [{ paragraph_id: 'paragraph_1', text: 'Hello' }] };
      }
      if (sql.includes('select object_id, metadata_revision, active_content_revision_id, deleted_at')) {
        return {
          rowCount: 1,
          rows: [
            {
              object_id: null,
              metadata_revision: 0,
              active_content_revision_id: 'content_revision_1',
              deleted_at: null,
            },
          ],
        };
      }
      if (sql.includes('delete from library_books') && sql.includes('returning object_id')) {
        return {
          rowCount: 1,
          rows: [{ object_id: null, metadata_revision: 0, active_content_revision_id: 'content_revision_1' }],
        };
      }
      if (sql.includes('should_accept')) return { rowCount: 1, rows: [{ should_accept: true }] };
      if (sql.includes('from library_books') && sql.includes('for share')) {
        return { rowCount: 1, rows: [{ exists: true }] };
      }
      if (sql.includes('select exists(select 1 from chapters')) return { rowCount: 1, rows: [{ exists: true }] };
      if (sql.includes('select exists(select 1 from paragraph_search')) {
        return { rowCount: 1, rows: [{ exists: true }] };
      }
      if (sql.includes('insert into sync_events')) {
        insertedIds.push(String(params?.[0]));
        return { rowCount: 1, rows: [{ id: params?.[0] }] };
      }
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
  return { client, aliases, eventAliases, insertedIds, rows };
}

function stripContract(event: SyncEvent): SyncEvent {
  const { contractVersion: _version, idContract: _id, hashContract: _hash, ...legacy } = event;
  return legacy;
}

describe('versioned sync event matrix', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['v1', 'v2'] as const)('pushes every event type through the %s contract', async (version) => {
    const canonicalEvents = allCanonicalEvents();
    const harness = matrixClient(canonicalEvents);
    const sourceEvents =
      version === 'v2'
        ? canonicalEvents
        : await Promise.all(
            canonicalEvents.map(async (event, index) =>
              stripContract(
                await translateCanonicalSyncEventToV1(
                  harness.client as unknown as pg.PoolClient,
                  'user_test',
                  event,
                  harness.eventAliases[index].source,
                ),
              ),
            ),
          );
    const pool = { connect: vi.fn(async () => harness.client) } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: version === 'v2' ? v2PushEnvelope(sourceEvents) : { events: sourceEvents },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      ...SYNC_CONTRACT_V2,
      accepted: canonicalEvents.length,
      acceptedIds: sourceEvents.map((event) => event.id),
    });
    expect(harness.insertedIds).toEqual(canonicalEvents.map((event) => event.id));
    await app.close();
  });

  it.each(['v1', 'v2'] as const)(
    'pulls every event type through the %s contract after translation commits',
    async (version) => {
      const canonicalEvents = allCanonicalEvents();
      const harness = matrixClient(canonicalEvents);
      const pool = { connect: vi.fn(async () => harness.client) } as unknown as pg.Pool;
      const app = await appWithSync(pool);
      const url =
        version === 'v2'
          ? v2PullUrl(0)
          : '/api/sync?since=0&contractVersion=1&idContract=v1-legacy&hashContract=v1-legacy';
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ...(version === 'v2' ? SYNC_CONTRACT_V2 : SYNC_CONTRACT_V1),
        cursor: canonicalEvents.length,
      });
      const body = response.json() as { events: Array<Record<string, unknown>> };
      expect(body.events).toHaveLength(canonicalEvents.length);
      expect(body.events.map((event) => event.contractVersion)).toEqual(
        Array(canonicalEvents.length).fill(version === 'v2' ? 2 : 1),
      );
      expect(harness.client.query).toHaveBeenCalledWith('commit');
      await app.close();
    },
  );

  it('rejects a v1 child and leaves the cursor unchanged when one complete alias is missing', async () => {
    const canonicalEvents = [bookmarkCreatedEvent('bookmark_missing_alias', '2026-07-05T02:00:00.000Z')];
    const harness = matrixClient(canonicalEvents, { entityType: 'paragraph', canonical: 'paragraph_1' });
    const pool = { connect: vi.fn(async () => harness.client) } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const response = await app.inject({
      method: 'GET',
      url: '/api/sync?since=0&contractVersion=1&idContract=v1-legacy&hashContract=v1-legacy',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'sync_v1_translation_incomplete', cursor: 0 });
    expect(harness.client.query).toHaveBeenCalledWith('rollback');
    expect(harness.client.query).not.toHaveBeenCalledWith('commit');
    await app.close();
  });

  it('rejects bogus v2 IDs and payload hashes before event-log insertion', async () => {
    const event = readingPositionEvent('bogus_v2', '2026-07-05T02:00:00.000Z');
    const badId = { ...event, id: 'event_not_128_bit' };
    const badHash = {
      ...event,
      id: canonicalV2Event({ ...event, id: 'bad_hash' }).id,
      revision: event.revision ? { ...event.revision, payloadHash: integrityHash('wrong') } : undefined,
    };
    const harness = matrixClient([event]);
    const pool = { connect: vi.fn(async () => harness.client) } as unknown as pg.Pool;
    const app = await appWithSync(pool);
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/events',
      payload: v2PushEnvelope([badId, badHash]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: 0, acceptedIds: [] });
    expect((response.json() as { rejected: unknown[] }).rejected).toHaveLength(2);
    expect(harness.insertedIds).toEqual([]);
    await app.close();
  });
});
