import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, test } from 'vitest';
import { migrateDatabase } from './migrate.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../services/id-v2-migration/postgres-integration-harness.js';

const migrationUrl = new URL('./migrations/0034_fixed_document_sections.sql', import.meta.url);
const harness = await startPostgresIntegrationHarness();
const describeWithPostgres = harness ? describe : describe.skip;

describeWithPostgres('fixed-document section migration backfill', () => {
  afterAll(async () => {
    await harness?.stop();
  });

  test('recovers legacy image-archive section metadata without inventing remote ids', async () => {
    await withPostgresSchema(harness!, 'fixed_document_sections', async (pool) => {
      await migrateDatabase(pool);
      await pool.query(`insert into users (id, email, display_name) values ('user_test', 'test@example.com', 'Test')`);
      await pool.query(`
        insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes)
        values ('object_legacy', 'raw_legacy', 'legacy.cbz', 'legacy.cbz', 'application/vnd.comicbook+zip', 100)
      `);
      await pool.query(`
        insert into library_books (
          id, user_id, object_id, title, source_file_name, source_encoding, format,
          normalized_text_hash, total_chapters, total_characters, total_paragraphs,
          document_section_count
        ) values (
          'book_legacy', 'user_test', 'object_legacy', 'Legacy series', 'legacy.cbz', 'binary', 'image_archive',
          'normalized_legacy', 3, 0, 0, null
        )
      `);
      await pool.query(`
        insert into chapters (
          id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset,
          character_count, paragraph_count, document_section_id, document_section_title,
          document_section_index, document_page_index_in_section
        ) values
          ('page_1_1', 'book_legacy', 1, '1화 · 1페이지', 'hash_1_1', 0, 0, 0, 0, null, null, null, null),
          ('page_1_2', 'book_legacy', 2, '1화 · 2페이지', 'hash_1_2', 0, 0, 0, 0, null, null, null, null),
          ('page_2_1', 'book_legacy', 3, '2화 · 1페이지', 'hash_2_1', 0, 0, 0, 0, null, null, null, null)
      `);

      const migrationSql = await readFile(migrationUrl, 'utf8');
      await pool.query(migrationSql);
      await pool.query(migrationSql);

      const chapters = await pool.query(`
        select id, document_section_id, document_section_title, document_section_index,
               document_page_index_in_section
          from chapters
         where book_id = 'book_legacy'
         order by chapter_index
      `);
      expect(chapters.rows).toEqual([
        {
          id: 'page_1_1',
          document_section_id: null,
          document_section_title: '1화',
          document_section_index: 1,
          document_page_index_in_section: 1,
        },
        {
          id: 'page_1_2',
          document_section_id: null,
          document_section_title: '1화',
          document_section_index: 1,
          document_page_index_in_section: 2,
        },
        {
          id: 'page_2_1',
          document_section_id: null,
          document_section_title: '2화',
          document_section_index: 2,
          document_page_index_in_section: 1,
        },
      ]);
      expect(
        (await pool.query(`select document_section_count from library_books where id = 'book_legacy'`)).rows[0],
      ).toEqual({ document_section_count: 2 });
    });
  }, 30_000);
});
