import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { defaultSettings } from '../../../../../src/repositories/reader-defaults';
import { hasBookChapterAccess } from './book-access-query.js';
import {
  validateReadingPositionBody,
  validateReadingPositionDeleteBody,
  validateSettingsBody,
  type ReadingPositionBody,
} from './request-contracts.js';
import { createServerRevision, insertServerSyncEvent } from './sync-event-repository.js';

export async function registerReaderStateRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.patch<{ Params: { bookId: string }; Body: ReadingPositionBody }>(
    '/api/books/:bookId/reading-position',
    async (request, reply) => {
      const parsed = validateReadingPositionBody(request.body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      const body = parsed.value;
      if (!(await hasBookChapterAccess(pool, config, request.params.bookId, body.chapterId, body.documentSectionId))) {
        return reply.code(404).send({ error: 'book or chapter not found' });
      }

      const updatedAt = body.updatedAt;
      const positionResult = await pool.query(
        `
          with position_write as (insert into reading_positions (
            book_id, user_id, chapter_id, paragraph_id, paragraph_index, offset_in_paragraph,
            chapter_progress, scroll_top, device_id, updated_at
          )
          select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz
          where not exists (
            select 1 from sync_events e where e.book_id = $1 and e.user_id = $2
              and e.type = 'reading_position_deleted' and e.created_at >= $10::timestamptz
          )
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
          returning updated_at),
          read_write as (
            insert into fixed_document_section_read_states (book_id, user_id, document_section_id, last_read_at)
            select c.book_id, $2, coalesce(c.document_section_id, c.id), $10::timestamptz
              from chapters c
             where c.book_id = $1 and c.id = $3
               and not exists (
                 select 1 from sync_events e where e.book_id = $1 and e.user_id = $2
                   and e.type = 'reading_position_deleted' and e.created_at >= $10::timestamptz
               )
            on conflict (book_id, user_id, document_section_id) do update
              set last_read_at = excluded.last_read_at
              where fixed_document_section_read_states.last_read_at < excluded.last_read_at
            returning document_section_id
          )
          select exists(select 1 from position_write) as applied,
                 exists(select 1 from read_write) as read_applied
        `,
        [
          request.params.bookId,
          config.defaultUserId,
          body.chapterId,
          body.paragraphId,
          body.paragraphIndex ?? 0,
          body.offsetInParagraph ?? 0,
          body.chapterProgress ?? 0,
          body.scrollTop ?? 0,
          body.deviceId,
          updatedAt,
        ],
      );
      const applied = positionResult.rows[0]?.applied === true;
      if (!applied && !positionResult.rows[0]?.read_applied) {
        return { ok: true, applied: false };
      }

      const positionId = `reading_position_${request.params.bookId}`;
      const payload = { position: { ...body, bookId: request.params.bookId, updatedAt } };
      await insertServerSyncEvent(pool, config.defaultUserId, {
        seed: `reading_position:${request.params.bookId}:${updatedAt}`,
        type: 'reading_position_updated',
        bookId: request.params.bookId,
        entityId: positionId,
        deviceId: body.deviceId,
        payload,
        revision: createServerRevision({
          entityType: 'reading_position',
          entityId: positionId,
          novelId: request.params.bookId,
          updatedAt,
          payload,
        }),
        createdAt: updatedAt,
      });

      return { ok: true, applied };
    },
  );

  app.delete<{ Params: { bookId: string }; Body: ReadingPositionBody }>(
    '/api/books/:bookId/reading-position',
    async (request, reply) => {
      const parsed = validateReadingPositionDeleteBody(request.body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      const body = parsed.value;
      const positionId = `reading_position_${request.params.bookId}`;

      const status = await pool.query<{ book_exists: boolean; should_apply: boolean }>(
        `
          select
            exists(select 1 from library_books where id = $1 and user_id = $2 and deleted_at is null) as book_exists,
            coalesce(
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
            ) as should_apply
        `,
        [request.params.bookId, config.defaultUserId, body.updatedAt, positionId],
      );
      const row = status.rows[0];
      if (!row?.book_exists) return reply.code(404).send({ error: 'book not found' });
      if (!row.should_apply) return { ok: true, applied: false };

      await pool.query('delete from reading_positions where book_id = $1 and user_id = $2', [
        request.params.bookId,
        config.defaultUserId,
      ]);
      await pool.query('delete from fixed_document_section_read_states where book_id = $1 and user_id = $2', [
        request.params.bookId,
        config.defaultUserId,
      ]);
      const payload = {
        id: positionId,
        bookId: request.params.bookId,
        deletedAt: body.updatedAt,
      };
      await insertServerSyncEvent(pool, config.defaultUserId, {
        seed: `reading_position_deleted:${request.params.bookId}:${body.updatedAt}`,
        type: 'reading_position_deleted',
        bookId: request.params.bookId,
        entityId: positionId,
        deviceId: body.deviceId,
        payload,
        revision: createServerRevision({
          entityType: 'reading_position',
          entityId: positionId,
          novelId: request.params.bookId,
          deletedAt: body.updatedAt,
          payload,
        }),
        createdAt: body.updatedAt,
      });

      return { ok: true, applied: true };
    },
  );

  app.get('/api/settings', async () => {
    const result = await pool.query('select settings from reader_settings where user_id = $1', [config.defaultUserId]);
    const stored = result.rows[0]?.settings ?? {};
    return {
      settings: {
        ...defaultSettings,
        ...stored,
        ttsPlayback: {
          ...defaultSettings.ttsPlayback,
          ...(stored.ttsPlayback ?? {}),
          rate: stored.ttsPlayback?.rate ?? stored.ttsSpeed ?? defaultSettings.ttsPlayback.rate,
        },
        readingProfile: { ...defaultSettings.readingProfile, ...(stored.readingProfile ?? {}) },
        gestureBindings: { ...defaultSettings.gestureBindings, ...(stored.gestureBindings ?? {}) },
      },
    };
  });

  app.put<{ Body: Record<string, unknown> }>('/api/settings', async (request, reply) => {
    const parsed = validateSettingsBody(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const settings = parsed.value;
    await pool.query(
      `
        insert into reader_settings (user_id, settings, updated_at)
        values ($1, $2, now())
        on conflict (user_id) do update
          set settings = excluded.settings,
              updated_at = excluded.updated_at
      `,
      [config.defaultUserId, JSON.stringify(settings)],
    );
    const updatedAt = new Date().toISOString();
    const payload = { settings };
    await insertServerSyncEvent(pool, config.defaultUserId, {
      seed: `settings_updated:${updatedAt}`,
      type: 'settings_updated',
      entityId: defaultSettings.id,
      payload,
      revision: createServerRevision({
        entityType: 'settings',
        entityId: defaultSettings.id,
        updatedAt,
        payload,
      }),
      createdAt: updatedAt,
    });
    return { ok: true, settings };
  });
}
