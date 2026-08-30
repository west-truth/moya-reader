import { setTimeout as delay } from 'node:timers/promises';
import { textIntegrityHash } from '@noveldesk/text-core/hash';
import pg from 'pg';
import { afterAll, describe, expect, test } from 'vitest';
import { migrateDatabase } from '../../db/migrate.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../id-v2-migration/postgres-integration-harness.js';
import { finalizeBookReplacement, prepareBookReplacement } from './service.js';
import { appWithSync, canonicalV2Event, v2PushEnvelope } from '../../routes/sync/sync-route-test-harness.js';

const harness = await startPostgresIntegrationHarness();
const describeWithPostgres = harness ? describe : describe.skip;

async function seedBook(pool: pg.Pool): Promise<{ contentRevisionId: string; anchorHash: string }> {
  const anchorText = 'The exact source sentence.';
  const anchorHash = textIntegrityHash(anchorText);
  await pool.query(`insert into users (id, email, display_name) values ('user_test', 'test@example.com', 'Test')`);
  await pool.query(`
    insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes)
    values ('object_old', 'raw_old', 'old.txt', 'old.txt', 'text/plain', 100)
  `);
  await pool.query(
    `
      insert into library_books (
        id, user_id, object_id, title, source_file_name, source_encoding,
        normalized_text_hash, total_chapters, total_characters, total_paragraphs
      )
      values ('book_1', 'user_test', 'object_old', 'Reader title', 'old.txt', 'utf-8', 'normalized_old', 1, 26, 1)
    `,
  );
  const book = await pool.query<{ active_content_revision_id: string }>(
    `select active_content_revision_id from library_books where id = 'book_1'`,
  );
  const contentRevisionId = book.rows[0].active_content_revision_id;
  await pool.query(`
    insert into chapters (
      id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset,
      character_count, paragraph_count
    ) values ('chapter_old', 'book_1', 1, 'Chapter', 'chapter_hash_old', 0, 26, 26, 1)
  `);
  await pool.query(
    `
      insert into paragraph_search (
        id, paragraph_id, book_id, chapter_id, page_index, paragraph_index,
        text, text_lower, paragraph
      )
      values ('search_old', 'paragraph_old', 'book_1', 'chapter_old', 0, 0, $1, lower($1), $2)
    `,
    [
      anchorText,
      JSON.stringify({
        id: 'paragraph_old',
        novelId: 'book_1',
        chapterId: 'chapter_old',
        index: 0,
        text: anchorText,
        startOffsetInChapter: 0,
        endOffsetInChapter: anchorText.length,
        textHash: anchorHash,
      }),
    ],
  );
  const anchor = JSON.stringify({
    kind: 'paragraph',
    chapterIndex: 1,
    paragraphIndex: 0,
    paragraphId: 'paragraph_old',
    textHash: anchorHash,
  });
  for (const id of ['character_keep_1', 'character_keep_2']) {
    await pool.query(
      `
        insert into characters (
          id, book_id, user_id, canonical_name, aliases, color, confidence,
          is_user_confirmed, source_content_revision_id, source_anchor,
          source_anchor_hash, provenance_kind
        )
        values ($1, 'book_1', 'user_test', $1, '[]', '#123456', 1, true, $2, $3, $4, 'user_confirmed')
      `,
      [id, contentRevisionId, anchor, anchorHash],
    );
  }
  await pool.query(
    `
      insert into characters (
        id, book_id, user_id, canonical_name, aliases, color, confidence,
        is_user_confirmed, source_content_revision_id, source_anchor,
        source_anchor_hash, provenance_kind
      )
      values (
        'character_index_moved', 'book_1', 'user_test', 'Index moved', '[]', '#abcdef', 1,
        true, $1, $2, $3, 'user_confirmed'
      )
    `,
    [
      contentRevisionId,
      JSON.stringify({
        kind: 'paragraph',
        chapterIndex: 1,
        paragraphIndex: 3,
        paragraphId: 'paragraph_old_index_3',
        textHash: anchorHash,
      }),
      anchorHash,
    ],
  );
  await pool.query(
    `
      insert into characters (
        id, book_id, user_id, canonical_name, aliases, color, confidence,
        is_user_confirmed, source_content_revision_id, source_anchor,
        source_anchor_hash, provenance_kind
      )
      values (
        'character_legacy', 'book_1', 'user_test', 'Legacy', '[]', '#654321', 1, true,
        $1, '{"kind":"legacy_book"}', 'normalized_old', 'user_confirmed'
      ), (
        'character_generated', 'book_1', 'user_test', 'Generated', '[]', '#999999', 0.5, false,
        $1, null, null, 'generated'
      )
    `,
    [contentRevisionId],
  );
  await pool.query(`
    insert into character_relations (
      id, book_id, source_character_id, target_character_id, relation_label,
      terms_used_by_source, terms_used_by_target, confidence, evidence
    ) values (
      'relation_keep', 'book_1', 'character_keep_1', 'character_keep_2', 'ally', '[]', '[]', 1, '[]'
    )
  `);
  await pool.query(
    `
      insert into voice_profiles (
        id, book_id, character_id, role, provider_id, provider_voice_id, label,
        speed, provider_options, is_user_selected, source_content_revision_id,
        source_anchor, source_anchor_hash
      )
      values (
        'voice_keep', 'book_1', 'character_keep_1', 'character', 'mock', 'voice', 'Voice',
        1, '{}', true, $1, $2, $3
      )
    `,
    [contentRevisionId, anchor, anchorHash],
  );
  await pool.query(
    `
      insert into user_corrections (
        id, book_id, chapter_id, paragraph_id, correction_type, after_json, apply_scope,
        source_content_revision_id, source_anchor, source_anchor_hash
      ) values (
        'correction_keep', 'book_1', 'chapter_old', 'paragraph_old', 'speaker', '{}', 'chapter', $1, $2, $3
      ), (
        'correction_mismatch', 'book_1', 'chapter_old', 'paragraph_old', 'speaker', '{}', 'chapter',
        $1, $2, 'different_hash'
      )
    `,
    [contentRevisionId, anchor, anchorHash],
  );
  await pool.query(`
    insert into analysis_runs (
      id, book_id, chapter_id, run_type, provider_id, input_hash, status
    ) values ('run_old', 'book_1', 'chapter_old', 'label', 'mock', 'input', 'succeeded')
  `);
  await pool.query(
    `
      insert into labeled_segments (
        id, book_id, chapter_id, paragraph_id, segment_index, start_offset, end_offset,
        segment_text_hash, segment_type, speaker_id, emotion, confidence, analysis_run_id
      ) values (
        'segment_old', 'book_1', 'chapter_old', 'paragraph_old', 0, 0, $1,
        $2, 'narration', 'narrator', 'neutral', 1, 'run_old'
      )
    `,
    [anchorText.length, anchorHash],
  );
  await pool.query(`
    insert into chapter_contexts (
      id, book_id, chapter_id, analysis_run_id, summary
    ) values ('context_old', 'book_1', 'chapter_old', 'run_old', 'old context')
  `);
  await pool.query(`
    insert into tts_audio_cache (
      id, book_id, chapter_id, cache_key, provider_id, voice_profile_id,
      input_text_hash, options_hash, audio_object_key
    ) values (
      'cache_old', 'book_1', 'chapter_old', 'cache-key', 'mock', 'voice_keep',
      'input-hash', 'options-hash', 'audio.mp3'
    )
  `);
  await pool.query(`
    insert into book_ai_workflows (
      id, user_id, book_id, provider_id, model_id, plan_hash, plan, status, stage
    ) values ('workflow_running', 'user_test', 'book_1', 'mock', 'model', 'plan', '{}', 'running', 'building_graph')
  `);
  await pool.query(`
    insert into provider_jobs (
      id, user_id, book_id, chapter_id, job_type, provider_id, model_id,
      input_hash, status, stage
    ) values (
      'job_running', 'user_test', 'book_1', 'chapter_old', 'chapter_segment_labeling',
      'mock', 'model', 'job-input', 'queued', 'queued'
    )
  `);
  await pool.query(`
    insert into provider_job_attempts (
      id, provider_job_id, attempt_number, bullmq_job_id, status, stage
    ) values ('attempt_running', 'job_running', 1, 'attempt_running', 'queued', 'queued')
  `);
  await pool.query(
    `update provider_jobs set current_attempt_id = 'attempt_running', attempt_count = 1 where id = 'job_running'`,
  );
  await pool.query(
    `update provider_job_attempts set status = 'running', stage = 'running' where id = 'attempt_running'`,
  );
  await pool.query(`update provider_jobs set status = 'running', stage = 'running' where id = 'job_running'`);
  await pool.query(`
    insert into reading_positions (
      book_id, user_id, chapter_id, paragraph_id, paragraph_index,
      offset_in_paragraph, chapter_progress, scroll_top
    ) values ('book_1', 'user_test', 'chapter_old', 'paragraph_old', 0, 7, 0.25, 120)
  `);
  await pool.query(`
    insert into bookmarks (
      id, book_id, user_id, chapter_id, paragraph_id, label, progress, scroll_top
    ) values ('bookmark_old', 'book_1', 'user_test', 'chapter_old', 'paragraph_old', 'Old bookmark', 0.25, 120)
  `);
  await pool.query(`
    insert into highlights (
      id, book_id, user_id, chapter_id, paragraph_id, quote, color, progress
    ) values ('highlight_old', 'book_1', 'user_test', 'chapter_old', 'paragraph_old', 'Old highlight', 'yellow', 0.25)
  `);
  await pool.query(`
    insert into notes (
      id, book_id, user_id, chapter_id, paragraph_id, quote, body, progress
    ) values ('note_old', 'book_1', 'user_test', 'chapter_old', 'paragraph_old', 'Old note', 'Body', 0.25)
  `);
  await pool.query(`update library_books set favorite = true where id = 'book_1'`);
  return { contentRevisionId, anchorHash };
}

async function waitForBlockedSharedBookLock(pool: pg.Pool): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(`
      select exists (
        select 1
        from pg_stat_activity
        where wait_event_type = 'Lock'
          and query like '%from library_books where id = $1 and user_id = $2 for share%'
      ) as blocked
    `);
    if (result.rows[0]?.blocked) return;
    await delay(20);
  }
  throw new Error('sync push did not block on the replacement book lock');
}

describeWithPostgres('book replacement revision lifecycle', () => {
  afterAll(async () => {
    await harness?.stop();
  });

  test('fences active work, quarantines generated data, and remaps only exact paragraph anchors', async () => {
    await withPostgresSchema(harness!, 'book_replacement', async (pool) => {
      await migrateDatabase(pool);
      const { contentRevisionId, anchorHash } = await seedBook(pool);
      const app = await appWithSync(pool);
      await pool.query(`
        insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes)
        values ('object_new', 'raw_new', 'new.txt', 'new.txt', 'text/plain', 120)
      `);
      const client = await pool.connect();
      try {
        await client.query('begin');
        const preparation = await prepareBookReplacement(client, {
          userId: 'user_test',
          bookId: 'book_1',
          sourceObjectId: 'object_new',
          sourceRawTextHash: 'raw_new',
          normalizedTextHash: 'normalized_new',
          sourceFileName: 'new.txt',
          sourceEncoding: 'utf-8',
        });
        expect(preparation).toBeDefined();
        const preparingState = await client.query(
          `
            select revision.id, revision.status, book.active_content_revision_id
            from book_content_revisions revision
            join library_books book on book.id = revision.book_id
            where revision.book_id = 'book_1'
            order by revision.revision_number
          `,
        );
        expect(preparingState.rows).toEqual([
          {
            id: contentRevisionId,
            status: 'active',
            active_content_revision_id: contentRevisionId,
          },
          {
            id: preparation!.replacement.toContentRevisionId,
            status: 'preparing',
            active_content_revision_id: contentRevisionId,
          },
        ]);
        await client.query(`
          update library_books
          set object_id = 'object_new', normalized_text_hash = 'normalized_new', source_file_name = 'new.txt'
          where id = 'book_1'
        `);
        await client.query(`delete from paragraph_search where book_id = 'book_1'`);
        await client.query(`delete from chapters where book_id = 'book_1'`);
        await client.query(`
          insert into chapters (
            id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset,
            character_count, paragraph_count
          ) values ('chapter_new', 'book_1', 1, 'Chapter revised', 'chapter_hash_new', 0, 30, 30, 1)
        `);
        const text = 'The exact source sentence.';
        await client.query(
          `
            insert into paragraph_search (
              id, paragraph_id, book_id, chapter_id, page_index, paragraph_index,
              text, text_lower, paragraph
            ) values ('search_new', 'paragraph_new', 'book_1', 'chapter_new', 0, 0, $1, lower($1), $2)
          `,
          [
            text,
            JSON.stringify({
              id: 'paragraph_new',
              novelId: 'book_1',
              chapterId: 'chapter_new',
              index: 0,
              text,
              startOffsetInChapter: 0,
              endOffsetInChapter: text.length,
              textHash: anchorHash,
            }),
          ],
        );
        const summary = await finalizeBookReplacement(client, preparation!);
        expect(summary).toMatchObject({
          cancelledWorkflowCount: 1,
          cancelledProviderJobCount: 1,
          remappedCharacterCount: 2,
          remappedRelationCount: 1,
          remappedVoiceProfileCount: 1,
          remappedCorrectionCount: 1,
        });
        const staleEvent = canonicalV2Event({
          id: 'event_stale_during_replacement',
          type: 'reading_position_updated',
          deviceId: 'device_a',
          novelId: 'book_1',
          entityId: 'reading_position_book_1',
          payload: {
            position: {
              chapterId: 'chapter_new',
              paragraphId: 'paragraph_new',
              paragraphIndex: 0,
              offsetInParagraph: 3,
              chapterProgress: 0.42,
              scrollTop: 240,
              updatedAt: '2026-07-05T00:02:00.000Z',
            },
          },
          revision: {
            entityType: 'reading_position',
            entityId: 'reading_position_book_1',
            novelId: 'book_1',
            localSequence: 2,
            updatedAt: '2026-07-05T00:02:00.000Z',
            payloadHash: 'fixture',
          },
          createdAt: '2026-07-05T00:02:00.000Z',
        });
        const stalePush = app.inject({
          method: 'POST',
          url: '/api/sync/events',
          payload: v2PushEnvelope([staleEvent]),
        });
        await waitForBlockedSharedBookLock(pool);
        await client.query('commit');
        const staleResponse = await stalePush;
        expect(staleResponse.statusCode).toBe(200);
        expect(staleResponse.json()).toMatchObject({
          accepted: 0,
          acceptedIds: [],
          rejected: [{ id: staleEvent.id, reason: 'stale' }],
        });
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      const book = await pool.query(
        `select active_content_revision_id, content_revision_number, revision_fence, analysis_status, title, favorite from library_books where id = 'book_1'`,
      );
      expect(book.rows[0]).toMatchObject({
        content_revision_number: '2',
        revision_fence: '2',
        analysis_status: 'not_analyzed',
        title: 'Reader title',
        favorite: true,
      });
      expect(book.rows[0].active_content_revision_id).not.toBe(contentRevisionId);
      const workflow = await pool.query(
        `select status, error_code from book_ai_workflows where id = 'workflow_running'`,
      );
      expect(workflow.rows[0]).toEqual({ status: 'cancelled', error_code: 'book_revision_replaced' });
      const job = await pool.query(
        `select status, stage, chapter_id, error_code from provider_jobs where id = 'job_running'`,
      );
      expect(job.rows[0]).toEqual({
        status: 'cancelled',
        stage: 'stale',
        chapter_id: null,
        error_code: 'book_revision_replaced',
      });
      const characters = await pool.query(`select id, source_anchor from characters order by id`);
      expect(characters.rows.map((row) => row.id)).toEqual(['character_keep_1', 'character_keep_2']);
      expect(characters.rows[0].source_anchor).toMatchObject({
        paragraphId: 'paragraph_new',
        paragraphIndex: 0,
        textHash: anchorHash,
      });
      const relations = await pool.query(`select id from character_relations`);
      expect(relations.rows).toEqual([{ id: 'relation_keep' }]);
      const voice = await pool.query(`select id, source_anchor from voice_profiles`);
      expect(voice.rows[0]).toMatchObject({
        id: 'voice_keep',
        source_anchor: expect.objectContaining({ paragraphId: 'paragraph_new' }),
      });
      const corrections = await pool.query(`select id, chapter_id, paragraph_id from user_corrections`);
      expect(corrections.rows).toEqual([
        { id: 'correction_keep', chapter_id: 'chapter_new', paragraph_id: 'paragraph_new' },
      ]);
      const quarantined = await pool.query(
        `select source_entity_id, remap_status from book_revision_quarantine where artifact_type in ('character', 'user_correction') order by source_entity_id`,
      );
      expect(quarantined.rows).toEqual(
        expect.arrayContaining([
          { source_entity_id: 'character_generated', remap_status: 'quarantined' },
          { source_entity_id: 'character_index_moved', remap_status: 'quarantined' },
          { source_entity_id: 'character_legacy', remap_status: 'quarantined' },
          { source_entity_id: 'correction_mismatch', remap_status: 'quarantined' },
        ]),
      );
      const quarantinedReaderState = await pool.query(
        `
          select artifact_type, source_entity_id, payload, source_anchor
          from book_revision_quarantine
          where artifact_type in ('reading_position', 'bookmark', 'highlight', 'note')
          order by artifact_type
        `,
      );
      expect(quarantinedReaderState.rows).toEqual([
        expect.objectContaining({
          artifact_type: 'bookmark',
          source_entity_id: 'bookmark_old',
          payload: expect.objectContaining({ paragraph_id: 'paragraph_old' }),
        }),
        expect.objectContaining({
          artifact_type: 'highlight',
          source_entity_id: 'highlight_old',
          payload: expect.objectContaining({ paragraph_id: 'paragraph_old' }),
        }),
        expect.objectContaining({
          artifact_type: 'note',
          source_entity_id: 'note_old',
          payload: expect.objectContaining({ paragraph_id: 'paragraph_old' }),
        }),
        expect.objectContaining({
          artifact_type: 'reading_position',
          source_entity_id: '["book_1", "user_test"]',
          payload: expect.objectContaining({ offset_in_paragraph: 7 }),
          source_anchor: expect.objectContaining({ paragraphId: 'paragraph_old' }),
        }),
      ]);
      const activeReaderState = await pool.query(`
        select
          (select count(*)::integer from reading_positions where book_id = 'book_1') as reading_positions,
          (select count(*)::integer from bookmarks where book_id = 'book_1' and deleted_at is null) as bookmarks,
          (select count(*)::integer from highlights where book_id = 'book_1' and deleted_at is null) as highlights,
          (select count(*)::integer from notes where book_id = 'book_1' and deleted_at is null) as notes
      `);
      expect(activeReaderState.rows[0]).toEqual({ reading_positions: 0, bookmarks: 0, highlights: 0, notes: 0 });
      const rebasedAt = new Date(Date.now() + 1_000).toISOString();
      const rebasedPosition = canonicalV2Event({
        id: 'event_rebased_after_replacement',
        type: 'reading_position_updated',
        deviceId: 'device_a',
        novelId: 'book_1',
        entityId: 'reading_position_book_1',
        payload: {
          position: {
            chapterId: 'chapter_new',
            paragraphId: 'paragraph_new',
            paragraphIndex: 0,
            offsetInParagraph: 4,
            chapterProgress: 0.5,
            scrollTop: 260,
            updatedAt: '2026-07-05T00:02:00.000Z',
            contentRevisionId: String(book.rows[0].active_content_revision_id),
          },
        },
        revision: {
          entityType: 'reading_position',
          entityId: 'reading_position_book_1',
          novelId: 'book_1',
          localSequence: 3,
          updatedAt: rebasedAt,
          payloadHash: 'fixture',
        },
        createdAt: rebasedAt,
      });
      const rebasedResponse = await app.inject({
        method: 'POST',
        url: '/api/sync/events',
        payload: v2PushEnvelope([rebasedPosition]),
      });
      expect(rebasedResponse.statusCode).toBe(200);
      expect(rebasedResponse.json()).toMatchObject({ accepted: 1, acceptedIds: [rebasedPosition.id] });
      expect(
        (
          await pool.query(
            `select chapter_id, paragraph_id, offset_in_paragraph from reading_positions where book_id = 'book_1'`,
          )
        ).rows[0],
      ).toEqual({ chapter_id: 'chapter_new', paragraph_id: 'paragraph_new', offset_in_paragraph: 4 });
      expect((await pool.query(`select count(*)::integer as count from tts_audio_cache`)).rows[0].count).toBe(0);
      await app.close();
    });
  }, 30_000);
});
