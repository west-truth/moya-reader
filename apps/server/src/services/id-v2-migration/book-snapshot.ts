import type pg from 'pg';
import { integrityHash } from '@noveldesk/text-core/hash';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { IdV2MigrationError } from './contracts.js';
import { record, textValue, type JsonRecord } from './safe-values.js';

interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>;
}

interface JsonRow extends pg.QueryResultRow {
  row_data: unknown;
}

export const BOOK_BACKUP_TABLE_ORDER = [
  'book_objects',
  'library_books',
  'chapters',
  'paragraph_pages',
  'paragraph_search',
  'reading_positions',
  'bookmarks',
  'highlights',
  'notes',
  'sync_events',
  'upload_sessions',
  'import_jobs',
  'characters',
  'character_aliases',
  'character_relations',
  'analysis_runs',
  'chapter_contexts',
  'voice_profiles',
  'labeled_segments',
  'user_corrections',
  'book_ai_workflows',
  'provider_jobs',
  'provider_job_attempts',
  'provider_job_outbox',
  'book_ai_workflow_jobs',
  'tts_audio_cache',
] as const;

export type BookBackupTable = (typeof BOOK_BACKUP_TABLE_ORDER)[number];
export type BookSnapshotRows = Record<BookBackupTable, JsonRecord[]>;

async function jsonRows(queryable: Queryable, sql: string, values: readonly unknown[]): Promise<JsonRecord[]> {
  const result = await queryable.query<JsonRow>(sql, values);
  return result.rows.map((row, index) => record(row.row_data, `snapshot row ${index}`));
}

async function runSerial<T extends readonly (() => Promise<JsonRecord[]>)[]>(
  operations: T,
): Promise<{ readonly [K in keyof T]: JsonRecord[] }> {
  const results: JsonRecord[][] = [];
  for (const operation of operations) results.push(await operation());
  return results as unknown as { readonly [K in keyof T]: JsonRecord[] };
}

export async function loadBookSnapshot(
  queryable: Queryable,
  userId: string,
  bookId: string,
  lockBook = false,
): Promise<BookSnapshotRows> {
  const bookRows = await jsonRows(
    queryable,
    `
      select to_jsonb(book) as row_data
      from library_books book
      where book.user_id = $1 and book.id = $2
      ${lockBook ? 'for update' : ''}
    `,
    [userId, bookId],
  );
  if (bookRows.length !== 1) {
    throw new IdV2MigrationError('book_not_found', 'The source book does not exist.');
  }
  const objectId = typeof bookRows[0].object_id === 'string' ? bookRows[0].object_id : undefined;

  const direct = (table: string) =>
    jsonRows(
      queryable,
      `select to_jsonb(row_data) as row_data from ${table} row_data where row_data.book_id = $1 order by row_data.id`,
      [bookId],
    );

  const [
    bookObjects,
    chapters,
    paragraphPages,
    paragraphSearch,
    readingPositions,
    bookmarks,
    highlights,
    notes,
    syncEvents,
    uploadSessions,
    importJobs,
    characters,
    characterAliases,
    characterRelations,
    analysisRuns,
    chapterContexts,
    voiceProfiles,
    labeledSegments,
    userCorrections,
    workflows,
    providerJobs,
    attempts,
    outbox,
    workflowJobs,
    ttsAudioCache,
  ] = await runSerial([
    () =>
      objectId
        ? jsonRows(
            queryable,
            'select to_jsonb(object_row) as row_data from book_objects object_row where object_row.id = $1',
            [objectId],
          )
        : Promise.resolve([]),
    () => direct('chapters'),
    () => direct('paragraph_pages'),
    () => direct('paragraph_search'),
    () =>
      jsonRows(
        queryable,
        'select to_jsonb(row_data) as row_data from reading_positions row_data where row_data.user_id = $1 and row_data.book_id = $2',
        [userId, bookId],
      ),
    () => direct('bookmarks'),
    () => direct('highlights'),
    () => direct('notes'),
    () =>
      jsonRows(
        queryable,
        'select to_jsonb(row_data) as row_data from sync_events row_data where row_data.user_id = $1 and row_data.book_id = $2 order by row_data.sequence',
        [userId, bookId],
      ),
    () =>
      jsonRows(
        queryable,
        `
        select to_jsonb(row_data) as row_data
        from upload_sessions row_data
        where row_data.user_id = $1
          and (
            row_data.client_book_id = $2
            or row_data.id in (select upload_id from import_jobs where user_id = $1 and book_id = $2)
          )
        order by row_data.id
      `,
        [userId, bookId],
      ),
    () =>
      jsonRows(
        queryable,
        'select to_jsonb(row_data) as row_data from import_jobs row_data where row_data.user_id = $1 and row_data.book_id = $2 order by row_data.id',
        [userId, bookId],
      ),
    () => direct('characters'),
    () => direct('character_aliases'),
    () => direct('character_relations'),
    () => direct('analysis_runs'),
    () => direct('chapter_contexts'),
    () => direct('voice_profiles'),
    () => direct('labeled_segments'),
    () => direct('user_corrections'),
    () => direct('book_ai_workflows'),
    () => direct('provider_jobs'),
    () =>
      jsonRows(
        queryable,
        `
        select to_jsonb(row_data) as row_data
        from provider_job_attempts row_data
        where row_data.provider_job_id in (select id from provider_jobs where book_id = $1)
        order by row_data.id
      `,
        [bookId],
      ),
    () =>
      jsonRows(
        queryable,
        `
        select to_jsonb(row_data) as row_data
        from provider_job_outbox row_data
        where row_data.provider_job_id in (select id from provider_jobs where book_id = $1)
        order by row_data.id
      `,
        [bookId],
      ),
    () =>
      jsonRows(
        queryable,
        `
        select to_jsonb(row_data) as row_data
        from book_ai_workflow_jobs row_data
        where row_data.workflow_id in (select id from book_ai_workflows where book_id = $1)
           or row_data.provider_job_id in (select id from provider_jobs where book_id = $1)
        order by row_data.id
      `,
        [bookId],
      ),
    () => direct('tts_audio_cache'),
  ] as const);

  return {
    book_objects: bookObjects,
    library_books: bookRows,
    chapters,
    paragraph_pages: paragraphPages,
    paragraph_search: paragraphSearch,
    reading_positions: readingPositions,
    bookmarks,
    highlights,
    notes,
    sync_events: syncEvents,
    upload_sessions: uploadSessions,
    import_jobs: importJobs,
    characters,
    character_aliases: characterAliases,
    character_relations: characterRelations,
    analysis_runs: analysisRuns,
    chapter_contexts: chapterContexts,
    voice_profiles: voiceProfiles,
    labeled_segments: labeledSegments,
    user_corrections: userCorrections,
    book_ai_workflows: workflows,
    provider_jobs: providerJobs,
    provider_job_attempts: attempts,
    provider_job_outbox: outbox,
    book_ai_workflow_jobs: workflowJobs,
    tts_audio_cache: ttsAudioCache,
  };
}

export function bookSnapshotFingerprint(rows: BookSnapshotRows): Record<string, unknown> {
  const book = rows.library_books[0];
  const object = rows.book_objects[0];
  const counts = Object.fromEntries(BOOK_BACKUP_TABLE_ORDER.map((table) => [table, rows[table].length]));
  const source = {
    bookId: textValue(book.id, 'book.id'),
    bookUpdatedAt: book.updated_at,
    objectId: object?.id,
    rawTextHash: object?.raw_text_hash,
    normalizedTextHash: book.normalized_text_hash,
    counts,
  };
  return { ...source, fingerprint: integrityHash(JSON.stringify(source)) };
}

export function bookSnapshotStateHash(rows: BookSnapshotRows): string {
  return structuredIntegrityHash(Object.fromEntries(BOOK_BACKUP_TABLE_ORDER.map((table) => [table, rows[table]])));
}

export async function activeBookWork(
  queryable: Queryable,
  userId: string,
  bookId: string,
): Promise<Record<string, number>> {
  const result = await queryable.query<{
    active_imports: string | number;
    active_provider_jobs: string | number;
    active_workflows: string | number;
  }>(
    `
      select
        (
          select count(*)
          from import_jobs job
          where job.user_id = $1
            and job.status in ('queued', 'processing')
            and (
              job.book_id = $2
              or job.upload_id in (
                select id from upload_sessions where user_id = $1 and client_book_id = $2
              )
            )
        ) as active_imports,
        (
          select count(*)
          from provider_jobs job
          where job.user_id = $1 and job.book_id = $2 and job.status in ('queued', 'running')
        ) as active_provider_jobs,
        (
          select count(*)
          from book_ai_workflows workflow
          where workflow.user_id = $1 and workflow.book_id = $2 and workflow.status = 'running'
        ) as active_workflows
    `,
    [userId, bookId],
  );
  const row = result.rows[0];
  return {
    imports: Number(row?.active_imports ?? 0),
    providerJobs: Number(row?.active_provider_jobs ?? 0),
    workflows: Number(row?.active_workflows ?? 0),
  };
}

export function hasActiveBookWork(counts: Record<string, number>): boolean {
  return Object.values(counts).some((count) => count > 0);
}
