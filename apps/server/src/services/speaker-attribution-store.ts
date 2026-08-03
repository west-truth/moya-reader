import type {
  DialogueBurstV1,
  SpeakerSceneV1,
  SpeakerSourceManifestV1,
  SpeakerSpanV1,
} from '@noveldesk/text-core/speaker-attribution';
import type pg from 'pg';
import type { AddressUseEventV1 } from '../../../../src/providers/speaker-attribution/address-event';
import {
  reassembleSpeakerAttributionChapterInventory,
  speakerAttributionChapterInventoryMeta,
  type SpeakerAttributionChapterInventoryMetaV1,
  type SpeakerAttributionChapterInventoryV1,
} from '../../../../src/providers/speaker-attribution/chapter-inventory';
import type { SpeakerEntityV1 } from '../../../../src/providers/speaker-attribution/identity-policy';
import type { SourceMentionV1 } from '../../../../src/providers/speaker-attribution/mention-inventory';
import { withBookAITransaction } from './book-ai-workflow/transaction.js';

export interface SpeakerAttributionQueryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

interface PayloadRow extends pg.QueryResultRow {
  payload: unknown;
}

function payloadObject<T>(value: unknown): T {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Persisted speaker attribution payload is invalid');
  }
  return parsed as T;
}

async function assertOwnership(
  db: SpeakerAttributionQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly chapterId?: string;
  },
): Promise<void> {
  const result = await db.query<{ allowed: boolean }>(
    `
      /* speaker-attribution:ownership */
      select true as allowed
      from library_books book
      join book_content_revisions revision on revision.id = $3 and revision.book_id = book.id
      where book.id = $2 and book.user_id = $1
        and ($4::text is null or exists (
          select 1 from chapters chapter where chapter.id = $4 and chapter.book_id = book.id
        ))
      limit 1
    `,
    [input.userId, input.bookId, input.contentRevisionId, input.chapterId ?? null],
  );
  if (!result.rows[0]?.allowed) throw new Error('Speaker attribution source revision is unavailable');
}

export async function putHostedSpeakerSourceManifestInTransaction(
  db: SpeakerAttributionQueryable,
  userId: string,
  manifest: SpeakerSourceManifestV1,
): Promise<void> {
  await assertOwnership(db, { userId, ...manifest });
  await db.query(
    `
      /* speaker-attribution:upsert-manifest */
      insert into speaker_source_manifests (
        id, user_id, book_id, content_revision_id, status, fingerprint, payload, created_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, now(), now())
      on conflict (user_id, content_revision_id) do update set
        id = excluded.id,
        status = excluded.status,
        fingerprint = excluded.fingerprint,
        payload = excluded.payload,
        updated_at = now()
    `,
    [
      manifest.id,
      userId,
      manifest.bookId,
      manifest.contentRevisionId,
      manifest.status,
      manifest.fingerprint,
      JSON.stringify(manifest),
    ],
  );
}

export async function getHostedSpeakerSourceManifest(
  db: SpeakerAttributionQueryable,
  userId: string,
  contentRevisionId: string,
): Promise<SpeakerSourceManifestV1 | undefined> {
  const result = await db.query<PayloadRow>(
    `
      /* speaker-attribution:load-manifest */
      select payload
      from speaker_source_manifests
      where user_id = $1 and content_revision_id = $2
    `,
    [userId, contentRevisionId],
  );
  return result.rows[0] ? payloadObject<SpeakerSourceManifestV1>(result.rows[0].payload) : undefined;
}

async function insertChapterRows(
  db: SpeakerAttributionQueryable,
  inventory: SpeakerAttributionChapterInventoryV1,
): Promise<void> {
  const common = [inventory.id, inventory.bookId, inventory.contentRevisionId, inventory.chapterId];
  await db.query(
    `
      /* speaker-attribution:insert-scenes */
      insert into speaker_scenes (
        id, inventory_id, book_id, content_revision_id, chapter_id, scene_index, payload
      )
      select item->>'id', $1, $2, $3, $4, (item->>'sceneIndex')::integer, item
      from jsonb_array_elements($5::jsonb) item
    `,
    [...common, JSON.stringify(inventory.sceneInventory.scenes)],
  );
  await db.query(
    `
      /* speaker-attribution:insert-spans */
      insert into speaker_spans (
        id, inventory_id, book_id, content_revision_id, chapter_id, scene_id, paragraph_id,
        span_index, start_offset, end_offset, payload
      )
      select item->>'id', $1, $2, $3, $4, item->>'sceneId', item->>'paragraphId',
        (item->>'spanIndex')::integer, (item->>'startOffset')::integer, (item->>'endOffset')::integer, item
      from jsonb_array_elements($5::jsonb) item
    `,
    [...common, JSON.stringify(inventory.spanInventory.spans)],
  );
  await db.query(
    `
      /* speaker-attribution:insert-bursts */
      insert into speaker_dialogue_bursts (
        id, inventory_id, book_id, content_revision_id, chapter_id, scene_id, burst_index, payload
      )
      select item->>'id', $1, $2, $3, $4, item->>'sceneId', (item->>'burstIndex')::integer, item
      from jsonb_array_elements($5::jsonb) item
    `,
    [...common, JSON.stringify(inventory.dialogueBurstInventory.bursts)],
  );
  await db.query(
    `
      /* speaker-attribution:insert-mentions */
      insert into speaker_mentions (
        id, inventory_id, book_id, content_revision_id, chapter_id, scene_id, span_id, paragraph_id,
        ordinal, start_offset, end_offset, normalized_surface, mention_type, payload
      )
      select item->>'id', $1, $2, $3, $4, item->>'sceneId', item->>'spanId', item->>'paragraphId',
        (item->>'ordinal')::integer, (item->>'startOffset')::integer, (item->>'endOffset')::integer,
        item->>'normalizedSurface', item->>'type', item
      from jsonb_array_elements($5::jsonb) item
    `,
    [...common, JSON.stringify(inventory.mentionInventory.mentions)],
  );
  await db.query(
    `
      /* speaker-attribution:insert-entities */
      insert into speaker_entities (
        id, inventory_id, book_id, content_revision_id, chapter_id, scene_id, character_id,
        entity_kind, status, payload
      )
      select item->>'id', $1, $2, $3, $4, nullif(item->>'sceneId', ''), nullif(item->>'characterId', ''),
        item->>'entityKind', item->>'status', item
      from jsonb_array_elements($5::jsonb) item
    `,
    [...common, JSON.stringify(inventory.entities)],
  );
  await db.query(
    `
      /* speaker-attribution:insert-address-events */
      insert into speaker_address_events (
        id, inventory_id, book_id, content_revision_id, chapter_id, scene_id, span_id, mention_id,
        status, relation_status, payload
      )
      select item->>'id', $1, $2, $3, $4, item->>'sceneId', item->>'spanId', item->>'mentionId',
        item->>'status', item->>'relationStatus', item
      from jsonb_array_elements($5::jsonb) item
    `,
    [...common, JSON.stringify(inventory.addressEvents)],
  );
}

export async function replaceHostedSpeakerAttributionChapterInventoryInTransaction(
  db: SpeakerAttributionQueryable,
  userId: string,
  inventory: SpeakerAttributionChapterInventoryV1,
): Promise<void> {
  await assertOwnership(db, { userId, ...inventory });
  await db.query(
    `
      /* speaker-attribution:delete-chapter */
      delete from speaker_chapter_inventories
      where user_id = $1 and content_revision_id = $2 and chapter_id = $3
    `,
    [userId, inventory.contentRevisionId, inventory.chapterId],
  );
  await db.query(
    `
      /* speaker-attribution:insert-chapter */
      insert into speaker_chapter_inventories (
        id, user_id, book_id, content_revision_id, chapter_id, chapter_index, fingerprint, payload,
        created_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
    `,
    [
      inventory.id,
      userId,
      inventory.bookId,
      inventory.contentRevisionId,
      inventory.chapterId,
      inventory.chapterIndex,
      inventory.fingerprint,
      JSON.stringify(speakerAttributionChapterInventoryMeta(inventory)),
    ],
  );
  await insertChapterRows(db, inventory);
}

export async function replaceHostedSpeakerAttributionChapterInventory(
  pool: pg.Pool,
  userId: string,
  inventory: SpeakerAttributionChapterInventoryV1,
): Promise<void> {
  await withBookAITransaction(pool, (client) =>
    replaceHostedSpeakerAttributionChapterInventoryInTransaction(client, userId, inventory),
  );
}

export async function getHostedSpeakerAttributionChapterInventory(
  db: SpeakerAttributionQueryable,
  userId: string,
  contentRevisionId: string,
  chapterId: string,
): Promise<SpeakerAttributionChapterInventoryV1 | undefined> {
  const metaResult = await db.query<PayloadRow>(
    `
      /* speaker-attribution:load-chapter */
      select payload
      from speaker_chapter_inventories
      where user_id = $1 and content_revision_id = $2 and chapter_id = $3
    `,
    [userId, contentRevisionId, chapterId],
  );
  if (!metaResult.rows[0]) return undefined;
  const meta = payloadObject<SpeakerAttributionChapterInventoryMetaV1>(metaResult.rows[0].payload);
  const load = async <T>(table: string, orderBy: string): Promise<T[]> => {
    const result = await db.query<PayloadRow>(
      `select payload from ${table} where inventory_id = $1 order by ${orderBy}`,
      [meta.id],
    );
    return result.rows.map((row) => payloadObject<T>(row.payload));
  };
  const [scenes, spans, dialogueBursts, mentions, entities, addressEvents] = await Promise.all([
    load<SpeakerSceneV1>('speaker_scenes', 'scene_index'),
    load<SpeakerSpanV1>('speaker_spans', 'span_index'),
    load<DialogueBurstV1>('speaker_dialogue_bursts', 'burst_index'),
    load<SourceMentionV1>('speaker_mentions', 'ordinal'),
    load<SpeakerEntityV1>('speaker_entities', 'id'),
    load<AddressUseEventV1>('speaker_address_events', 'id'),
  ]);
  return reassembleSpeakerAttributionChapterInventory({
    meta,
    scenes,
    spans,
    dialogueBursts,
    mentions,
    entities,
    addressEvents,
  });
}

export async function listHostedSpeakerEntitiesForRevision(
  db: SpeakerAttributionQueryable,
  userId: string,
  contentRevisionId: string,
): Promise<SpeakerEntityV1[]> {
  const result = await db.query<PayloadRow>(
    `
      select entity.payload
      from speaker_entities entity
      join speaker_chapter_inventories inventory on inventory.id = entity.inventory_id
      where inventory.user_id = $1 and inventory.content_revision_id = $2
      order by entity.id
    `,
    [userId, contentRevisionId],
  );
  return result.rows.map((row) => payloadObject<SpeakerEntityV1>(row.payload));
}
