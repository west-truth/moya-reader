import pg from 'pg';
import {
  DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID,
  DEFAULT_BOOK_AI_WORKFLOW_VERSION,
} from '../../../../../src/providers/book-ai-workflow-definition';
import {
  characterGraphIntegrityHash,
  correctionCollectionIntegrityHash,
  segmentCollectionIntegrityHash,
} from '@noveldesk/text-core/identity/ai';
import type { ServerConfig } from '../../config.js';
import {
  planBookAIWorkflow,
  type BookAIWorkflowPlan,
  type BookAIWorkflowPlanOptions,
} from '../../../../../src/providers/book-ai-workflow-plan';
import type { LabelingContextCapabilitySnapshot } from '../../../../../src/providers/labeling-context-packet';
import { isoString, jsonString, mapJsonStringArray } from './database-row-contract.js';
import { providerJobFromJson, sanitizeProviderJobProgress, type ProviderJobResponse } from './provider-job-contract.js';

export interface ChapterAnalysisSeedRow {
  id: string;
  text_hash: string;
  updated_at: Date | string;
  paragraph_count: number;
  character_count: number;
}

export interface ChapterSegmentFingerprintRow {
  id: string;
  paragraph_id: string;
  segment_index: number | string;
  start_offset: number | string;
  end_offset: number | string;
  segment_text_hash: string;
  segment_type: string;
  speaker_id: string;
  is_user_corrected: boolean;
  updated_at: Date | string;
}

export interface BookAnalysisSeedRow {
  normalized_text_hash: string;
  total_chapters: number;
  total_characters: number;
  total_paragraphs: number;
  updated_at: Date | string;
}

export interface BookAIWorkflowPlanChapterRow {
  id: string;
  chapter_index: number | string;
  title: string;
  text_hash: string;
  character_count: number | string;
  paragraph_count: number | string;
}

export interface BookAIWorkflowPlanParagraphRow {
  paragraph_id: string;
  chapter_id: string;
  paragraph_index: number | string;
  text_length: number | string;
  text_hash: string | null;
}

export interface BookAIWorkflowRow {
  id: string;
  book_id: string;
  workflow_type: string;
  workflow_definition_id?: string;
  workflow_version?: string;
  provider_id: string;
  model_id: string | null;
  plan_hash: string;
  plan: unknown;
  status: string;
  stage: string;
  progress: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

export interface BookAIWorkflowJobLinkRow {
  id: string;
  workflow_id: string;
  provider_job_id: string;
  stage: string;
  plan_item_id: string;
  sequence: number | string;
  provider_job: unknown;
  created_at: Date | string;
}

export interface BookAIWorkflowResponse {
  id: string;
  novelId: string;
  workflowType: string;
  workflowDefinitionId: string;
  workflowVersion: string;
  providerId: string;
  modelId?: string;
  planHash: string;
  plan: BookAIWorkflowPlan;
  status: string;
  stage: string;
  progress: unknown;
  jobs: Array<{
    id: string;
    workflowId: string;
    providerJobId: string;
    stage: string;
    planItemId: string;
    sequence: number;
    job?: ProviderJobResponse;
    createdAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface BookGraphFingerprintCharacterRow {
  id: string;
  canonical_name: string;
  aliases: unknown;
  color: string;
  description: string | null;
  confidence: number | string;
  is_user_confirmed: boolean;
}

export interface BookGraphFingerprintRelationRow {
  id: string;
  source_character_id: string;
  target_character_id: string;
  relation_label: string;
  terms_used_by_source: unknown;
  terms_used_by_target: unknown;
  confidence: number | string;
  evidence: unknown;
}

export interface BookCorrectionFingerprintRow {
  id: string;
  book_id: string;
  chapter_id: string | null;
  paragraph_id: string | null;
  segment_id: string | null;
  correction_type: string;
  before_json: unknown;
  after_json: unknown;
  apply_scope: string;
  created_at: Date | string;
}

export function mapBookAIWorkflow(
  row: BookAIWorkflowRow,
  jobs: BookAIWorkflowJobLinkRow[] = [],
): BookAIWorkflowResponse {
  return {
    id: row.id,
    novelId: row.book_id,
    workflowType: row.workflow_type,
    workflowDefinitionId: row.workflow_definition_id ?? DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID,
    workflowVersion: row.workflow_version ?? DEFAULT_BOOK_AI_WORKFLOW_VERSION,
    providerId: row.provider_id,
    modelId: row.model_id ?? undefined,
    planHash: row.plan_hash,
    plan: row.plan as BookAIWorkflowPlan,
    status: row.status,
    stage: row.stage,
    progress: sanitizeProviderJobProgress(row.progress ?? {}),
    jobs: jobs.map((job) => ({
      id: job.id,
      workflowId: job.workflow_id,
      providerJobId: job.provider_job_id,
      stage: job.stage,
      planItemId: job.plan_item_id,
      sequence: Number(job.sequence),
      job: providerJobFromJson(job.provider_job),
      createdAt: isoString(job.created_at) ?? new Date(0).toISOString(),
    })),
    createdAt: isoString(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoString(row.updated_at) ?? new Date(0).toISOString(),
    startedAt: isoString(row.started_at),
    finishedAt: isoString(row.finished_at),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
  };
}

export async function bookExists(pool: pg.Pool, config: ServerConfig, bookId: string): Promise<boolean> {
  const result = await pool.query('select id from library_books where id = $1 and user_id = $2', [
    bookId,
    config.defaultUserId,
  ]);
  return Boolean(result.rows[0]);
}

export async function buildHostedBookAIWorkflowPlan(
  pool: pg.Pool,
  config: ServerConfig,
  bookId: string,
  options: BookAIWorkflowPlanOptions,
  labelingCapability?: LabelingContextCapabilitySnapshot,
): Promise<BookAIWorkflowPlan | undefined> {
  const chaptersResult = await pool.query<BookAIWorkflowPlanChapterRow>(
    `
      select c.id, c.chapter_index, c.title, c.text_hash, c.character_count, c.paragraph_count
      from chapters c
      join library_books b on b.id = c.book_id
      where c.book_id = $1 and b.user_id = $2
      order by c.chapter_index asc
    `,
    [bookId, config.defaultUserId],
  );
  if (chaptersResult.rows.length === 0 && !(await bookExists(pool, config, bookId))) return undefined;

  const paragraphsResult = await pool.query<BookAIWorkflowPlanParagraphRow>(
    `
      select ps.paragraph_id,
             ps.chapter_id,
             ps.paragraph_index,
             length(ps.text) as text_length,
             coalesce(ps.paragraph->>'textHash', ps.paragraph->>'text_hash', '') as text_hash
      from paragraph_search ps
      join chapters c on c.id = ps.chapter_id
      join library_books b on b.id = ps.book_id
      where ps.book_id = $1 and b.user_id = $2
      order by c.chapter_index asc, ps.paragraph_index asc
    `,
    [bookId, config.defaultUserId],
  );

  return planBookAIWorkflow({
    novelId: bookId,
    chapters: chaptersResult.rows.map((row) => ({
      id: row.id,
      index: Number(row.chapter_index),
      title: row.title,
      textHash: row.text_hash,
      characterCount: Number(row.character_count),
      paragraphCount: Number(row.paragraph_count),
    })),
    paragraphs: paragraphsResult.rows.map((row) => {
      const length = Number(row.text_length);
      return {
        id: row.paragraph_id,
        chapterId: row.chapter_id,
        index: Number(row.paragraph_index),
        textHash: row.text_hash || `${row.paragraph_id}:${Number.isFinite(length) ? length : 0}`,
        length: Number.isFinite(length) ? length : 0,
      };
    }),
    options,
    labelingCapability,
  });
}

export async function chapterBookId(
  pool: Pick<pg.Pool, 'query'>,
  config: ServerConfig,
  chapterId: string,
): Promise<string | undefined> {
  const result = await pool.query<{ book_id: string }>(
    `
      select c.book_id
      from chapters c
      join library_books b on b.id = c.book_id
      where c.id = $1 and b.user_id = $2
    `,
    [chapterId, config.defaultUserId],
  );
  return result.rows[0]?.book_id;
}

export async function chapterAnalysisSeed(
  pool: pg.Pool,
  config: ServerConfig,
  bookId: string,
  chapterId: string,
): Promise<ChapterAnalysisSeedRow | undefined> {
  const result = await pool.query<ChapterAnalysisSeedRow>(
    `
      select c.id, c.text_hash, c.updated_at, c.paragraph_count, c.character_count
      from chapters c
      join library_books b on b.id = c.book_id
      where c.id = $1 and c.book_id = $2 and b.user_id = $3
    `,
    [chapterId, bookId, config.defaultUserId],
  );
  return result.rows[0];
}

export async function chapterAnalysisSeeds(
  pool: pg.Pool,
  config: ServerConfig,
  bookId: string,
  chapterIds: string[],
): Promise<ChapterAnalysisSeedRow[]> {
  if (!chapterIds.length) return [];
  const result = await pool.query<ChapterAnalysisSeedRow>(
    `
      select c.id, c.text_hash, c.updated_at, c.paragraph_count, c.character_count
      from chapters c
      join library_books b on b.id = c.book_id
      where c.book_id = $1 and b.user_id = $2 and c.id = any($3::text[])
      order by c.chapter_index asc
    `,
    [bookId, config.defaultUserId, chapterIds],
  );
  return result.rows;
}

export async function chapterSegmentFingerprint(
  pool: pg.Pool,
  bookId: string,
  chapterId: string,
): Promise<{ segmentCount: number; segmentHash: string }> {
  const result = await pool.query<ChapterSegmentFingerprintRow>(
    `
      select id, paragraph_id, segment_index, start_offset, end_offset, segment_text_hash,
             segment_type, speaker_id, is_user_corrected, updated_at
      from labeled_segments
      where book_id = $1 and chapter_id = $2
      order by segment_index asc, id asc
    `,
    [bookId, chapterId],
  );
  const fingerprint = result.rows.map((row) => ({
    id: row.id,
    paragraphId: row.paragraph_id,
    segmentIndex: Number(row.segment_index),
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    segmentTextHash: row.segment_text_hash,
    type: row.segment_type,
    speakerId: row.speaker_id,
    isUserCorrected: Boolean(row.is_user_corrected),
    updatedAt: isoString(row.updated_at),
  }));
  return {
    segmentCount: fingerprint.length,
    segmentHash: segmentCollectionIntegrityHash(fingerprint),
  };
}

export async function bookAnalysisSeed(
  pool: pg.Pool,
  config: ServerConfig,
  bookId: string,
): Promise<BookAnalysisSeedRow | undefined> {
  const result = await pool.query<BookAnalysisSeedRow>(
    `
      select normalized_text_hash, total_chapters, total_characters, total_paragraphs, updated_at
      from library_books
      where id = $1 and user_id = $2
    `,
    [bookId, config.defaultUserId],
  );
  return result.rows[0];
}

export async function bookGraphFingerprint(
  pool: pg.Pool,
  bookId: string,
): Promise<{ characterCount: number; relationCount: number; graphHash: string }> {
  const [characters, relations] = await Promise.all([
    pool.query<BookGraphFingerprintCharacterRow>(
      `
        select id, canonical_name, aliases, color, description, confidence, is_user_confirmed
        from characters
        where book_id = $1
        order by id asc
      `,
      [bookId],
    ),
    pool.query<BookGraphFingerprintRelationRow>(
      `
        select id, source_character_id, target_character_id, relation_label,
               terms_used_by_source, terms_used_by_target, confidence, evidence
        from character_relations
        where book_id = $1
        order by id asc
      `,
      [bookId],
    ),
  ]);
  const fingerprint = {
    characters: characters.rows.map((row) => ({
      id: row.id,
      canonicalName: row.canonical_name,
      aliases: mapJsonStringArray(row.aliases),
      color: row.color,
      description: row.description,
      confidence: Number(row.confidence),
      isUserConfirmed: Boolean(row.is_user_confirmed),
    })),
    relations: relations.rows.map((row) => ({
      id: row.id,
      sourceCharacterId: row.source_character_id,
      targetCharacterId: row.target_character_id,
      relationLabel: row.relation_label,
      termsUsedBySource: mapJsonStringArray(row.terms_used_by_source),
      termsUsedByTarget: mapJsonStringArray(row.terms_used_by_target),
      confidence: Number(row.confidence),
      evidence: mapJsonStringArray(row.evidence),
    })),
  };
  return {
    characterCount: characters.rows.length,
    relationCount: relations.rows.length,
    graphHash: characterGraphIntegrityHash(fingerprint),
  };
}

export async function bookCorrectionFingerprint(
  pool: pg.Pool,
  bookId: string,
): Promise<{ correctionCount: number; correctionHash: string }> {
  const result = await pool.query<BookCorrectionFingerprintRow>(
    `
      select id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
             before_json, after_json, apply_scope, created_at
      from user_corrections
      where book_id = $1
        and (
          chapter_id is null
          or apply_scope in ('future_pattern', 'global')
        )
      order by created_at desc
      limit 30
    `,
    [bookId],
  );
  const fingerprint = result.rows.map((row) => ({
    id: row.id,
    bookId: row.book_id,
    chapterId: row.chapter_id,
    paragraphId: row.paragraph_id,
    segmentId: row.segment_id,
    correctionType: row.correction_type,
    beforeJson: jsonString(row.before_json),
    afterJson: jsonString(row.after_json) ?? '{}',
    applyScope: row.apply_scope,
    createdAt: isoString(row.created_at),
  }));
  return {
    correctionCount: result.rows.length,
    correctionHash: correctionCollectionIntegrityHash(fingerprint),
  };
}

export async function loadBookAIWorkflow(
  pool: pg.Pool,
  config: ServerConfig,
  workflowId: string,
): Promise<{ row: BookAIWorkflowRow; jobs: BookAIWorkflowJobLinkRow[] } | undefined> {
  const workflow = await pool.query<BookAIWorkflowRow>(
    `
      select id, book_id, workflow_type, workflow_definition_id, workflow_version,
             provider_id, model_id, plan_hash, plan, status, stage,
             progress, error_code, error_message, created_at, updated_at, started_at, finished_at
      from book_ai_workflows
      where id = $1 and user_id = $2
    `,
    [workflowId, config.defaultUserId],
  );
  const row = workflow.rows[0];
  if (!row) return undefined;
  const jobs = await pool.query<BookAIWorkflowJobLinkRow>(
    `
      select wj.id,
             wj.workflow_id,
             wj.provider_job_id,
             wj.stage,
             wj.plan_item_id,
             wj.sequence,
             jsonb_build_object(
               'id', pj.id,
               'book_id', pj.book_id,
               'chapter_id', pj.chapter_id,
               'job_type', pj.job_type,
               'provider_id', pj.provider_id,
               'model_id', pj.model_id,
               'input_hash', pj.input_hash,
               'status', pj.status,
               'stage', pj.stage,
               'progress', pj.progress,
               'error_code', pj.error_code,
               'error_message', pj.error_message,
               'created_at', pj.created_at,
               'updated_at', pj.updated_at,
               'started_at', pj.started_at,
               'finished_at', pj.finished_at,
               'current_attempt_id', pj.current_attempt_id,
               'attempt_generation', attempt.attempt_generation,
               'outcome_state', attempt.outcome_state,
               'billing_state', attempt.billing_state,
               'heartbeat_at', attempt.heartbeat_at,
               'dispatch_started_at', attempt.dispatch_started_at,
               'reconcile_after', attempt.reconcile_after,
               'normalized_completion_code', attempt.normalized_completion_code,
               'normalized_error_code', attempt.normalized_error_code
             ) as provider_job,
             wj.created_at
      from book_ai_workflow_jobs wj
      join provider_jobs pj on pj.id = wj.provider_job_id
      left join provider_job_attempts attempt on attempt.id = pj.current_attempt_id
      where wj.workflow_id = $1
      order by wj.stage asc, wj.sequence asc
    `,
    [workflowId],
  );
  return { row, jobs: jobs.rows };
}
