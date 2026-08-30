import pg from 'pg';
import { afterAll, describe, expect, test } from 'vitest';
import { migrateDatabase } from '../../db/migrate.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../id-v2-migration/postgres-integration-harness.js';
import { prepareBookReplacement, restoreExactAnchoredReaderState, type BookReplacementPreparation } from './service.js';

const harness = await startPostgresIntegrationHarness();
const describeWithPostgres = harness ? describe : describe.skip;
const timestamp = '2026-08-30T00:00:00.000Z';

async function seedBooks(pool: pg.Pool): Promise<void> {
  await pool.query(`insert into users (id, email, display_name) values ('user_test', 'test@example.com', 'Test')`);
  await pool.query(`
    insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes)
    values
      ('object_target_old', 'raw_target_old', 'target-old.cbz', 'target-old.cbz', 'application/zip', 100),
      ('object_target_new', 'raw_target_new', 'target-new.cbz', 'target-new.cbz', 'application/zip', 120),
      ('object_other_old', 'raw_other_old', 'other-old.cbz', 'other-old.cbz', 'application/zip', 100),
      ('object_other_new', 'raw_other_new', 'other-new.cbz', 'other-new.cbz', 'application/zip', 120)
  `);
  await pool.query(`
    insert into library_books (
      id, user_id, object_id, title, source_file_name, source_encoding,
      normalized_text_hash, total_chapters, total_characters, total_paragraphs
    ) values
      ('book_target', 'user_test', 'object_target_old', 'Target', 'target-old.cbz', 'binary',
       'normalized_target_old', 1, 0, 0),
      ('book_other', 'user_test', 'object_other_old', 'Other', 'other-old.cbz', 'binary',
       'normalized_other_old', 1, 0, 0)
  `);
}

async function prepareReplacement(
  pool: pg.Pool,
  input: {
    readonly bookId: string;
    readonly sourceObjectId: string;
    readonly sourceRawTextHash: string;
    readonly normalizedTextHash: string;
    readonly sourceFileName: string;
  },
): Promise<BookReplacementPreparation> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const preparation = await prepareBookReplacement(client, { userId: 'user_test', ...input });
    expect(preparation).toBeDefined();
    await client.query('commit');
    return preparation!;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seedQuarantine(
  pool: pg.Pool,
  input: {
    readonly id: string;
    readonly runId: string;
    readonly bookId: string;
    readonly artifactType: 'reading_position' | 'bookmark' | 'highlight' | 'note';
    readonly sourceEntityId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await pool.query(
    `
      insert into book_revision_quarantine (
        id, replacement_run_id, book_id, artifact_type, source_entity_id, reason, payload
      ) values ($1, $2, $3, $4, $5, 'book_content_replaced', $6::jsonb)
    `,
    [input.id, input.runId, input.bookId, input.artifactType, input.sourceEntityId, JSON.stringify(input.payload)],
  );
}

describeWithPostgres('exact reader-state restoration after fixed-document replacement', () => {
  afterAll(async () => {
    await harness?.stop();
  });

  test('restores only same-run, same-book rows whose chapter ids survived and marks them remapped', async () => {
    await withPostgresSchema(harness!, 'reader_state_restore', async (pool) => {
      await migrateDatabase(pool);
      await seedBooks(pool);
      const target = await prepareReplacement(pool, {
        bookId: 'book_target',
        sourceObjectId: 'object_target_new',
        sourceRawTextHash: 'raw_target_new',
        normalizedTextHash: 'normalized_target_new',
        sourceFileName: 'target-new.cbz',
      });
      const other = await prepareReplacement(pool, {
        bookId: 'book_other',
        sourceObjectId: 'object_other_new',
        sourceRawTextHash: 'raw_other_new',
        normalizedTextHash: 'normalized_other_new',
        sourceFileName: 'other-new.cbz',
      });
      await pool.query(`
        insert into chapters (
          id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset,
          character_count, paragraph_count
        ) values
          ('chapter_keep', 'book_target', 1, '2화 · 1페이지', 'hash_keep', 0, 0, 0, 0),
          ('chapter_other', 'book_other', 1, '1화 · 1페이지', 'hash_other', 0, 0, 0, 0)
      `);
      await pool.query(`
        insert into paragraph_search (
          id, paragraph_id, book_id, chapter_id, page_index, paragraph_index,
          text, text_lower, paragraph
        ) values (
          'search_keep', 'paragraph_keep', 'book_target', 'chapter_keep', 0, 0,
          'Exact paragraph', 'exact paragraph', '{"id":"paragraph_keep"}'::jsonb
        )
      `);

      const validRows = [
        {
          id: 'q_valid_position',
          artifactType: 'reading_position' as const,
          sourceEntityId: '["book_target", "user_test"]',
          payload: {
            book_id: 'book_target',
            user_id: 'user_test',
            chapter_id: 'chapter_keep',
            paragraph_id: null,
            paragraph_index: 0,
            offset_in_paragraph: 0,
            chapter_progress: 0.5,
            scroll_top: 240,
            device_id: 'device_test',
            updated_at: timestamp,
          },
        },
        {
          id: 'q_valid_bookmark',
          artifactType: 'bookmark' as const,
          sourceEntityId: 'bookmark_keep',
          payload: {
            id: 'bookmark_keep',
            book_id: 'book_target',
            user_id: 'user_test',
            chapter_id: 'chapter_keep',
            paragraph_id: null,
            label: 'Keep bookmark',
            progress: 0.5,
            scroll_top: 240,
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
          },
        },
        {
          id: 'q_valid_highlight',
          artifactType: 'highlight' as const,
          sourceEntityId: 'highlight_keep',
          payload: {
            id: 'highlight_keep',
            book_id: 'book_target',
            user_id: 'user_test',
            chapter_id: 'chapter_keep',
            paragraph_id: 'paragraph_keep',
            quote: 'Keep highlight',
            color: 'yellow',
            progress: 0.5,
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
          },
        },
        {
          id: 'q_valid_note',
          artifactType: 'note' as const,
          sourceEntityId: 'note_keep',
          payload: {
            id: 'note_keep',
            book_id: 'book_target',
            user_id: 'user_test',
            chapter_id: 'chapter_keep',
            paragraph_id: null,
            quote: null,
            body: 'Keep note',
            progress: 0.5,
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
          },
        },
      ];
      for (const row of validRows) {
        await seedQuarantine(pool, {
          ...row,
          runId: target.replacement.runId,
          bookId: target.replacement.bookId,
        });
      }
      await seedQuarantine(pool, {
        id: 'q_wrong_run',
        runId: other.replacement.runId,
        bookId: target.replacement.bookId,
        artifactType: 'bookmark',
        sourceEntityId: 'bookmark_wrong_run',
        payload: {
          ...validRows[1]!.payload,
          id: 'bookmark_wrong_run',
          label: 'Wrong run',
        },
      });
      await seedQuarantine(pool, {
        id: 'q_wrong_book',
        runId: target.replacement.runId,
        bookId: other.replacement.bookId,
        artifactType: 'highlight',
        sourceEntityId: 'highlight_wrong_book',
        payload: {
          ...validRows[2]!.payload,
          id: 'highlight_wrong_book',
          book_id: 'book_other',
          chapter_id: 'chapter_other',
          quote: 'Wrong book',
        },
      });
      await seedQuarantine(pool, {
        id: 'q_missing_chapter',
        runId: target.replacement.runId,
        bookId: target.replacement.bookId,
        artifactType: 'note',
        sourceEntityId: 'note_missing_chapter',
        payload: {
          ...validRows[3]!.payload,
          id: 'note_missing_chapter',
          chapter_id: 'chapter_removed',
          body: 'Missing chapter',
        },
      });
      await seedQuarantine(pool, {
        id: 'q_missing_paragraph',
        runId: target.replacement.runId,
        bookId: target.replacement.bookId,
        artifactType: 'highlight',
        sourceEntityId: 'highlight_missing_paragraph',
        payload: {
          ...validRows[2]!.payload,
          id: 'highlight_missing_paragraph',
          paragraph_id: 'paragraph_removed',
          quote: 'Missing paragraph',
        },
      });

      const client = await pool.connect();
      try {
        await client.query('begin');
        await expect(restoreExactAnchoredReaderState(client, target)).resolves.toBe(4);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      expect(
        (await pool.query(`select book_id, user_id, chapter_id from reading_positions order by book_id`)).rows,
      ).toEqual([{ book_id: 'book_target', user_id: 'user_test', chapter_id: 'chapter_keep' }]);
      expect((await pool.query(`select id, book_id, chapter_id from bookmarks order by id`)).rows).toEqual([
        { id: 'bookmark_keep', book_id: 'book_target', chapter_id: 'chapter_keep' },
      ]);
      expect((await pool.query(`select id, book_id, chapter_id from highlights order by id`)).rows).toEqual([
        { id: 'highlight_keep', book_id: 'book_target', chapter_id: 'chapter_keep' },
      ]);
      expect((await pool.query(`select id, book_id, chapter_id from notes order by id`)).rows).toEqual([
        { id: 'note_keep', book_id: 'book_target', chapter_id: 'chapter_keep' },
      ]);

      const quarantine = await pool.query(`
        select id, remap_status, remapped_entity_id, remapped_at is not null as was_remapped
          from book_revision_quarantine
         where id like 'q_%'
         order by id
      `);
      expect(quarantine.rows).toEqual([
        {
          id: 'q_missing_chapter',
          remap_status: 'quarantined',
          remapped_entity_id: null,
          was_remapped: false,
        },
        {
          id: 'q_missing_paragraph',
          remap_status: 'quarantined',
          remapped_entity_id: null,
          was_remapped: false,
        },
        {
          id: 'q_valid_bookmark',
          remap_status: 'remapped',
          remapped_entity_id: 'bookmark_keep',
          was_remapped: true,
        },
        {
          id: 'q_valid_highlight',
          remap_status: 'remapped',
          remapped_entity_id: 'highlight_keep',
          was_remapped: true,
        },
        {
          id: 'q_valid_note',
          remap_status: 'remapped',
          remapped_entity_id: 'note_keep',
          was_remapped: true,
        },
        {
          id: 'q_valid_position',
          remap_status: 'remapped',
          remapped_entity_id: '["book_target", "user_test"]',
          was_remapped: true,
        },
        {
          id: 'q_wrong_book',
          remap_status: 'quarantined',
          remapped_entity_id: null,
          was_remapped: false,
        },
        {
          id: 'q_wrong_run',
          remap_status: 'quarantined',
          remapped_entity_id: null,
          was_remapped: false,
        },
      ]);
    });
  }, 30_000);
});
