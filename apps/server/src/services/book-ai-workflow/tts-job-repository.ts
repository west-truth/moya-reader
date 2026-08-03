import type pg from 'pg';
import type { ProviderJobStatus } from '../provider-jobs/contracts.js';
import type { RevisionQueryable } from './analysis-input-repository.js';

export interface TTSProviderJobRow extends pg.QueryResultRow {
  id: string;
  book_id: string;
  chapter_id: string | null;
  job_type: string;
  provider_id: string;
  model_id: string | null;
  input_hash: string;
  status: ProviderJobStatus;
  stage: string;
  progress: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  current_attempt_id?: string | null;
}

const ttsJobColumns = `
  id, book_id, chapter_id, job_type, provider_id, model_id, input_hash, status,
  stage, progress, error_code, error_message, created_at, updated_at, started_at,
  finished_at, current_attempt_id
`;

export async function loadTTSProviderJob(
  db: RevisionQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly chapterId: string;
    readonly providerId: string;
    readonly modelId?: string;
    readonly inputHash: string;
  },
): Promise<TTSProviderJobRow | undefined> {
  const result = await db.query<TTSProviderJobRow>(
    `
      select ${ttsJobColumns}
      from provider_jobs
      where book_id = $1
        and chapter_id = $2
        and job_type = 'tts_synthesis'
        and provider_id = $3
        and model_id is not distinct from $4
        and input_hash = $5
        and user_id = $6
    `,
    [input.bookId, input.chapterId, input.providerId, input.modelId ?? null, input.inputHash, input.userId],
  );
  return result.rows[0];
}

export async function insertTTSProviderJob(
  db: RevisionQueryable,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly bookId: string;
    readonly chapterId: string;
    readonly providerId: string;
    readonly modelId?: string;
    readonly inputHash: string;
    readonly progress: Readonly<Record<string, unknown>>;
  },
): Promise<TTSProviderJobRow | undefined> {
  const result = await db.query<TTSProviderJobRow>(
    `
      insert into provider_jobs (
        id, user_id, book_id, chapter_id, job_type, provider_id, model_id, input_hash,
        status, stage, progress, created_at, updated_at
      )
      values ($1, $2, $3, $4, 'tts_synthesis', $5, $6, $7, 'queued', 'queued', $8, now(), now())
      on conflict (id) do nothing
      returning ${ttsJobColumns}
    `,
    [
      input.id,
      input.userId,
      input.bookId,
      input.chapterId,
      input.providerId,
      input.modelId ?? null,
      input.inputHash,
      JSON.stringify(input.progress),
    ],
  );
  return result.rows[0];
}

export async function requeueTTSProviderJob(
  db: RevisionQueryable,
  row: TTSProviderJobRow,
  userId: string,
  progress: Readonly<Record<string, unknown>>,
): Promise<TTSProviderJobRow | undefined> {
  const result = await db.query<TTSProviderJobRow>(
    `
      update provider_jobs
      set status = 'queued',
          stage = 'queued',
          progress = $3,
          error_code = null,
          error_message = null,
          started_at = null,
          finished_at = null,
          updated_at = now()
      where id = $1
        and user_id = $2
        and status = $4
        and current_attempt_id is not distinct from $5
      returning ${ttsJobColumns}
    `,
    [row.id, userId, JSON.stringify(progress), row.status, row.current_attempt_id ?? null],
  );
  return result.rows[0];
}
