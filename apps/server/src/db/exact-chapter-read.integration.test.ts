import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';
import type { ServerConfig } from '../config.js';
import { migrateDatabase } from './migrate.js';
import { registerReaderStateRoutes } from '../routes/books/reader-state-routes.js';
import { registerBookContentRoutes } from '../routes/books/content-routes.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../services/id-v2-migration/postgres-integration-harness.js';

const harness = await startPostgresIntegrationHarness();
const describeWithPostgres = harness ? describe : describe.skip;
const migrationUrl = new URL('./migrations/0041_exact_chapter_read_compatibility.sql', import.meta.url);

describeWithPostgres('exact chapter reads through hosted HTTP routes and real PostgreSQL', () => {
  afterAll(async () => harness?.stop());

  test.each(['txt', 'epub', 'legacy-comic', 'comic'])(
    '%s preserves old content and only records chapters actually visited',
    async (kind) => {
      await withPostgresSchema(harness!, 'exact_reads', async (pool) => {
        await migrateDatabase(pool);
        const comic = kind.includes('comic');
        const pageCount = comic ? 12 : 6;
        await pool.query(
          "insert into users (id, email, display_name) values ('user_test', 'test@example.com', 'Test')",
        );
        await pool.query(
          "insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes) values ('old-object', 'old-source-hash', 'old-source', 'old-source', 'application/octet-stream', 100)",
        );
        await pool.query(
          `insert into library_books (id, user_id, object_id, title, source_file_name, source_encoding, format, normalized_text_hash, total_chapters, total_characters, total_paragraphs)
          values ('book', 'user_test', 'old-object', 'Old book', 'old-source', 'utf-8', $1, 'unchanged-text-hash', $2, 60, 6)`,
          [comic ? 'image_archive' : kind, pageCount],
        );
        for (let i = 1; i <= pageCount; i++) {
          const section = comic ? Math.ceil(i / 2) : i;
          await pool.query(
            `insert into chapters (id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset, character_count, paragraph_count, document_section_id, document_section_title, document_section_index, document_page_index_in_section)
            values ($1, 'book', $2, $3, $4, $5, $6, 10, 1, $7, $8, $9, $10)`,
            [
              `page-${i}`,
              i,
              comic ? `${section}화 · ${i % 2 ? 1 : 2}페이지` : `${i}화`,
              `unchanged-${i}`,
              i * 10,
              i * 10 + 9,
              kind === 'comic' ? `chapter:${section}` : null,
              comic ? `${section}화` : null,
              comic ? section : null,
              comic ? (i % 2 ? 1 : 2) : null,
            ],
          );
        }
        // Old databases only prove the one saved position. The preceding chapter must stay unread.
        const pageId = (section: number) => `page-${comic ? section * 2 - 1 : section}`;
        await pool.query(
          `insert into reading_positions (book_id, user_id, chapter_id, chapter_progress, scroll_top, device_id, updated_at)
          values ('book', 'user_test', $1, 0.4, 10, 'phone', '2026-08-30T00:00:00Z')`,
          [pageId(2)],
        );
        const beforeBook = (await pool.query('select * from library_books')).rows;
        const contentSql =
          'select id, title, text_hash, raw_start_offset, raw_end_offset from chapters order by chapter_index';
        const beforeContent = (await pool.query(contentSql)).rows;
        const sql = await readFile(migrationUrl, 'utf8');
        await pool.query(sql);
        await pool.query(sql); // idempotent without source reimport/revision replacement
        expect((await pool.query('select * from library_books')).rows).toEqual(beforeBook);
        expect((await pool.query(contentSql)).rows).toEqual(beforeContent);

        const config = { defaultUserId: 'user_test' } as ServerConfig;
        const app = Fastify();
        await registerReaderStateRoutes(app, pool, config);
        await registerBookContentRoutes(app, pool, config);
        try {
          const chapters = async () => {
            const response = await app.inject({ method: 'GET', url: '/api/books/book/chapters' });
            expect(response.statusCode).toBe(200);
            return response.json().chapters as Array<{
              id: string;
              document_section_id: string | null;
              document_section_read_at: string | null;
            }>;
          };
          const readSections = async () =>
            (await chapters()).filter((c, i) => !comic || i % 2 === 0).map((c) => Boolean(c.document_section_read_at));
          expect(await readSections()).toEqual([false, true, false, false, false, false]);
          const save = async (section: number, minute: number, documentSectionId?: string) => {
            const response = await app.inject({
              method: 'PATCH',
              url: '/api/books/book/reading-position',
              payload: {
                chapterId: pageId(section),
                documentSectionId,
                chapterProgress: 0.4,
                scrollTop: 10,
                deviceId: 'phone',
                updatedAt: `2026-08-31T00:${String(minute).padStart(2, '0')}:00.000Z`,
              },
            });
            expect(response.statusCode, response.body).toBe(200);
            return response.json();
          };
          // Also exercise old clients that omit section ids: the server resolves the saved chapter.
          await save(1, 1);
          const sixth = (await chapters()).find((c) => c.id === pageId(6))!;
          await save(6, 6, sixth.document_section_id ?? undefined);
          expect(await readSections()).toEqual([true, true, false, false, false, true]);
          await save(2, 7);
          expect(await readSections()).toEqual([true, true, false, false, false, true]);
          expect((await pool.query('select chapter_id from reading_positions')).rows[0].chapter_id).toBe(pageId(2));
          // A slow earlier read retains its history but cannot move the resume position backwards.
          expect(await save(3, 3)).toMatchObject({ applied: false });
          expect(await readSections()).toEqual([true, true, true, false, false, true]);
          expect((await pool.query('select chapter_id from reading_positions')).rows[0].chapter_id).toBe(pageId(2));
          const invalid = await app.inject({
            method: 'PATCH',
            url: '/api/books/book/reading-position',
            payload: {
              chapterId: pageId(4),
              documentSectionId: 'wrong-section',
              deviceId: 'phone',
              updatedAt: '2026-08-31T00:08:00Z',
            },
          });
          expect(invalid.statusCode).toBe(404);
          const reset = await app.inject({
            method: 'DELETE',
            url: '/api/books/book/reading-position',
            payload: { deviceId: 'phone', updatedAt: '2026-08-31T00:10:00Z' },
          });
          expect(reset.statusCode).toBe(200);
          expect(await readSections()).toEqual([false, false, false, false, false, false]);
          expect(await save(6, 9)).toMatchObject({ applied: false });
          expect(await readSections()).toEqual([false, false, false, false, false, false]);
          expect((await pool.query('select * from reading_positions')).rows).toEqual([]);
          const manifest = await app.inject({ method: 'GET', url: '/api/books/book/manifest' });
          expect(manifest.statusCode, manifest.body).toBe(200);
        } finally {
          await app.close();
        }
      });
    },
    30_000,
  );

  test(
    'keeps a reading-position write made while the same comic is being appended',
    async () => {
      await withPostgresSchema(harness!, 'append_read_position', async (pool) => {
        await migrateDatabase(pool);
        await pool.query(
          "insert into users (id, email, display_name) values ('user_test', 'test@example.com', 'Test')",
        );
        await pool.query(
          "insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes) values ('object', 'source-hash', 'source', 'source.cbz', 'application/vnd.comicbook+zip', 100)",
        );
        await pool.query(
          `insert into library_books (
             id, user_id, object_id, title, source_file_name, source_encoding, format,
             normalized_text_hash, total_chapters, total_characters, total_paragraphs
           ) values (
             'book', 'user_test', 'object', 'Comic', 'source.cbz', 'binary', 'image_archive',
             'content-hash', 1, 0, 1
           )`,
        );
        await pool.query(
          `insert into chapters (
             id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset,
             character_count, paragraph_count, document_section_id, document_section_title,
             document_section_index, document_page_index_in_section
           ) values (
             'page-1', 'book', 1, '1화 · 1페이지', 'page-hash', 0, 1,
             0, 1, 'chapter:1', '1화', 1, 1
           )`,
        );
        await pool.query(
          `insert into reading_positions (
             book_id, user_id, chapter_id, chapter_progress, scroll_top, device_id, updated_at
           ) values ('book', 'user_test', 'page-1', 0.1, 0, 'phone', '2026-09-04T00:00:00Z')`,
        );

        const config = { defaultUserId: 'user_test' } as ServerConfig;
        const app = Fastify();
        await registerReaderStateRoutes(app, pool, config);
        const appendClient = await pool.connect();
        try {
          await appendClient.query('select pg_advisory_lock(hashtextextended($1, 7319))', ['book']);
          let requestSettled = false;
          const saveRequest = app
            .inject({
              method: 'PATCH',
              url: '/api/books/book/reading-position',
              payload: {
                chapterId: 'page-1',
                documentSectionId: 'chapter:1',
                chapterProgress: 0.7,
                scrollTop: 7,
                deviceId: 'phone',
                updatedAt: '2026-09-04T00:01:00Z',
              },
            })
            .finally(() => {
              requestSettled = true;
            });

          await new Promise((resolve) => setTimeout(resolve, 25));
          expect(requestSettled).toBe(false);

          // Model the generic replacement restore that used to overwrite a read made
          // after the append snapshot with its older quarantined position.
          await appendClient.query(
            `insert into reading_positions (
               book_id, user_id, chapter_id, chapter_progress, scroll_top, device_id, updated_at
             ) values ('book', 'user_test', 'page-1', 0.1, 0, 'phone', '2026-09-04T00:00:00Z')
             on conflict (book_id, user_id) do update
               set chapter_id = excluded.chapter_id,
                   chapter_progress = excluded.chapter_progress,
                   scroll_top = excluded.scroll_top,
                   device_id = excluded.device_id,
                   updated_at = excluded.updated_at`,
          );
          await appendClient.query('select pg_advisory_unlock(hashtextextended($1, 7319))', ['book']);

          const response = await saveRequest;
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json()).toMatchObject({ ok: true, applied: true });
          expect(
            (
              await pool.query(
                `select chapter_id, chapter_progress::float8 as chapter_progress, scroll_top, updated_at
                   from reading_positions where book_id = 'book' and user_id = 'user_test'`,
              )
            ).rows[0],
          ).toMatchObject({
            chapter_id: 'page-1',
            chapter_progress: 0.7,
            scroll_top: 7,
          });
          expect(
            (
              await pool.query(
                `select document_section_id from fixed_document_section_read_states
                  where book_id = 'book' and user_id = 'user_test'`,
              )
            ).rows,
          ).toEqual([{ document_section_id: 'chapter:1' }]);
        } finally {
          await appendClient.query('select pg_advisory_unlock(hashtextextended($1, 7319))', ['book']);
          appendClient.release();
          await app.close();
        }
      });
    },
    30_000,
  );
});
