import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { defaultSettings } from '../../../../../src/repositories/reader-defaults';
import {
  validateReadingPositionBody,
  validateReadingPositionDeleteBody,
  validateSettingsBody,
  type ReadingPositionBody,
} from './request-contracts.js';
import { createServerRevision, insertServerSyncEvent } from './sync-event-repository.js';
import { lockReaderState } from '../../services/reader-state-lock.js';

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
      if (!body.expectedContentRevisionId) {
        return reply.code(400).send({ error: 'expectedContentRevisionId is required' });
      }

      const updatedAt = body.updatedAt;
      const client = await pool.connect();
      try {
        await client.query('begin');
        await lockReaderState(client, config.defaultUserId, request.params.bookId);
        const positionId = `reading_position_${request.params.bookId}`;
        const target = await client.query<{
          active_content_revision_id: string;
          document_section_id: string | null;
        }>(
          `select book.active_content_revision_id, chapter.document_section_id
             from library_books book
             join chapters chapter on chapter.book_id = book.id and chapter.id = $3
            where book.id = $1 and book.user_id = $2 and book.deleted_at is null
              and ($4::text is null or chapter.document_section_id = $4)
            for share of book, chapter`,
          [request.params.bookId, config.defaultUserId, body.chapterId, body.documentSectionId ?? null],
        );
        if (!target.rows[0]) {
          await client.query('rollback');
          return reply.code(404).send({ error: 'book or chapter not found' });
        }
        if (target.rows[0].active_content_revision_id !== body.expectedContentRevisionId) {
          await client.query('commit');
          return { ok: true, applied: false, reason: 'content_revision_changed' };
        }
        const documentSectionId = target.rows[0].document_section_id ?? undefined;
        const deletionFence = await client.query<{ blocked: boolean }>(
          `select exists(
             select 1 from sync_events
              where user_id = $1 and book_id = $2 and type = 'reading_position_deleted'
                and created_at >= $3::timestamptz
                and created_at > coalesce(
                  (select max(purge.created_at) from sync_events purge
                    where purge.user_id = $1 and purge.book_id = $2 and purge.type = 'book_purged'),
                  '-infinity'::timestamptz
                )
           ) as blocked`,
          [config.defaultUserId, request.params.bookId, updatedAt],
        );
        if (deletionFence.rows[0]?.blocked) {
          await client.query('commit');
          return { ok: true, applied: false };
        }
        const positionResult = await client.query(
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
            returning updated_at
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
        const positionApplied = (positionResult.rowCount ?? 0) > 0;
        let sectionApplied = false;

        if (documentSectionId) {
          const sectionResult = await client.query(
            `
              insert into fixed_document_section_read_states (
                book_id, user_id, document_section_id, last_read_at
              ) values ($1, $2, $3, $4)
              on conflict (book_id, user_id, document_section_id) do update
                set last_read_at = excluded.last_read_at
                where fixed_document_section_read_states.last_read_at <= excluded.last_read_at
              returning last_read_at
            `,
            [request.params.bookId, config.defaultUserId, documentSectionId, updatedAt],
          );
          sectionApplied = (sectionResult.rowCount ?? 0) > 0;
        }

        if (positionApplied || sectionApplied) {
          const payload = {
            position: {
              ...body,
              documentSectionId,
              contentRevisionId: body.expectedContentRevisionId,
              bookId: request.params.bookId,
              updatedAt,
            },
          };
          const revision = createServerRevision({
            entityType: 'reading_position',
            entityId: positionId,
            novelId: request.params.bookId,
            updatedAt,
            payload,
          });
          await insertServerSyncEvent(client, config.defaultUserId, {
            seed: `reading_position:${request.params.bookId}:${updatedAt}:${revision.payloadHash}`,
            type: 'reading_position_updated',
            bookId: request.params.bookId,
            entityId: positionId,
            deviceId: body.deviceId,
            payload,
            revision,
            createdAt: updatedAt,
          });
        }

        await client.query('commit');
        return { ok: true, applied: positionApplied || sectionApplied };
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: { bookId: string }; Body: ReadingPositionBody }>(
    '/api/books/:bookId/reading-position',
    async (request, reply) => {
      const parsed = validateReadingPositionDeleteBody(request.body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      const body = parsed.value;
      if (!body.expectedContentRevisionId) {
        return reply.code(400).send({ error: 'expectedContentRevisionId is required' });
      }
      const positionId = `reading_position_${request.params.bookId}`;
      const client = await pool.connect();
      try {
        await client.query('begin');
        await lockReaderState(client, config.defaultUserId, request.params.bookId);
        const contentRevision = await client.query<{ active_content_revision_id: string | null }>(
          `select active_content_revision_id
             from library_books
            where id = $1 and user_id = $2 and deleted_at is null
            for share`,
          [request.params.bookId, config.defaultUserId],
        );
        if (!contentRevision.rows[0]) {
          await client.query('rollback');
          return reply.code(404).send({ error: 'book not found' });
        }
        if (contentRevision.rows[0].active_content_revision_id !== body.expectedContentRevisionId) {
          await client.query('commit');
          return { ok: true, applied: false, reason: 'content_revision_changed' };
        }
        const status = await client.query<{ book_exists: boolean; should_apply: boolean }>(
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
                      and created_at > coalesce(
                        (select max(purge.created_at) from sync_events purge
                          where purge.user_id = $2 and purge.book_id = $1 and purge.type = 'book_purged'),
                        '-infinity'::timestamptz
                      )
                  ) versions
                ),
                true
              ) as should_apply
          `,
          [request.params.bookId, config.defaultUserId, body.updatedAt],
        );
        const row = status.rows[0];
        if (!row?.book_exists) {
          await client.query('rollback');
          return reply.code(404).send({ error: 'book not found' });
        }
        if (!row.should_apply) {
          await client.query('commit');
          return { ok: true, applied: false };
        }

        await client.query('delete from reading_positions where book_id = $1 and user_id = $2', [
          request.params.bookId,
          config.defaultUserId,
        ]);
        await client.query('delete from fixed_document_section_read_states where book_id = $1 and user_id = $2', [
          request.params.bookId,
          config.defaultUserId,
        ]);
        const payload = {
          id: positionId,
          bookId: request.params.bookId,
          deletedAt: body.updatedAt,
          expectedContentRevisionId: body.expectedContentRevisionId,
        };
        const revision = createServerRevision({
          entityType: 'reading_position',
          entityId: positionId,
          novelId: request.params.bookId,
          deletedAt: body.updatedAt,
          payload,
        });
        await insertServerSyncEvent(client, config.defaultUserId, {
          seed: `reading_position_deleted:${request.params.bookId}:${body.updatedAt}:${revision.payloadHash}`,
          type: 'reading_position_deleted',
          bookId: request.params.bookId,
          entityId: positionId,
          deviceId: body.deviceId,
          payload,
          revision,
          createdAt: body.updatedAt,
        });
        await client.query('commit');
        return { ok: true, applied: true };
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
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
