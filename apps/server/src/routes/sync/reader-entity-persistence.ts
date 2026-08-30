import pg from 'pg';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import {
  analysisStatusValue,
  numberValue,
  parseDocumentAnnotationDeletedPayload,
  parseDocumentAnnotationPayload,
  parseDocumentTextOrderOverrideDeletedPayload,
  parseDocumentTextOrderOverridePayload,
  record,
  stringValue,
} from './event-contracts.js';
import { purgeHostedBook } from '../../services/hosted-book-purge.js';

export async function persistReaderSyncEvent(
  client: pg.PoolClient,
  userId: string,
  event: SyncEvent,
): Promise<boolean> {
  const payload = record(event.payload);

  if (event.type === 'reading_position_updated') {
    const position = record(payload.position);
    if (position.chapterId && event.novelId) {
      await client.query(
        `
          insert into reading_positions (
            book_id, user_id, chapter_id, paragraph_id, paragraph_index, offset_in_paragraph,
            chapter_progress, scroll_top, device_id, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          on conflict (book_id, user_id) do update
            set chapter_id = excluded.chapter_id,
                paragraph_id = excluded.paragraph_id,
                paragraph_index = excluded.paragraph_index,
                offset_in_paragraph = excluded.offset_in_paragraph,
                chapter_progress = excluded.chapter_progress,
                scroll_top = excluded.scroll_top,
                device_id = excluded.device_id,
                updated_at = excluded.updated_at
            where reading_positions.updated_at <= excluded.updated_at
        `,
        [
          event.novelId,
          userId,
          String(position.chapterId),
          stringValue(position.paragraphId) ?? null,
          numberValue(position.paragraphIndex),
          numberValue(position.offsetInParagraph),
          numberValue(position.chapterProgress),
          numberValue(position.scrollTop),
          event.deviceId,
          String(position.updatedAt ?? event.createdAt),
        ],
      );
      await client.query(
        `
          insert into fixed_document_section_read_states (
            book_id, user_id, document_section_id, last_read_at
          )
          select $1, $2, chapter.document_section_id, $4::timestamptz
            from chapters chapter
           where chapter.id = $3
             and chapter.book_id = $1
             and chapter.document_section_id is not null
          on conflict (book_id, user_id, document_section_id) do update
            set last_read_at = excluded.last_read_at
            where fixed_document_section_read_states.last_read_at <= excluded.last_read_at
        `,
        [event.novelId, userId, String(position.chapterId), String(position.updatedAt ?? event.createdAt)],
      );
    }
    return true;
  }

  if (event.type === 'reading_position_deleted' && event.novelId) {
    await client.query(
      `
        with deleted_position as (
          delete from reading_positions where book_id = $1 and user_id = $2
        )
        delete from fixed_document_section_read_states where book_id = $1 and user_id = $2
      `,
      [event.novelId, userId],
    );
    return true;
  }

  if (event.type === 'listening_position_updated') {
    const position = record(payload.listeningPosition);
    const chapterId = stringValue(position.chapterId);
    const contentRevisionId = stringValue(position.contentRevisionId);
    const queueItemFingerprint = stringValue(position.queueItemFingerprint);
    const settingsFingerprint = stringValue(position.settingsFingerprint);
    if (event.novelId && chapterId && contentRevisionId && queueItemFingerprint && settingsFingerprint) {
      await client.query(
        `
          insert into listening_positions (
            book_id, user_id, chapter_id, anchor, queue_item_fingerprint,
            content_revision_id, settings_fingerprint, device_id, updated_at
          )
          values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
          on conflict (book_id, user_id) do update
            set chapter_id = excluded.chapter_id,
                anchor = excluded.anchor,
                queue_item_fingerprint = excluded.queue_item_fingerprint,
                content_revision_id = excluded.content_revision_id,
                settings_fingerprint = excluded.settings_fingerprint,
                device_id = excluded.device_id,
                updated_at = excluded.updated_at
            where listening_positions.updated_at <= excluded.updated_at
        `,
        [
          event.novelId,
          userId,
          chapterId,
          JSON.stringify(record(position.anchor)),
          queueItemFingerprint,
          contentRevisionId,
          settingsFingerprint,
          stringValue(position.deviceId) ?? event.deviceId,
          String(position.updatedAt ?? event.createdAt),
        ],
      );
    }
    return true;
  }

  if (event.type === 'listening_position_deleted' && event.novelId) {
    await client.query('delete from listening_positions where book_id = $1 and user_id = $2', [event.novelId, userId]);
    return true;
  }

  if (event.type === 'settings_updated') {
    const settings = record(payload.settings);
    await client.query(
      `
        insert into reader_settings (user_id, settings, updated_at)
        values ($1, $2, $3)
        on conflict (user_id) do update
          set settings = excluded.settings,
              updated_at = excluded.updated_at
      `,
      [userId, JSON.stringify(settings), event.createdAt],
    );
    return true;
  }

  if (event.type === 'book_updated' && event.novelId) {
    const novel = record(payload.novel);
    const provided = (key: string) => Object.prototype.hasOwnProperty.call(novel, key);
    const contentRevisionId = stringValue(payload.contentRevisionId);
    const updated = await client.query(
      `
        update library_books
        set title = coalesce($1, title),
            favorite = coalesce($2, favorite),
            analysis_status = coalesce($3, analysis_status),
            author = case when $8 then $9 else author end,
            series_title = case when $10 then $11 else series_title end,
            series_index = case when $12 then $13 else series_index end,
            tags = case when $14 then $15::jsonb else tags end,
            description = case when $16 then $17 else description end,
            language = case when $18 then $19 else language end,
            cover_fit = coalesce($20, cover_fit),
            cover_position_x = coalesce($21, cover_position_x),
            cover_position_y = coalesce($22, cover_position_y),
            cover_removed_at = case when $23 then $24::timestamptz else cover_removed_at end,
            metadata_revision = greatest(metadata_revision, $7),
            updated_at = $4
        where id = $5 and user_id = $6
          and ($25::text is null or active_content_revision_id = $25)
      `,
      [
        stringValue(novel.title) ?? stringValue(payload.title) ?? null,
        typeof novel.favorite === 'boolean'
          ? novel.favorite
          : typeof payload.favorite === 'boolean'
            ? payload.favorite
            : null,
        analysisStatusValue(novel.analysisStatus) ?? analysisStatusValue(payload.analysisStatus) ?? null,
        event.createdAt,
        event.novelId,
        userId,
        numberValue(novel.metadataRevision ?? payload.metadataRevision),
        provided('author'),
        stringValue(novel.author) ?? null,
        provided('seriesTitle'),
        stringValue(novel.seriesTitle) ?? null,
        provided('seriesIndex'),
        novel.seriesIndex === null ? null : numberValue(novel.seriesIndex, Number.NaN),
        provided('tags'),
        JSON.stringify(Array.isArray(novel.tags) ? novel.tags : []),
        provided('description'),
        stringValue(novel.description) ?? null,
        provided('language'),
        stringValue(novel.language) ?? null,
        novel.coverFit === 'crop' || novel.coverFit === 'contain' ? novel.coverFit : null,
        novel.coverPositionX === undefined ? null : numberValue(novel.coverPositionX),
        novel.coverPositionY === undefined ? null : numberValue(novel.coverPositionY),
        provided('coverRemovedAt'),
        stringValue(novel.coverRemovedAt) ?? null,
        contentRevisionId ?? null,
      ],
    );
    if (updated.rowCount === 0) throw new Error('accepted book_updated event did not mutate its fenced book');
    return true;
  }

  if (event.type === 'shelf_updated') {
    const shelf = record(payload.shelf);
    const id = stringValue(shelf.id) ?? event.entityId;
    const name = stringValue(shelf.name);
    if (!id || !name) return true;
    await client.query(
      `insert into shelves (id, user_id, name, color, sort_order, revision, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update set name = excluded.name, color = excluded.color,
         sort_order = excluded.sort_order, revision = excluded.revision, updated_at = excluded.updated_at
       where shelves.user_id = excluded.user_id and shelves.revision <= excluded.revision`,
      [
        id,
        userId,
        name,
        stringValue(shelf.color) ?? null,
        numberValue(shelf.sortOrder),
        numberValue(shelf.revision, 1),
        String(shelf.createdAt ?? event.createdAt),
        String(shelf.updatedAt ?? event.createdAt),
      ],
    );
    return true;
  }

  if (event.type === 'shelf_deleted') {
    const shelfId = stringValue(payload.shelfId) ?? event.entityId;
    if (shelfId) {
      await client.query('delete from shelves where id = $1 and user_id = $2 and revision <= $3', [
        shelfId,
        userId,
        numberValue(payload.revision),
      ]);
    }
    return true;
  }

  if (event.type === 'shelf_membership_added') {
    const membership = record(payload.membership);
    const id = stringValue(membership.id) ?? event.entityId;
    const shelfId = stringValue(membership.shelfId);
    const bookId = stringValue(membership.bookId) ?? event.novelId;
    if (!id || !shelfId || !bookId) return true;
    await client.query(
      `insert into shelf_memberships (id, shelf_id, book_id, user_id, created_at)
       select $1, shelf.id, book.id, $2, $5
       from shelves shelf join library_books book on book.id = $4 and book.user_id = $2
       where shelf.id = $3 and shelf.user_id = $2
       on conflict (shelf_id, book_id) do nothing`,
      [id, userId, shelfId, bookId, String(membership.createdAt ?? event.createdAt)],
    );
    return true;
  }

  if (event.type === 'shelf_membership_removed') {
    const id = stringValue(payload.id) ?? event.entityId;
    if (id) await client.query('delete from shelf_memberships where id = $1 and user_id = $2', [id, userId]);
    return true;
  }

  if (event.type === 'book_trashed' && event.novelId) {
    const metadataRevision = numberValue(payload.metadataRevision);
    const contentRevisionId = stringValue(payload.contentRevisionId);
    const updated = await client.query(
      `
        update library_books
        set deleted_at = $3,
            deleted_by_device_id = $4,
            metadata_revision = greatest(metadata_revision, $5),
            updated_at = $3
        where id = $1 and user_id = $2 and metadata_revision <= $5
          and ($6::text is null or active_content_revision_id = $6)
      `,
      [
        event.novelId,
        userId,
        String(payload.deletedAt ?? event.createdAt),
        stringValue(payload.deletedByDeviceId) ?? event.deviceId,
        metadataRevision,
        contentRevisionId ?? null,
      ],
    );
    if (updated.rowCount === 0) throw new Error('accepted book_trashed event did not mutate its fenced book');
    return true;
  }

  if (event.type === 'book_restored' && event.novelId) {
    const metadataRevision = numberValue(payload.metadataRevision);
    const contentRevisionId = stringValue(payload.contentRevisionId);
    const updated = await client.query(
      `
        update library_books
        set deleted_at = null,
            deleted_by_device_id = null,
            metadata_revision = greatest(metadata_revision, $4),
            updated_at = $3
        where id = $1 and user_id = $2 and metadata_revision <= $4
          and ($5::text is null or active_content_revision_id = $5)
      `,
      [
        event.novelId,
        userId,
        String(payload.restoredAt ?? event.createdAt),
        metadataRevision,
        contentRevisionId ?? null,
      ],
    );
    if (updated.rowCount === 0) throw new Error('accepted book_restored event did not mutate its fenced book');
    return true;
  }

  if (event.type === 'book_purged' && event.novelId) {
    const incomingMetadataRevision = payload.metadataRevision;
    const result = await purgeHostedBook(client, userId, event.novelId, {
      metadataRevision:
        typeof incomingMetadataRevision === 'number' && Number.isSafeInteger(incomingMetadataRevision)
          ? Math.max(0, incomingMetadataRevision - 1)
          : undefined,
      contentRevisionId: stringValue(payload.contentRevisionId),
      requireTrashed: true,
    });
    if (result.status !== 'purged')
      throw new Error(`accepted book_purged event failed canonical purge: ${result.status}`);
    return true;
  }

  if (event.type === 'book_deleted' && event.novelId) {
    const result = await purgeHostedBook(client, userId, event.novelId, {
      contentRevisionId: stringValue(payload.contentRevisionId),
      requireTrashed: false,
    });
    if (result.status !== 'purged')
      throw new Error(`accepted book_deleted event failed canonical purge: ${result.status}`);
    return true;
  }

  if (event.type === 'bookmark_created') {
    const bookmark = record(payload.bookmark);
    const bookId = stringValue(bookmark.novelId) ?? event.novelId;
    if (!bookId) return true;
    await client.query(
      `
        insert into bookmarks (id, book_id, user_id, chapter_id, paragraph_id, label, progress, scroll_top, created_at, updated_at)
        select $1, $2, $3, $4, $5, $6, $7, $8, $9, $9
        where exists (select 1 from library_books where id = $2 and user_id = $3)
        on conflict (id) do update
          set label = excluded.label,
              progress = excluded.progress,
              scroll_top = excluded.scroll_top,
              updated_at = excluded.updated_at,
              deleted_at = null
          where bookmarks.deleted_at is null
             or bookmarks.updated_at <= excluded.updated_at
      `,
      [
        stringValue(bookmark.id) ?? event.entityId,
        bookId,
        userId,
        stringValue(bookmark.chapterId),
        stringValue(bookmark.paragraphId) ?? null,
        stringValue(bookmark.label) ?? '',
        numberValue(bookmark.progress),
        numberValue(bookmark.scrollTop),
        String(bookmark.createdAt ?? event.createdAt),
      ],
    );
    return true;
  }

  if (event.type === 'bookmark_deleted') {
    const id = stringValue(payload.id) ?? event.entityId;
    const deletedAt = String(payload.deletedAt ?? event.createdAt);
    if (id) {
      await client.query(
        'update bookmarks set deleted_at = $3, updated_at = $3 where id = $1 and user_id = $2 and (deleted_at is null or updated_at <= $3::timestamptz)',
        [id, userId, deletedAt],
      );
    }
    return true;
  }

  if (event.type === 'highlight_created') {
    const highlight = record(payload.highlight);
    const bookId = stringValue(highlight.novelId) ?? event.novelId;
    if (!bookId) return true;
    await client.query(
      `
        insert into highlights (id, book_id, user_id, chapter_id, paragraph_id, quote, color, progress, created_at, updated_at)
        select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        where exists (select 1 from library_books where id = $2 and user_id = $3)
        on conflict (id) do update
          set quote = excluded.quote,
              color = excluded.color,
              progress = excluded.progress,
              updated_at = excluded.updated_at,
              deleted_at = null
          where highlights.deleted_at is null
             or highlights.updated_at <= excluded.updated_at
      `,
      [
        stringValue(highlight.id) ?? event.entityId,
        bookId,
        userId,
        stringValue(highlight.chapterId),
        stringValue(highlight.paragraphId),
        stringValue(highlight.quote) ?? '',
        stringValue(highlight.color) ?? 'yellow',
        numberValue(highlight.progress),
        String(highlight.createdAt ?? event.createdAt),
        String(highlight.updatedAt ?? event.createdAt),
      ],
    );
    return true;
  }

  if (event.type === 'highlight_deleted') {
    const id = stringValue(payload.id) ?? event.entityId;
    const deletedAt = String(payload.deletedAt ?? event.createdAt);
    if (id) {
      await client.query(
        'update highlights set deleted_at = $3, updated_at = $3 where id = $1 and user_id = $2 and (deleted_at is null or updated_at <= $3::timestamptz)',
        [id, userId, deletedAt],
      );
    }
    return true;
  }

  if (event.type === 'note_created' || event.type === 'note_updated') {
    const note = record(payload.note);
    const bookId = stringValue(note.novelId) ?? event.novelId;
    if (!bookId) return true;
    await client.query(
      `
        insert into notes (id, book_id, user_id, chapter_id, paragraph_id, quote, body, progress, created_at, updated_at)
        select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        where exists (select 1 from library_books where id = $2 and user_id = $3)
        on conflict (id) do update
          set quote = excluded.quote,
              body = excluded.body,
              progress = excluded.progress,
              updated_at = excluded.updated_at,
              deleted_at = null
          where notes.deleted_at is null
             or notes.updated_at <= excluded.updated_at
      `,
      [
        stringValue(note.id) ?? event.entityId,
        bookId,
        userId,
        stringValue(note.chapterId),
        stringValue(note.paragraphId) ?? null,
        stringValue(note.quote) ?? null,
        stringValue(note.body) ?? '',
        numberValue(note.progress),
        String(note.createdAt ?? event.createdAt),
        String(note.updatedAt ?? event.createdAt),
      ],
    );
    return true;
  }

  if (event.type === 'note_deleted') {
    const id = stringValue(payload.id) ?? event.entityId;
    const deletedAt = String(payload.deletedAt ?? event.createdAt);
    if (id) {
      await client.query(
        'update notes set deleted_at = $3, updated_at = $3 where id = $1 and user_id = $2 and (deleted_at is null or updated_at <= $3::timestamptz)',
        [id, userId, deletedAt],
      );
    }
    return true;
  }

  if (event.type === 'document_annotation_updated') {
    const parsed = parseDocumentAnnotationPayload(event);
    if (!parsed.ok) return true;
    const annotation = parsed.annotation;
    await client.query(
      `
        insert into document_annotations (
          id, book_id, user_id, page_index, annotation_type, anchor, body, color, created_at, updated_at
        )
        select $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10
        where exists (select 1 from library_books where id = $2 and user_id = $3)
        on conflict (id) do update
          set page_index = excluded.page_index,
              annotation_type = excluded.annotation_type,
              anchor = excluded.anchor,
              body = excluded.body,
              color = excluded.color,
              updated_at = excluded.updated_at,
              deleted_at = null
          where document_annotations.user_id = excluded.user_id
            and (document_annotations.deleted_at is null or document_annotations.updated_at <= excluded.updated_at)
      `,
      [
        parsed.id,
        parsed.bookId,
        userId,
        parsed.pageIndex,
        String(annotation.type),
        JSON.stringify(annotation.anchor),
        stringValue(annotation.body) ?? null,
        stringValue(annotation.color) ?? null,
        String(annotation.createdAt ?? event.createdAt),
        parsed.updatedAt,
      ],
    );
    return true;
  }

  if (event.type === 'document_annotation_deleted') {
    const parsed = parseDocumentAnnotationDeletedPayload(event);
    if (!parsed.ok) return true;
    await client.query(
      `update document_annotations
       set deleted_at = $3, updated_at = $3
       where id = $1 and user_id = $2 and (deleted_at is null or updated_at <= $3::timestamptz)`,
      [parsed.id, userId, parsed.deletedAt],
    );
    return true;
  }

  if (event.type === 'document_text_order_override_updated') {
    const parsed = parseDocumentTextOrderOverridePayload(event);
    if (!parsed.ok) return true;
    await client.query(
      `
        insert into document_text_order_overrides (
          id, book_id, user_id, page_index, page_hash, source_revision_id,
          ordered_block_fingerprints, excluded_block_fingerprints, created_at, updated_at
        )
        select $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10
        where exists (select 1 from library_books where id = $2 and user_id = $3)
        on conflict (id) do update
          set page_index = excluded.page_index,
              page_hash = excluded.page_hash,
              source_revision_id = excluded.source_revision_id,
              ordered_block_fingerprints = excluded.ordered_block_fingerprints,
              excluded_block_fingerprints = excluded.excluded_block_fingerprints,
              updated_at = excluded.updated_at,
              deleted_at = null
          where document_text_order_overrides.user_id = excluded.user_id
            and (document_text_order_overrides.deleted_at is null
              or document_text_order_overrides.updated_at <= excluded.updated_at)
      `,
      [
        parsed.id,
        parsed.bookId,
        userId,
        parsed.pageIndex,
        parsed.pageHash,
        parsed.sourceRevisionId,
        JSON.stringify(parsed.orderedBlockFingerprints),
        JSON.stringify(parsed.excludedBlockFingerprints),
        parsed.createdAt,
        parsed.updatedAt,
      ],
    );
    return true;
  }

  if (event.type === 'document_text_order_override_deleted') {
    const parsed = parseDocumentTextOrderOverrideDeletedPayload(event);
    if (!parsed.ok) return true;
    await client.query(
      `update document_text_order_overrides
       set deleted_at = $3, updated_at = $3
       where id = $1 and user_id = $2 and (deleted_at is null or updated_at <= $3::timestamptz)`,
      [parsed.id, userId, parsed.deletedAt],
    );
    return true;
  }

  return false;
}
