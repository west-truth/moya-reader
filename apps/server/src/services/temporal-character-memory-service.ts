import type pg from 'pg';
import type { AddressUseEventV1 } from '../../../../src/providers/speaker-attribution/address-event';
import type { CharacterTemporalSnapshotV1 } from '../../../../src/providers/speaker-attribution/reader-state-snapshot';
import {
  activeAddressUseEvents,
  activeTemporalRelationEdges,
} from '../../../../src/providers/speaker-attribution/temporal-relation-state';
import type { TemporalRelationEdgeV1 } from '../../../../src/providers/speaker-attribution/temporal-relation';
import { withBookAITransaction } from './book-ai-workflow/transaction.js';

export interface TemporalCharacterMemoryQueryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

interface PayloadRow extends pg.QueryResultRow {
  payload: unknown;
}

function payloadObject<T>(value: unknown): T {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Persisted temporal character memory payload is invalid');
  }
  return parsed as T;
}

async function assertRevisionOwnership(
  db: TemporalCharacterMemoryQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly chapterId?: string;
  },
): Promise<void> {
  const result = await db.query<{ allowed: boolean }>(
    `
      /* temporal-character-memory:ownership */
      select true as allowed
      from library_books book
      join book_content_revisions revision on revision.id = $3 and revision.book_id = book.id
      where book.user_id = $1 and book.id = $2
        and ($4::text is null or exists (
          select 1 from chapters chapter where chapter.id = $4 and chapter.book_id = book.id
        ))
      limit 1
    `,
    [input.userId, input.bookId, input.contentRevisionId, input.chapterId ?? null],
  );
  if (!result.rows[0]?.allowed) throw new Error('Temporal character source revision is unavailable');
}

async function assertBatchOwnership(
  db: TemporalCharacterMemoryQueryable,
  userId: string,
  rows: readonly { readonly bookId: string; readonly contentRevisionId: string; readonly chapterId?: string }[],
): Promise<void> {
  const scopes = [
    ...new Map(
      rows.map((row) => [
        `${row.bookId}:${row.contentRevisionId}:${row.chapterId ?? ''}`,
        {
          userId,
          bookId: row.bookId,
          contentRevisionId: row.contentRevisionId,
          chapterId: row.chapterId,
        },
      ]),
    ).values(),
  ];
  for (const scope of scopes) await assertRevisionOwnership(db, scope);
}

export async function appendHostedTemporalAddressUseEvents(
  db: TemporalCharacterMemoryQueryable,
  userId: string,
  events: readonly AddressUseEventV1[],
): Promise<void> {
  if (events.length === 0) return;
  const uniqueEvents = [...new Map(events.map((event) => [event.id, event])).values()];
  await assertBatchOwnership(db, userId, uniqueEvents);
  const result = await db.query<{ id: string }>(
    `
      /* temporal-character-memory:append-address-events */
      insert into temporal_address_events (
        id, user_id, book_id, content_revision_id, chapter_id, scene_id, narrative_order,
        status, supersedes_event_id, fingerprint, payload
      )
      select item->>'id', $1, item->>'bookId', item->>'contentRevisionId', item->>'chapterId',
        item->>'sceneId', (item->>'narrativeOrder')::integer, item->>'status',
        nullif(item->>'supersedesEventId', ''), item->>'fingerprint', item
      from jsonb_array_elements($2::jsonb) item
      on conflict (id) do update set fingerprint = temporal_address_events.fingerprint
        where temporal_address_events.fingerprint = excluded.fingerprint
      returning id
    `,
    [userId, JSON.stringify(uniqueEvents)],
  );
  if (result.rowCount !== uniqueEvents.length) {
    throw new Error('Append-only temporal address event conflicts with persisted content');
  }
}

export async function appendHostedTemporalRelationEdges(
  db: TemporalCharacterMemoryQueryable,
  userId: string,
  edges: readonly TemporalRelationEdgeV1[],
): Promise<void> {
  if (edges.length === 0) return;
  const uniqueEdges = [...new Map(edges.map((edge) => [edge.id, edge])).values()];
  await assertBatchOwnership(db, userId, uniqueEdges);
  const result = await db.query<{ id: string }>(
    `
      /* temporal-character-memory:append-relation-edges */
      insert into temporal_relation_edges (
        id, user_id, book_id, content_revision_id, subject_speaker_entity_id,
        object_speaker_entity_id, relation_type, status, reader_visible_from_order,
        reader_visible_to_order, effective_from_narrative_order, effective_to_narrative_order,
        supersedes_edge_id, fingerprint, payload
      )
      select item->>'id', $1, item->>'bookId', item->>'contentRevisionId',
        item->>'subjectSpeakerEntityId', item->>'objectSpeakerEntityId', item->>'relationType', item->>'status',
        (item->>'readerVisibleFromOrder')::integer, (item->>'readerVisibleToOrder')::integer,
        (item->>'effectiveFromNarrativeOrder')::integer, (item->>'effectiveToNarrativeOrder')::integer,
        nullif(item->>'supersedesEdgeId', ''), item->>'fingerprint', item
      from jsonb_array_elements($2::jsonb) item
      on conflict (id) do update set fingerprint = temporal_relation_edges.fingerprint
        where temporal_relation_edges.fingerprint = excluded.fingerprint
      returning id
    `,
    [userId, JSON.stringify(uniqueEdges)],
  );
  if (result.rowCount !== uniqueEdges.length) {
    throw new Error('Append-only temporal relation edge conflicts with persisted content');
  }
}

export async function listHostedTemporalAddressUseEvents(
  db: TemporalCharacterMemoryQueryable,
  userId: string,
  contentRevisionId: string,
  options?: { readonly activeOnly?: boolean },
): Promise<AddressUseEventV1[]> {
  const result = await db.query<PayloadRow>(
    `select payload from temporal_address_events where user_id = $1 and content_revision_id = $2 order by narrative_order, id`,
    [userId, contentRevisionId],
  );
  const events = result.rows.map((row) => payloadObject<AddressUseEventV1>(row.payload));
  return options?.activeOnly === false ? events : [...activeAddressUseEvents(events)];
}

export async function listHostedTemporalRelationEdges(
  db: TemporalCharacterMemoryQueryable,
  userId: string,
  contentRevisionId: string,
  options?: { readonly activeOnly?: boolean },
): Promise<TemporalRelationEdgeV1[]> {
  const result = await db.query<PayloadRow>(
    `select payload from temporal_relation_edges where user_id = $1 and content_revision_id = $2 order by id`,
    [userId, contentRevisionId],
  );
  const edges = result.rows.map((row) => payloadObject<TemporalRelationEdgeV1>(row.payload));
  return options?.activeOnly === false ? edges : [...activeTemporalRelationEdges(edges)];
}

export async function replaceHostedCharacterTemporalSnapshotsInTransaction(
  db: TemporalCharacterMemoryQueryable,
  userId: string,
  input: {
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly chapterId: string;
    readonly snapshots: readonly CharacterTemporalSnapshotV1[];
  },
): Promise<void> {
  await assertRevisionOwnership(db, { userId, ...input });
  if (
    input.snapshots.some(
      (snapshot) =>
        snapshot.bookId !== input.bookId ||
        snapshot.contentRevisionId !== input.contentRevisionId ||
        snapshot.chapterId !== input.chapterId,
    )
  ) {
    throw new Error('Temporal snapshot replacement contains a different source revision or chapter');
  }
  await db.query(
    `delete from character_temporal_snapshots where user_id = $1 and content_revision_id = $2 and chapter_id = $3`,
    [userId, input.contentRevisionId, input.chapterId],
  );
  if (input.snapshots.length === 0) return;
  await db.query(
    `
      /* temporal-character-memory:replace-snapshots */
      insert into character_temporal_snapshots (
        id, user_id, book_id, content_revision_id, chapter_id, scene_id, narrative_order,
        reader_mode, fingerprint, payload, created_at, updated_at
      )
      select item->>'id', $1, item->>'bookId', item->>'contentRevisionId', item->>'chapterId',
        item->>'sceneId', (item->>'narrativeOrder')::integer, item->>'readerMode',
        item->>'fingerprint', item, now(), now()
      from jsonb_array_elements($2::jsonb) item
    `,
    [userId, JSON.stringify(input.snapshots)],
  );
}

export async function replaceHostedCharacterTemporalSnapshots(
  pool: pg.Pool,
  userId: string,
  input: Parameters<typeof replaceHostedCharacterTemporalSnapshotsInTransaction>[2],
): Promise<void> {
  await withBookAITransaction(pool, (client) =>
    replaceHostedCharacterTemporalSnapshotsInTransaction(client, userId, input),
  );
}

export async function getHostedCharacterTemporalSnapshot(
  db: TemporalCharacterMemoryQueryable,
  userId: string,
  contentRevisionId: string,
  sceneId: string,
  readerMode: CharacterTemporalSnapshotV1['readerMode'],
): Promise<CharacterTemporalSnapshotV1 | undefined> {
  const result = await db.query<PayloadRow>(
    `
      select payload from character_temporal_snapshots
      where user_id = $1 and content_revision_id = $2 and scene_id = $3 and reader_mode = $4
    `,
    [userId, contentRevisionId, sceneId, readerMode],
  );
  return result.rows[0] ? payloadObject<CharacterTemporalSnapshotV1>(result.rows[0].payload) : undefined;
}
