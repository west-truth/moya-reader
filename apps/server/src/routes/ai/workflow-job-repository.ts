import { type BookAIWorkflowBundleWindow } from '../../../../../src/providers/book-ai-workflow-plan';
import { resolveCharacterBundleAnalysisRequestProfile } from '../../../../../src/providers/character-bundle-request-profile';
import {
  providerJobId,
  providerOptionsIntegrityHash,
  providerRequestIntegrityHash,
  providerSourceContextIntegrityHash,
} from '@noveldesk/text-core/identity/provider';
import type { QueryRunner } from './sync-event-repository.js';
import { isoString } from './database-row-contract.js';
import type { ProviderJobRow } from './provider-job-contract.js';
import type { BookAnalysisSeedRow, ChapterAnalysisSeedRow } from './workflow-query-service.js';

export async function insertGraphBootstrapProviderJob(
  db: QueryRunner,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly workflowId: string;
    readonly window: BookAIWorkflowBundleWindow;
    readonly bundleSeeds: ChapterAnalysisSeedRow[];
    readonly providerId: string;
    readonly modelId: string;
    readonly resolvedProviderOptions: Record<string, unknown>;
    readonly requestProfile: ReturnType<typeof resolveCharacterBundleAnalysisRequestProfile>;
    readonly bookSeed: BookAnalysisSeedRow;
    readonly graphFingerprint: { characterCount: number; relationCount: number; graphHash: string };
    readonly correctionFingerprint: { correctionCount: number; correctionHash: string };
    readonly force: boolean;
  },
): Promise<ProviderJobRow> {
  const providerOptionsHash = providerOptionsIntegrityHash(input.resolvedProviderOptions);
  const sourceContext = {
    workflowId: input.workflowId,
    workflowStage: 'character_graph_bootstrap',
    bundleId: input.window.bundleId,
    planWindowId: input.window.id,
    sequence: input.window.sequence,
    chapterIds: input.bundleSeeds.map((item) => item.id),
    previousBundleId: input.window.previousBundleId,
  };
  const sourceContextHash = providerSourceContextIntegrityHash(sourceContext);
  const bundleCharacterCount = input.bundleSeeds.reduce((sum, item) => sum + Number(item.character_count), 0);
  const inputHash = providerRequestIntegrityHash({
    bookId: input.bookId,
    chapterId: undefined,
    jobType: 'character_bundle_analysis',
    providerId: input.providerId,
    modelId: input.modelId,
    requestProfileId: input.requestProfile.id,
    promptVersion: input.requestProfile.promptVersion,
    schemaVersion: input.requestProfile.schemaVersion,
    bundleChapters: input.bundleSeeds.map((item) => ({
      chapterId: item.id,
      textHash: item.text_hash,
      updatedAt: isoString(item.updated_at),
      paragraphCount: Number(item.paragraph_count),
      characterCount: Number(item.character_count),
    })),
    bundleCharacterCount,
    normalizedTextHash: input.bookSeed.normalized_text_hash,
    totalChapters: Number(input.bookSeed.total_chapters),
    totalCharacters: Number(input.bookSeed.total_characters),
    totalParagraphs: Number(input.bookSeed.total_paragraphs),
    graphHash: input.graphFingerprint.graphHash,
    graphCharacterCount: input.graphFingerprint.characterCount,
    graphRelationCount: input.graphFingerprint.relationCount,
    sourceContextHash,
    correctionHash: input.correctionFingerprint.correctionHash,
    correctionCount: input.correctionFingerprint.correctionCount,
    providerOptionsHash,
  });
  const jobId = providerJobId({
    userId: input.userId,
    novelId: input.bookId,
    jobType: 'character_bundle_analysis',
    providerId: input.providerId,
    modelId: input.modelId,
    inputHash,
  });
  const budgetEstimate = {
    providerId: input.providerId,
    modelId: input.modelId,
    inputCharacters: bundleCharacterCount,
    cacheHit: false,
    providerOptionsHash,
    requestProfileId: input.requestProfile.id,
    bundleId: input.window.bundleId,
    workflowId: input.workflowId,
    planWindowId: input.window.id,
    chapterCount: input.bundleSeeds.length,
    paragraphCount: input.bundleSeeds.reduce((sum, item) => sum + Number(item.paragraph_count), 0),
    graphCharacterCount: input.graphFingerprint.characterCount,
    graphRelationCount: input.graphFingerprint.relationCount,
    correctionCount: input.correctionFingerprint.correctionCount,
  };
  const existing = await db.query<ProviderJobRow>(
    `
      select id, book_id, chapter_id, job_type, provider_id, model_id, input_hash, status,
             stage, progress, error_code, error_message, created_at, updated_at, started_at, finished_at,
             current_attempt_id
      from provider_jobs
      where book_id = $1
        and chapter_id is not distinct from $2
        and job_type = 'character_bundle_analysis'
        and provider_id = $3
          and model_id is not distinct from $4
        and input_hash = $5
        and user_id = $6
    `,
    [input.bookId, null, input.providerId, input.modelId, inputHash, input.userId],
  );
  const existingRow = existing.rows[0];
  const canRetryExisting =
    existingRow &&
    (existingRow.status === 'failed' ||
      existingRow.status === 'cancelled' ||
      (input.force && existingRow.status === 'succeeded'));
  if (existingRow && !canRetryExisting) return existingRow;
  const progress = JSON.stringify({
    budgetEstimate,
    providerOptions: input.resolvedProviderOptions,
    sourceContext,
    graphFingerprint: input.graphFingerprint,
    correctionFingerprint: input.correctionFingerprint,
  });
  if (!existingRow) {
    const inserted = await db.query<ProviderJobRow>(
      `
        insert into provider_jobs (
          id, user_id, book_id, chapter_id, job_type, provider_id, model_id, input_hash,
          status, stage, progress, created_at, updated_at
        )
        values ($1, $2, $3, null, 'character_bundle_analysis', $4, $5, $6, 'queued', 'queued', $7, now(), now())
        returning id, book_id, chapter_id, job_type, provider_id, model_id, input_hash, status,
                  stage, progress, error_code, error_message, created_at, updated_at, started_at, finished_at,
                  current_attempt_id
      `,
      [jobId, input.userId, input.bookId, input.providerId, input.modelId, inputHash, progress],
    );
    return inserted.rows[0];
  }
  const updated = await db.query<ProviderJobRow>(
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
      returning id, book_id, chapter_id, job_type, provider_id, model_id, input_hash, status,
                stage, progress, error_code, error_message, created_at, updated_at, started_at, finished_at,
                current_attempt_id
    `,
    [existingRow.id, input.userId, progress, existingRow.status, existingRow.current_attempt_id ?? null],
  );
  return updated.rows[0] ?? existingRow;
}
