import type pg from 'pg';
import { persistentId128 } from '@noveldesk/text-core/hash';
import type { CharacterGraph } from '../../../../../src/providers/ai';
import type { PreparedBookReplacement, ExistingBookRevision, BookReplacementSummary } from './contracts.js';

interface BookRevisionRow extends pg.QueryResultRow {
  id: string;
  user_id: string;
  normalized_text_hash: string;
  active_content_revision_id: string;
  content_revision_number: number | string;
  active_character_graph_revision_id: string | null;
  revision_fence: number | string;
}

export async function lockExistingBookRevision(
  client: pg.PoolClient,
  userId: string,
  bookId: string,
): Promise<ExistingBookRevision | undefined> {
  const result = await client.query<BookRevisionRow>(
    `
      select id, user_id, normalized_text_hash, active_content_revision_id,
             content_revision_number, active_character_graph_revision_id, revision_fence
      from library_books
      where id = $1 and user_id = $2
      for update
    `,
    [bookId, userId],
  );
  const row = result.rows[0];
  if (!row?.active_content_revision_id) return undefined;
  return {
    bookId: row.id,
    userId: row.user_id,
    contentRevisionId: row.active_content_revision_id,
    contentRevisionNumber: Number(row.content_revision_number),
    graphRevisionId: row.active_character_graph_revision_id ?? undefined,
    revisionFence: Number(row.revision_fence),
    normalizedTextHash: row.normalized_text_hash,
  };
}

export async function insertPreparingContentRevision(
  client: pg.PoolClient,
  input: PreparedBookReplacement & {
    readonly sourceObjectId: string;
    readonly sourceRawTextHash: string;
    readonly sourceFileName: string;
    readonly sourceEncoding?: string;
  },
): Promise<void> {
  await client.query(
    `
      insert into book_content_revisions (
        id, book_id, revision_number, source_object_id, source_raw_text_hash,
        normalized_text_hash, source_file_name, source_encoding, status, created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, 'preparing', now())
    `,
    [
      input.toContentRevisionId,
      input.bookId,
      input.toContentRevisionNumber,
      input.sourceObjectId,
      input.sourceRawTextHash,
      input.normalizedTextHash,
      input.sourceFileName,
      input.sourceEncoding ?? null,
    ],
  );
  await client.query(
    `
      insert into book_replacement_runs (
        id, book_id, user_id, from_content_revision_id, to_content_revision_id,
        expected_revision_fence, status, summary, created_at
      )
      values ($1, $2, $3, $4, $5, $6, 'preparing', '{}'::jsonb, now())
    `,
    [
      input.runId,
      input.bookId,
      input.userId,
      input.fromContentRevisionId,
      input.toContentRevisionId,
      input.expectedRevisionFence,
    ],
  );
}

async function quarantineTable(
  client: pg.PoolClient,
  replacement: PreparedBookReplacement,
  artifactType: string,
  table: string,
  bookColumn = 'book_id',
  sourceAnchorExpression = 'null',
  sourceAnchorHashExpression = 'null',
  sourceEntityExpression = 'row.id',
  whereExpression = 'true',
): Promise<number> {
  const result = await client.query(
    `
      insert into book_revision_quarantine (
        id, replacement_run_id, book_id, source_content_revision_id,
        artifact_type, source_entity_id, reason, payload,
        source_anchor, source_anchor_hash, remap_status, quarantined_at
      )
      select
        $1 || ':' || $3 || ':' || (${sourceEntityExpression}),
        $1,
        $2,
        $4,
        $3,
        ${sourceEntityExpression},
        'book_content_replaced',
        to_jsonb(row),
        ${sourceAnchorExpression},
        ${sourceAnchorHashExpression},
        'quarantined',
        now()
      from ${table} row
      where row.${bookColumn} = $2 and (${whereExpression})
      on conflict (replacement_run_id, artifact_type, source_entity_id) do nothing
    `,
    [replacement.runId, replacement.bookId, artifactType, replacement.fromContentRevisionId],
  );
  return result.rowCount ?? 0;
}

export async function quarantineBookDerivedState(
  client: pg.PoolClient,
  replacement: PreparedBookReplacement,
): Promise<number> {
  const counts: number[] = [];
  counts.push(
    await quarantineTable(
      client,
      replacement,
      'character',
      'characters',
      'book_id',
      'row.source_anchor',
      'row.source_anchor_hash',
    ),
  );
  counts.push(await quarantineTable(client, replacement, 'character_relation', 'character_relations'));
  counts.push(
    await quarantineTable(
      client,
      replacement,
      'voice_profile',
      'voice_profiles',
      'book_id',
      'row.source_anchor',
      'row.source_anchor_hash',
    ),
  );
  counts.push(
    await quarantineTable(
      client,
      replacement,
      'user_correction',
      'user_corrections',
      'book_id',
      'row.source_anchor',
      'row.source_anchor_hash',
    ),
  );
  counts.push(await quarantineTable(client, replacement, 'labeled_segment', 'labeled_segments'));
  counts.push(await quarantineTable(client, replacement, 'chapter_context', 'chapter_contexts'));
  counts.push(await quarantineTable(client, replacement, 'tts_audio_cache', 'tts_audio_cache'));
  counts.push(await quarantineTable(client, replacement, 'analysis_run', 'analysis_runs'));
  counts.push(await quarantineTable(client, replacement, 'character_graph_revision', 'character_graph_revisions'));
  counts.push(await quarantineTable(client, replacement, 'analysis_staging_artifact', 'analysis_staging_artifacts'));
  counts.push(await quarantineTable(client, replacement, 'episode_context', 'analysis_episode_contexts'));
  counts.push(
    await quarantineTable(
      client,
      replacement,
      'reading_position',
      'reading_positions',
      'book_id',
      `jsonb_build_object(
        'kind', 'reader_position',
        'chapterId', row.chapter_id,
        'paragraphId', row.paragraph_id,
        'paragraphIndex', row.paragraph_index,
        'offsetInParagraph', row.offset_in_paragraph
      )`,
      'null',
      `jsonb_build_array(row.book_id, row.user_id)::text`,
    ),
  );
  counts.push(
    await quarantineTable(
      client,
      replacement,
      'bookmark',
      'bookmarks',
      'book_id',
      `jsonb_build_object('kind', 'paragraph', 'chapterId', row.chapter_id, 'paragraphId', row.paragraph_id)`,
      'null',
      'row.id',
      'row.deleted_at is null',
    ),
  );
  counts.push(
    await quarantineTable(
      client,
      replacement,
      'highlight',
      'highlights',
      'book_id',
      `jsonb_build_object('kind', 'paragraph', 'chapterId', row.chapter_id, 'paragraphId', row.paragraph_id)`,
      'null',
      'row.id',
      'row.deleted_at is null',
    ),
  );
  counts.push(
    await quarantineTable(
      client,
      replacement,
      'note',
      'notes',
      'book_id',
      `jsonb_build_object('kind', 'paragraph', 'chapterId', row.chapter_id, 'paragraphId', row.paragraph_id)`,
      'null',
      'row.id',
      'row.deleted_at is null',
    ),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

export async function fenceBookWorkflowsAndJobs(
  client: pg.PoolClient,
  replacement: PreparedBookReplacement,
): Promise<{ cancelledWorkflowCount: number; cancelledProviderJobCount: number }> {
  const workflows = await client.query(
    `
      update book_ai_workflows
      set status = 'cancelled',
          stage = 'cancelled',
          progress = coalesce(progress, '{}'::jsonb) || jsonb_build_object(
            'cancelledByReplacementRunId', $2::text,
            'replacementContentRevisionId', $3::text,
            'cancelledAt', now()
          ),
          error_code = 'book_revision_replaced',
          error_message = 'Book content was replaced',
          finished_at = now(),
          updated_at = now()
      where book_id = $1 and status in ('queued', 'running', 'needs_review')
    `,
    [replacement.bookId, replacement.runId, replacement.toContentRevisionId],
  );
  const jobs = await client.query<{ id: string }>(
    `
      with candidates as materialized (
        select id, current_attempt_id
        from provider_jobs
        where book_id = $1 and status in ('queued', 'running')
        for update
      ),
      cancelled_jobs as (
        update provider_jobs job
        set status = 'cancelled',
            stage = 'stale',
            progress = coalesce(job.progress, '{}'::jsonb) || jsonb_build_object(
              'cancelledByReplacementRunId', $2::text,
              'replacementContentRevisionId', $3::text,
              'cancelledAt', now()
            ),
            error_code = 'book_revision_replaced',
            error_message = 'Book content was replaced',
            finished_at = now(),
            updated_at = now()
        from candidates
        where job.id = candidates.id
        returning job.id, candidates.current_attempt_id
      ),
      cancelled_attempts as (
        update provider_job_attempts attempt
        set status = 'cancelled',
            stage = 'stale',
            error_code = 'book_revision_replaced',
            error_message = 'Book content was replaced',
            finished_at = now(),
            updated_at = now()
        from cancelled_jobs job
        where attempt.id = job.current_attempt_id
          and attempt.provider_job_id = job.id
          and attempt.status in ('queued', 'running')
        returning attempt.id
      )
      select id from cancelled_jobs
    `,
    [replacement.bookId, replacement.runId, replacement.toContentRevisionId],
  );
  return {
    cancelledWorkflowCount: workflows.rowCount ?? 0,
    cancelledProviderJobCount: jobs.rows.length,
  };
}

export async function clearQuarantinedCanonicalState(
  client: pg.PoolClient,
  replacement: PreparedBookReplacement,
): Promise<void> {
  await client.query(
    `
      update library_books
      set active_character_graph_revision_id = null
      where id = $1 and active_character_graph_revision_id is not distinct from $2
    `,
    [replacement.bookId, replacement.fromGraphRevisionId ?? null],
  );
  await client.query(
    `update character_graph_revisions set status = 'quarantined' where book_id = $1 and status <> 'quarantined'`,
    [replacement.bookId],
  );
  await client.query(`update analysis_runs set status = 'stale', lifecycle_state = 'stale' where book_id = $1`, [
    replacement.bookId,
  ]);
  await client.query(
    `update analysis_staging_artifacts set status = 'quarantined', stale_reason = 'book_content_replaced' where book_id = $1`,
    [replacement.bookId],
  );
  await client.query(
    `update analysis_episode_contexts set status = 'quarantined', updated_at = now() where book_id = $1`,
    [replacement.bookId],
  );
  await client.query('delete from tts_audio_cache where book_id = $1', [replacement.bookId]);
  await client.query('delete from chapter_contexts where book_id = $1', [replacement.bookId]);
  await client.query('delete from labeled_segments where book_id = $1', [replacement.bookId]);
  await client.query('delete from user_corrections where book_id = $1', [replacement.bookId]);
  await client.query('delete from voice_profiles where book_id = $1', [replacement.bookId]);
  await client.query('delete from character_relations where book_id = $1', [replacement.bookId]);
  await client.query('delete from character_aliases where book_id = $1', [replacement.bookId]);
  await client.query('delete from characters where book_id = $1', [replacement.bookId]);
  await client.query('delete from reading_positions where book_id = $1', [replacement.bookId]);
  await client.query('delete from bookmarks where book_id = $1 and deleted_at is null', [replacement.bookId]);
  await client.query('delete from highlights where book_id = $1 and deleted_at is null', [replacement.bookId]);
  await client.query('delete from notes where book_id = $1 and deleted_at is null', [replacement.bookId]);
}

export async function restoreExactAnchoredReaderState(
  client: pg.PoolClient,
  replacement: PreparedBookReplacement,
): Promise<number> {
  const readingPositions = await client.query(
    `
      insert into reading_positions (
        book_id, user_id, chapter_id, paragraph_id, paragraph_index, offset_in_paragraph,
        chapter_progress, scroll_top, device_id, updated_at
      )
      select state.book_id, state.user_id, state.chapter_id, state.paragraph_id, state.paragraph_index,
             state.offset_in_paragraph, state.chapter_progress, state.scroll_top, state.device_id, state.updated_at
        from book_revision_quarantine quarantine
        cross join lateral jsonb_populate_record(null::reading_positions, quarantine.payload) state
        join chapters chapter on chapter.id = state.chapter_id and chapter.book_id = state.book_id
       where quarantine.replacement_run_id = $1 and quarantine.book_id = $2
         and quarantine.artifact_type = 'reading_position'
         and (
           state.paragraph_id is null or exists (
             select 1 from paragraph_search paragraph
              where paragraph.book_id = state.book_id
                and paragraph.chapter_id = state.chapter_id
                and paragraph.paragraph_id = state.paragraph_id
           )
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
    `,
    [replacement.runId, replacement.bookId],
  );
  const bookmarks = await client.query(
    `
      insert into bookmarks (
        id, book_id, user_id, chapter_id, paragraph_id, label, progress, scroll_top,
        created_at, updated_at, deleted_at
      )
      select state.id, state.book_id, state.user_id, state.chapter_id, state.paragraph_id, state.label,
             state.progress, state.scroll_top, state.created_at, state.updated_at, state.deleted_at
        from book_revision_quarantine quarantine
        cross join lateral jsonb_populate_record(null::bookmarks, quarantine.payload) state
        join chapters chapter on chapter.id = state.chapter_id and chapter.book_id = state.book_id
       where quarantine.replacement_run_id = $1 and quarantine.book_id = $2
         and quarantine.artifact_type = 'bookmark'
         and (
           state.paragraph_id is null or exists (
             select 1 from paragraph_search paragraph
              where paragraph.book_id = state.book_id
                and paragraph.chapter_id = state.chapter_id
                and paragraph.paragraph_id = state.paragraph_id
           )
         )
      on conflict (id) do update
        set chapter_id = excluded.chapter_id,
            paragraph_id = excluded.paragraph_id,
            label = excluded.label,
            progress = excluded.progress,
            scroll_top = excluded.scroll_top,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at
    `,
    [replacement.runId, replacement.bookId],
  );
  const highlights = await client.query(
    `
      insert into highlights (
        id, book_id, user_id, chapter_id, paragraph_id, quote, color, progress,
        created_at, updated_at, deleted_at
      )
      select state.id, state.book_id, state.user_id, state.chapter_id, state.paragraph_id, state.quote,
             state.color, state.progress, state.created_at, state.updated_at, state.deleted_at
        from book_revision_quarantine quarantine
        cross join lateral jsonb_populate_record(null::highlights, quarantine.payload) state
        join chapters chapter on chapter.id = state.chapter_id and chapter.book_id = state.book_id
       where quarantine.replacement_run_id = $1 and quarantine.book_id = $2
         and quarantine.artifact_type = 'highlight'
         and exists (
           select 1 from paragraph_search paragraph
            where paragraph.book_id = state.book_id
              and paragraph.chapter_id = state.chapter_id
              and paragraph.paragraph_id = state.paragraph_id
         )
      on conflict (id) do update
        set chapter_id = excluded.chapter_id,
            paragraph_id = excluded.paragraph_id,
            quote = excluded.quote,
            color = excluded.color,
            progress = excluded.progress,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at
    `,
    [replacement.runId, replacement.bookId],
  );
  const notes = await client.query(
    `
      insert into notes (
        id, book_id, user_id, chapter_id, paragraph_id, quote, body, progress,
        created_at, updated_at, deleted_at
      )
      select state.id, state.book_id, state.user_id, state.chapter_id, state.paragraph_id, state.quote,
             state.body, state.progress, state.created_at, state.updated_at, state.deleted_at
        from book_revision_quarantine quarantine
        cross join lateral jsonb_populate_record(null::notes, quarantine.payload) state
        join chapters chapter on chapter.id = state.chapter_id and chapter.book_id = state.book_id
       where quarantine.replacement_run_id = $1 and quarantine.book_id = $2
         and quarantine.artifact_type = 'note'
         and (
           state.paragraph_id is null or exists (
             select 1 from paragraph_search paragraph
              where paragraph.book_id = state.book_id
                and paragraph.chapter_id = state.chapter_id
                and paragraph.paragraph_id = state.paragraph_id
           )
         )
      on conflict (id) do update
        set chapter_id = excluded.chapter_id,
            paragraph_id = excluded.paragraph_id,
            quote = excluded.quote,
            body = excluded.body,
            progress = excluded.progress,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at
    `,
    [replacement.runId, replacement.bookId],
  );
  await client.query(
    `
      update book_revision_quarantine quarantine
         set remap_status = 'remapped',
             remapped_entity_id = case
               when quarantine.artifact_type = 'reading_position' then quarantine.source_entity_id
               else quarantine.payload ->> 'id'
             end,
             remapped_at = now()
       where quarantine.replacement_run_id = $1 and quarantine.book_id = $2
         and quarantine.artifact_type in ('reading_position', 'bookmark', 'highlight', 'note')
         and exists (
           select 1 from chapters chapter
            where chapter.id = quarantine.payload ->> 'chapter_id'
              and chapter.book_id = quarantine.book_id
         )
         and (
           quarantine.payload ->> 'paragraph_id' is null or exists (
             select 1 from paragraph_search paragraph
              where paragraph.book_id = quarantine.book_id
                and paragraph.chapter_id = quarantine.payload ->> 'chapter_id'
                and paragraph.paragraph_id = quarantine.payload ->> 'paragraph_id'
           )
         )
    `,
    [replacement.runId, replacement.bookId],
  );
  return (
    (readingPositions.rowCount ?? 0) + (bookmarks.rowCount ?? 0) + (highlights.rowCount ?? 0) + (notes.rowCount ?? 0)
  );
}

export async function finalizeReplacementRun(
  client: pg.PoolClient,
  replacement: PreparedBookReplacement,
  graphRevisionId: string,
  summary: BookReplacementSummary,
): Promise<void> {
  const superseded = await client.query(
    `
      update book_content_revisions
      set status = 'superseded', superseded_at = now()
      where id = $1 and book_id = $2 and status = 'active'
    `,
    [replacement.fromContentRevisionId, replacement.bookId],
  );
  if (superseded.rowCount !== undefined && superseded.rowCount !== 1) {
    throw new Error('book_replacement_source_revision_cas_failed');
  }
  const activatedRevision = await client.query(
    `
      update book_content_revisions
      set status = 'active', activated_at = now()
      where id = $1 and book_id = $2 and status = 'preparing'
    `,
    [replacement.toContentRevisionId, replacement.bookId],
  );
  if (activatedRevision.rowCount !== undefined && activatedRevision.rowCount !== 1) {
    throw new Error('book_replacement_target_revision_cas_failed');
  }
  const activatedBook = await client.query<{ id: string }>(
    `
      update library_books
      set active_content_revision_id = $4,
          content_revision_number = $5,
          active_character_graph_revision_id = $6,
          revision_fence = revision_fence + 1,
          analysis_status = 'not_analyzed',
          updated_at = now()
      where id = $1
        and user_id = $2
        and active_content_revision_id = $3
        and revision_fence = $7
        and active_character_graph_revision_id is null
      returning id
    `,
    [
      replacement.bookId,
      replacement.userId,
      replacement.fromContentRevisionId,
      replacement.toContentRevisionId,
      replacement.toContentRevisionNumber,
      graphRevisionId,
      replacement.expectedRevisionFence,
    ],
  );
  if (!activatedBook.rows[0]) throw new Error('book_replacement_activation_cas_failed');
  await client.query(
    `
      update book_replacement_runs
      set status = 'finalized', summary = $2, finalized_at = now()
      where id = $1 and status = 'preparing'
    `,
    [replacement.runId, JSON.stringify(summary)],
  );
}

export async function insertReplacementGraphRevision(
  client: pg.PoolClient,
  replacement: PreparedBookReplacement,
  graph: CharacterGraph,
  fingerprint: string,
): Promise<string> {
  const numberResult = await client.query<{ revision_number: number | string }>(
    `select coalesce(max(revision_number), 0) + 1 as revision_number from character_graph_revisions where book_id = $1`,
    [replacement.bookId],
  );
  const revisionNumber = Number(numberResult.rows[0]?.revision_number ?? 1);
  const id = persistentId128('character_graph_revision', [
    replacement.bookId,
    replacement.toContentRevisionId,
    String(revisionNumber),
    fingerprint,
    replacement.runId,
  ]);
  await client.query(
    `
      insert into character_graph_revisions (
        id, book_id, content_revision_id, revision_number, graph_fingerprint,
        snapshot, status, created_at, promoted_at
      )
      values ($1, $2, $3, $4, $5, $6, 'active', now(), now())
    `,
    [id, replacement.bookId, replacement.toContentRevisionId, revisionNumber, fingerprint, JSON.stringify(graph)],
  );
  return id;
}
