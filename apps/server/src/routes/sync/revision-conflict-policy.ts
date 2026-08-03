import pg from 'pg';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import {
  parseChapterSegmentsPayload,
  parseCharacterGraphPayload,
  parseCorrectionDeletedPayload,
  parseCorrectionPayload,
  parseDocumentAnnotationDeletedPayload,
  parseDocumentAnnotationPayload,
  parseDocumentTextOrderOverrideDeletedPayload,
  parseDocumentTextOrderOverridePayload,
  parseVoiceProfilesPayload,
  parseVoiceCastingUpdatedPayload,
  record,
  stringValue,
} from './event-contracts.js';

function readingPositionUpdatedAt(event: SyncEvent): string {
  const payload = record(event.payload);
  if (event.type === 'reading_position_deleted') {
    return String(payload.deletedAt ?? event.createdAt);
  }
  const position = record(payload.position);
  return String(position.updatedAt ?? event.createdAt);
}

function listeningPositionUpdatedAt(event: SyncEvent): string {
  const payload = record(event.payload);
  if (event.type === 'listening_position_deleted') return String(payload.deletedAt ?? event.createdAt);
  const position = record(payload.listeningPosition);
  return String(position.updatedAt ?? event.createdAt);
}

function readerArtifactUpdatedAt(event: SyncEvent): string | undefined {
  return event.type === 'reading_position_updated' ||
    event.type === 'reading_position_deleted' ||
    event.type === 'listening_position_updated' ||
    event.type === 'listening_position_deleted' ||
    event.type === 'bookmark_created' ||
    event.type === 'bookmark_deleted' ||
    event.type === 'highlight_created' ||
    event.type === 'highlight_deleted' ||
    event.type === 'note_created' ||
    event.type === 'note_updated' ||
    event.type === 'note_deleted' ||
    event.type === 'document_annotation_updated' ||
    event.type === 'document_annotation_deleted' ||
    event.type === 'document_text_order_override_updated' ||
    event.type === 'document_text_order_override_deleted'
    ? String(event.revision?.updatedAt ?? event.createdAt)
    : undefined;
}

async function shouldAcceptReaderContentRevision(
  client: pg.PoolClient,
  userId: string,
  event: SyncEvent,
): Promise<boolean> {
  const updatedAt = readerArtifactUpdatedAt(event);
  if (!updatedAt || !event.novelId) return true;
  const result = await client.query<{ should_accept: boolean }>(
    `
      select case
        when book.content_revision_number <= 1 then true
        when revision.activated_at is null then false
        else revision.activated_at < $3::timestamptz
      end as should_accept
      from library_books book
      join book_content_revisions revision on revision.id = book.active_content_revision_id
      where book.id = $1 and book.user_id = $2
    `,
    [event.novelId, userId, updatedAt],
  );
  return result.rows[0]?.should_accept ?? false;
}

async function shouldAcceptReadingPositionEvent(
  client: pg.PoolClient,
  userId: string,
  event: SyncEvent,
): Promise<boolean> {
  if (event.type !== 'reading_position_updated' && event.type !== 'reading_position_deleted') {
    return true;
  }
  if (!event.novelId) return false;

  const result = await client.query<{ should_accept: boolean }>(
    `
      select coalesce(
        (
          select max(entity_updated_at) <= $3::timestamptz
          from (
            select updated_at as entity_updated_at
            from reading_positions
            where book_id = $1 and user_id = $2
            union all
            select created_at as entity_updated_at
            from sync_events
            where user_id = $2
              and book_id = $1
              and type = 'reading_position_deleted'
              and entity_id = $4
          ) versions
        ),
        true
      ) as should_accept
    `,
    [event.novelId, userId, readingPositionUpdatedAt(event), event.entityId ?? `reading_position_${event.novelId}`],
  );
  return result.rows[0]?.should_accept ?? true;
}

async function shouldAcceptListeningPositionEvent(
  client: pg.PoolClient,
  userId: string,
  event: SyncEvent,
): Promise<boolean> {
  if (event.type !== 'listening_position_updated' && event.type !== 'listening_position_deleted') return true;
  if (!event.novelId) return false;
  const result = await client.query<{ should_accept: boolean }>(
    `
      select coalesce(
        (
          select max(entity_updated_at) <= $3::timestamptz
          from (
            select updated_at as entity_updated_at
            from listening_positions
            where book_id = $1 and user_id = $2
            union all
            select created_at as entity_updated_at
            from sync_events
            where user_id = $2
              and book_id = $1
              and type = 'listening_position_deleted'
              and entity_id = $4
          ) versions
        ),
        true
      ) as should_accept
    `,
    [event.novelId, userId, listeningPositionUpdatedAt(event), event.entityId ?? `listening_position_${event.novelId}`],
  );
  return result.rows[0]?.should_accept ?? true;
}

function userEntityUpdatedAt(
  event: SyncEvent,
):
  | {
      table: 'bookmarks' | 'highlights' | 'notes' | 'document_annotations' | 'document_text_order_overrides';
      id: string;
      updatedAt: string;
    }
  | undefined {
  const payload = record(event.payload);
  if (event.type === 'bookmark_created') {
    const bookmark = record(payload.bookmark);
    const id = stringValue(bookmark.id) ?? event.entityId;
    return id
      ? {
          table: 'bookmarks',
          id,
          updatedAt: String(bookmark.createdAt ?? event.createdAt),
        }
      : undefined;
  }
  if (event.type === 'bookmark_deleted') {
    const id = stringValue(payload.id) ?? event.entityId;
    return id
      ? {
          table: 'bookmarks',
          id,
          updatedAt: String(payload.deletedAt ?? event.createdAt),
        }
      : undefined;
  }
  if (event.type === 'highlight_created') {
    const highlight = record(payload.highlight);
    const id = stringValue(highlight.id) ?? event.entityId;
    return id
      ? {
          table: 'highlights',
          id,
          updatedAt: String(highlight.updatedAt ?? event.createdAt),
        }
      : undefined;
  }
  if (event.type === 'highlight_deleted') {
    const id = stringValue(payload.id) ?? event.entityId;
    return id
      ? {
          table: 'highlights',
          id,
          updatedAt: String(payload.deletedAt ?? event.createdAt),
        }
      : undefined;
  }
  if (event.type === 'note_created' || event.type === 'note_updated') {
    const note = record(payload.note);
    const id = stringValue(note.id) ?? event.entityId;
    return id
      ? {
          table: 'notes',
          id,
          updatedAt: String(note.updatedAt ?? event.createdAt),
        }
      : undefined;
  }
  if (event.type === 'note_deleted') {
    const id = stringValue(payload.id) ?? event.entityId;
    return id
      ? {
          table: 'notes',
          id,
          updatedAt: String(payload.deletedAt ?? event.createdAt),
        }
      : undefined;
  }
  if (event.type === 'document_annotation_updated') {
    const parsed = parseDocumentAnnotationPayload(event);
    return parsed.ok
      ? { table: 'document_annotations', id: parsed.id, updatedAt: parsed.updatedAt }
      : undefined;
  }
  if (event.type === 'document_annotation_deleted') {
    const parsed = parseDocumentAnnotationDeletedPayload(event);
    return parsed.ok
      ? { table: 'document_annotations', id: parsed.id, updatedAt: parsed.deletedAt }
      : undefined;
  }
  if (event.type === 'document_text_order_override_updated') {
    const parsed = parseDocumentTextOrderOverridePayload(event);
    return parsed.ok
      ? { table: 'document_text_order_overrides', id: parsed.id, updatedAt: parsed.updatedAt }
      : undefined;
  }
  if (event.type === 'document_text_order_override_deleted') {
    const parsed = parseDocumentTextOrderOverrideDeletedPayload(event);
    return parsed.ok
      ? { table: 'document_text_order_overrides', id: parsed.id, updatedAt: parsed.deletedAt }
      : undefined;
  }
  return undefined;
}

async function shouldAcceptUserEntityEvent(client: pg.PoolClient, userId: string, event: SyncEvent): Promise<boolean> {
  const entity = userEntityUpdatedAt(event);
  if (!entity) return true;
  const result = await client.query<{ should_accept: boolean }>(
    `
      select coalesce(
        (select updated_at <= $3::timestamptz
         from ${entity.table}
         where id = $1 and user_id = $2),
        true
      ) as should_accept
    `,
    [entity.id, userId, entity.updatedAt],
  );
  return result.rows[0]?.should_accept ?? true;
}

async function shouldAcceptVoiceProfilesEvent(
  client: pg.PoolClient,
  userId: string,
  event: SyncEvent,
): Promise<boolean> {
  if (event.type !== 'voice_profiles_updated') return true;
  const parsed = parseVoiceProfilesPayload(event);
  if (!parsed.ok) return false;
  const result = await client.query<{ should_accept: boolean }>(
    `
      select coalesce(
        (
          select max(entity_updated_at) <= $3::timestamptz
          from (
            select updated_at as entity_updated_at
            from voice_profiles
            where book_id = $1
            union all
            select created_at as entity_updated_at
            from sync_events
            where user_id = $2
              and book_id = $1
              and type = 'voice_profiles_updated'
              and entity_id = $4
          ) versions
        ),
        true
      ) as should_accept
    `,
    [parsed.bookId, userId, parsed.updatedAt, event.entityId ?? `voice_profiles_${parsed.bookId}`],
  );
  return result.rows[0]?.should_accept ?? true;
}

async function shouldAcceptVoiceCastingEvent(
  client: pg.PoolClient,
  userId: string,
  event: SyncEvent,
): Promise<boolean> {
  if (event.type !== 'voice_casting_updated') return true;
  const parsed = parseVoiceCastingUpdatedPayload(event);
  if (!parsed.ok) return false;
  const result = await client.query<{ should_accept: boolean }>(
    `
      select coalesce(
        (
          select max(entity_updated_at) <= $3::timestamptz
          from (
            select updated_at as entity_updated_at
            from voice_casting_states
            where user_id = $2 and book_id = $1
            union all
            select created_at as entity_updated_at
            from sync_events
            where user_id = $2
              and book_id = $1
              and type = 'voice_casting_updated'
              and entity_id = $4
          ) versions
        ),
        true
      ) as should_accept
    `,
    [parsed.bookId, userId, parsed.updatedAt, event.entityId],
  );
  return result.rows[0]?.should_accept ?? true;
}

async function shouldAcceptCharacterGraphEvent(
  client: pg.PoolClient,
  userId: string,
  event: SyncEvent,
): Promise<boolean> {
  if (event.type !== 'character_graph_updated') return true;
  const parsed = parseCharacterGraphPayload(event);
  if (!parsed.ok) return false;
  const result = await client.query<{ should_accept: boolean }>(
    `
      select coalesce(
        (
          select max(entity_updated_at) <= $3::timestamptz
          from (
            select updated_at as entity_updated_at
            from characters
            where book_id = $1 and user_id = $2
            union all
            select updated_at as entity_updated_at
            from character_relations
            where book_id = $1
            union all
            select created_at as entity_updated_at
            from sync_events
            where user_id = $2
              and book_id = $1
              and type = 'character_graph_updated'
              and entity_id = $4
          ) versions
        ),
        true
      ) as should_accept
    `,
    [parsed.bookId, userId, parsed.updatedAt, event.entityId ?? `character_graph_${parsed.bookId}`],
  );
  return result.rows[0]?.should_accept ?? true;
}

async function shouldAcceptChapterSegmentsEvent(
  client: pg.PoolClient,
  userId: string,
  event: SyncEvent,
): Promise<boolean> {
  if (event.type !== 'chapter_segments_updated') return true;
  const parsed = parseChapterSegmentsPayload(event);
  if (!parsed.ok) return false;
  const segmentScopeSql =
    parsed.mode === 'patch'
      ? 'from labeled_segments where book_id = $1 and chapter_id = $2 and paragraph_id = any($6::text[])'
      : 'from labeled_segments where book_id = $1 and chapter_id = $2';
  const result = await client.query<{ should_accept: boolean }>(
    `
      select coalesce(
        (
          select max(entity_updated_at) <= $4::timestamptz
          from (
            select updated_at as entity_updated_at
            ${segmentScopeSql}
            union all
            select created_at as entity_updated_at
            from sync_events
            where user_id = $3
              and book_id = $1
              and type = 'chapter_segments_updated'
              and entity_id = $5
          ) versions
        ),
        true
      ) as should_accept
    `,
    [
      parsed.bookId,
      parsed.chapterId,
      userId,
      parsed.updatedAt,
      event.entityId ?? `chapter_segments_${parsed.chapterId}`,
      parsed.paragraphIds,
    ],
  );
  return result.rows[0]?.should_accept ?? true;
}

async function shouldAcceptUserCorrectionEvent(
  client: pg.PoolClient,
  userId: string,
  event: SyncEvent,
): Promise<boolean> {
  if (event.type !== 'user_correction_created' && event.type !== 'user_correction_deleted') {
    return true;
  }
  let bookId: string;
  let id: string;
  let updatedAt: string;
  if (event.type === 'user_correction_created') {
    const parsed = parseCorrectionPayload(event);
    if (!parsed.ok) return false;
    bookId = parsed.bookId;
    id = String(parsed.correction.id);
    updatedAt = String(parsed.correction.createdAt ?? event.createdAt);
  } else {
    const parsed = parseCorrectionDeletedPayload(event);
    if (!parsed.ok) return false;
    bookId = parsed.bookId;
    id = parsed.id;
    updatedAt = parsed.deletedAt;
  }
  const result = await client.query<{ should_accept: boolean }>(
    `
      select coalesce(
        (
          select max(entity_updated_at) <= $4::timestamptz
          from (
            select created_at as entity_updated_at
            from user_corrections
            where id = $1 and book_id = $2
            union all
            select created_at as entity_updated_at
            from sync_events
            where user_id = $3
              and book_id = $2
              and type in ('user_correction_created', 'user_correction_deleted')
              and entity_id = $1
          ) versions
        ),
        true
      ) as should_accept
    `,
    [id, bookId, userId, updatedAt],
  );
  return result.rows[0]?.should_accept ?? true;
}

function requiresExistingBook(event: SyncEvent): boolean {
  return (
    event.type === 'reading_position_updated' ||
    event.type === 'reading_position_deleted' ||
    event.type === 'listening_position_updated' ||
    event.type === 'listening_position_deleted' ||
    event.type === 'book_updated' ||
    event.type === 'book_trashed' ||
    event.type === 'book_restored' ||
    event.type === 'book_purged' ||
    event.type === 'bookmark_created' ||
    event.type === 'bookmark_deleted' ||
    event.type === 'highlight_created' ||
    event.type === 'highlight_deleted' ||
    event.type === 'note_created' ||
    event.type === 'note_updated' ||
    event.type === 'note_deleted' ||
    event.type === 'document_annotation_updated' ||
    event.type === 'document_annotation_deleted' ||
    event.type === 'document_text_order_override_updated' ||
    event.type === 'document_text_order_override_deleted' ||
    event.type === 'voice_profiles_updated' ||
    event.type === 'voice_casting_updated' ||
    event.type === 'user_correction_created' ||
    event.type === 'user_correction_deleted' ||
    event.type === 'character_graph_updated' ||
    event.type === 'chapter_segments_updated' ||
    event.type === 'shelf_membership_added' ||
    event.type === 'shelf_membership_removed'
  );
}

export async function hasExistingBookForEvent(
  client: pg.PoolClient,
  userId: string,
  event: SyncEvent,
): Promise<boolean> {
  if (!requiresExistingBook(event) || !event.novelId) return true;
  const result = await client.query<{ exists: boolean }>(
    'select true as exists from library_books where id = $1 and user_id = $2 for share',
    [event.novelId, userId],
  );
  return result.rows[0]?.exists ?? false;
}

export async function shouldAcceptSyncEvent(client: pg.PoolClient, userId: string, event: SyncEvent): Promise<boolean> {
  return (
    (await shouldAcceptReaderContentRevision(client, userId, event)) &&
    (await shouldAcceptReadingPositionEvent(client, userId, event)) &&
    (await shouldAcceptListeningPositionEvent(client, userId, event)) &&
    (await shouldAcceptUserEntityEvent(client, userId, event)) &&
    (await shouldAcceptVoiceProfilesEvent(client, userId, event)) &&
    (await shouldAcceptVoiceCastingEvent(client, userId, event)) &&
    (await shouldAcceptUserCorrectionEvent(client, userId, event)) &&
    (await shouldAcceptCharacterGraphEvent(client, userId, event)) &&
    (await shouldAcceptChapterSegmentsEvent(client, userId, event))
  );
}
