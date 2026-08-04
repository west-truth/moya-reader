import { expect, vi } from 'vitest';
import type { Queue } from 'bullmq';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import type { BookAIWorkflowPlan } from '../../../../../src/providers/book-ai-workflow-plan';
import { characterGraphIntegrityHash } from '@noveldesk/text-core/identity/ai';
import { textIntegrityHash } from '@noveldesk/text-core/hash';

export function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir: '.server-test-data',
    maxChunkBytes: 1024,
    maxUploadBytes: 1024 * 1024,
    staleUploadMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    s3: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
    },
  };
}

const providerAttemptPoolCache = new WeakMap<pg.Pool, pg.Pool>();

export function providerAttemptAwarePool(pool: pg.Pool): pg.Pool {
  const cached = providerAttemptPoolCache.get(pool);
  if (cached) return cached;
  const currentAttemptByJob = new Map<string, string>();
  const inputRevisionByJob = new Map<string, Record<string, unknown>>();
  const analysisReviewById = new Map<string, Record<string, unknown>>();
  const originalQuery = pool.query.bind(pool);
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (['begin', 'commit', 'rollback'].includes(sql.trim().toLowerCase())) {
      return { rowCount: null, rows: [] };
    }
    if (sql.includes('join book_content_revisions content') && sql.includes('for update of book')) {
      const bookId = String(params?.[0]);
      const graph = { novelId: bookId, characters: [], relations: [] };
      return {
        rows: [
          {
            id: bookId,
            user_id: String(params?.[1]),
            object_id: 'object_1',
            normalized_text_hash: 'book_hash',
            content_revision_number: 1,
            revision_fence: 1,
            active_content_revision_id: 'content_revision_1',
            active_character_graph_revision_id: 'graph_revision_1',
            source_raw_text_hash: 'raw_hash_1',
            graph_revision_number: 1,
            graph_fingerprint: characterGraphIntegrityHash(graph),
            graph_snapshot: graph,
          },
        ],
      };
    }
    if (sql.includes('select active_content_revision_id') && sql.includes('from library_books')) {
      return {
        rows: [
          {
            active_content_revision_id: 'content_revision_1',
            active_character_graph_revision_id: 'graph_revision_1',
            revision_fence: 1,
          },
        ],
      };
    }
    if (sql.includes('from characters') || sql.includes('from character_relations')) return { rows: [] };
    if (sql.includes('from user_corrections') && sql.includes('order by created_at desc')) {
      return { rows: [] };
    }
    if (sql.includes('insert into provider_capability_snapshots')) return { rowCount: 1, rows: [] };
    if (sql.includes('insert into analysis_input_revisions')) {
      const row = {
        id: params?.[0],
        provider_job_id: params?.[1],
        workflow_id: params?.[2],
        user_id: params?.[3],
        book_id: params?.[4],
        chapter_id: params?.[5],
        job_type: params?.[6],
        content_revision_id: params?.[7],
        content_revision_number: params?.[8],
        revision_fence: params?.[9],
        source_object_id: params?.[10],
        source_raw_text_hash: params?.[11],
        normalized_text_hash: params?.[12],
        character_graph_revision_id: params?.[13],
        character_graph_fingerprint: params?.[14],
        correction_fingerprint: params?.[15],
        request_profile_id: params?.[16],
        prompt_version: params?.[17],
        schema_version: params?.[18],
        provider_id: params?.[19],
        model_id: params?.[20],
        provider_options_fingerprint: params?.[21],
        provider_options: JSON.parse(String(params?.[22])),
        window_spec: JSON.parse(String(params?.[23])),
        source_snapshot: JSON.parse(String(params?.[24])),
        graph_snapshot: JSON.parse(String(params?.[25])),
        corrections_snapshot: JSON.parse(String(params?.[26])),
        episode_context_snapshot: params?.[27] ? JSON.parse(String(params[27])) : null,
        render_spec: params?.[28] ? JSON.parse(String(params[28])) : null,
        render_spec_hash: params?.[29],
        voice_profile_snapshot: params?.[30] ? JSON.parse(String(params[30])) : null,
        capability_snapshot_id: params?.[31],
        capability_snapshot: params?.[32] ? JSON.parse(String(params[32])) : null,
        task_profile_snapshot: params?.[33] ? JSON.parse(String(params[33])) : null,
        admission_snapshot: params?.[34] ? JSON.parse(String(params[34])) : null,
        input_hash: params?.[35],
        created_at: '2026-07-10T00:00:00.000Z',
      };
      inputRevisionByJob.set(String(params?.[1]), row);
      return { rowCount: 1, rows: [row] };
    }
    if (sql.includes('from analysis_input_revisions where provider_job_id = $1')) {
      return { rows: [inputRevisionByJob.get(String(params?.[0]))].filter(Boolean) };
    }
    if (sql.includes('from analysis_input_revisions where id = $1')) {
      return {
        rows: [...inputRevisionByJob.values()].filter((row) => row.id === params?.[0]),
      };
    }
    if (sql.includes('insert into analysis_review_artifacts')) {
      const row = {
        id: params?.[0],
        workflow_id: params?.[1],
        provider_job_id: params?.[2],
        input_revision_id: params?.[7],
        staging_artifact_id: params?.[8],
        review_kind: 'chapter_labeling',
        window_id: params?.[9],
        chapter_id: params?.[6],
        normalized_candidate: JSON.parse(String(params?.[10])),
        candidate_hash: params?.[11],
        generated_candidate: JSON.parse(String(params?.[10])),
        generated_candidate_hash: params?.[11],
        edit_intents: {},
        validation_issues: JSON.parse(String(params?.[12])),
        quality_issues: JSON.parse(String(params?.[13])),
        validation_summary: JSON.parse(String(params?.[14])),
        quality_summary: JSON.parse(String(params?.[15])),
        provider_execution_metadata: params?.[16] ? JSON.parse(String(params[16])) : null,
        status: 'open',
        review_revision: 1,
        content_revision_id: params?.[17],
        revision_fence: params?.[18],
        graph_revision_id: params?.[19],
        graph_fingerprint: params?.[20],
        correction_fingerprint: params?.[21],
        promoted_artifact_id: null,
        created_at: '2026-07-11T00:00:00.000Z',
        updated_at: '2026-07-11T00:00:00.000Z',
        promoted_at: null,
        expires_at: null,
        user_id: params?.[4],
      };
      if (![...analysisReviewById.values()].some((item) => item.staging_artifact_id === row.staging_artifact_id)) {
        analysisReviewById.set(String(row.id), row);
      }
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('from analysis_review_artifacts') && sql.includes('where id = $1 and user_id = $2')) {
      const row = analysisReviewById.get(String(params?.[0]));
      return { rows: row?.user_id === params?.[1] ? [row] : [] };
    }
    if (sql.includes('from analysis_review_artifacts') && sql.includes('where workflow_id = $1')) {
      return {
        rows: [...analysisReviewById.values()].filter(
          (row) => row.workflow_id === params?.[0] && row.user_id === params?.[1],
        ),
      };
    }
    if (sql.includes('select id, status') && sql.includes('where staging_artifact_id = $1')) {
      const row = [...analysisReviewById.values()].find((item) => item.staging_artifact_id === params?.[0]);
      return { rows: row ? [{ id: row.id, status: row.status }] : [] };
    }
    if (sql.includes('select status from analysis_review_artifacts') && sql.includes('staging_artifact_id = $1')) {
      const row = [...analysisReviewById.values()].find((item) => item.staging_artifact_id === params?.[0]);
      return { rows: row ? [{ status: row.status }] : [] };
    }
    if (sql.includes("set status = 'obsolete'")) {
      const row = analysisReviewById.get(String(params?.[0]));
      const allowedStatuses = sql.includes("status in ('approved', 'promoting')")
        ? ['approved', 'promoting']
        : ['open'];
      if (!row || !allowedStatuses.includes(String(row.status))) return { rowCount: 0, rows: [] };
      row.status = 'obsolete';
      row.review_revision = Number(row.review_revision) + 1;
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("set status = 'promoting'")) {
      const row = analysisReviewById.get(String(params?.[0]));
      if (!row || !['approved', 'promoting'].includes(String(row.status))) return { rowCount: 0, rows: [] };
      row.status = 'promoting';
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("set status = 'promoted'")) {
      const row = analysisReviewById.get(String(params?.[0]));
      if (!row || row.status !== 'promoting') return { rowCount: 0, rows: [] };
      row.status = 'promoted';
      row.promoted_artifact_id = params?.[1];
      row.review_revision = Number(row.review_revision) + 1;
      row.promoted_at = '2026-07-11T00:02:00.000Z';
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('update analysis_review_artifacts')) {
      const row = analysisReviewById.get(String(params?.[0]));
      if (!row || row.user_id !== params?.[1] || row.review_revision !== params?.[2]) return { rows: [] };
      row.status = params?.[3];
      if (params?.[4]) row.normalized_candidate = JSON.parse(String(params[4]));
      if (params?.[5]) row.candidate_hash = params[5];
      if (params?.[6]) row.edit_intents = JSON.parse(String(params[6]));
      if (params?.[7]) row.validation_issues = JSON.parse(String(params[7]));
      if (params?.[8]) row.quality_issues = JSON.parse(String(params[8]));
      if (params?.[9]) row.validation_summary = JSON.parse(String(params[9]));
      if (params?.[10]) row.quality_summary = JSON.parse(String(params[10]));
      row.review_revision = params?.[11];
      row.updated_at = '2026-07-11T00:01:00.000Z';
      return { rows: [row] };
    }
    if (sql.includes('insert into analysis_review_decisions')) return { rowCount: 1, rows: [] };
    if (sql.includes('from paragraph_search paragraph') && sql.includes('paragraph.paragraph_id = $2')) {
      return {
        rowCount: 1,
        rows: [
          {
            active_content_revision_id: 'content_revision_1',
            chapter_index: 0,
            paragraph_index: 0,
            paragraph_id: params?.[1],
            text_hash: 'paragraph_hash_1',
          },
        ],
      };
    }
    if (sql.includes('from user_corrections') && sql.includes("lifecycle_state = 'active'")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('insert into user_corrections')) return { rowCount: 1, rows: [] };
    if (sql.includes('insert into label_mutation_operations')) return { rowCount: 1, rows: [] };
    if (sql.includes('insert into label_mutation_invalidations')) return { rowCount: 1, rows: [] };
    if (sql.includes('insert into label_reanalysis_plans')) return { rowCount: 1, rows: [] };
    if (sql.includes('update tts_audio_cache')) return { rowCount: 0, rows: [] };
    if (sql.includes('update analysis_episode_contexts')) return { rowCount: 0, rows: [] };
    if (sql.includes('insert into analysis_runs')) return { rowCount: 1, rows: [] };
    if (sql.includes('delete from labeled_segments') || sql.includes('insert into labeled_segments')) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('insert into analysis_episode_contexts')) return { rowCount: 1, rows: [{ id: params?.[0] }] };
    if (sql.includes('insert into chapter_contexts') || sql.includes('insert into sync_events')) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.trim().startsWith('update analysis_staging_artifacts')) return { rowCount: 1, rows: [] };
    if (sql.trim().startsWith('update library_books')) return { rowCount: 1, rows: [] };
    if (sql.includes('from book_ai_workflow_jobs workflow_job') && sql.includes("pj.status in ('queued', 'running')")) {
      return { rows: [] };
    }
    if (sql.includes('set analysis_input_revision_id = $2')) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('from analysis_episode_contexts') || sql.includes('from analysis_episode_contexts context')) {
      return { rows: [] };
    }
    if (sql.includes('from chapters c') && sql.includes('where c.id = $1')) {
      const chapterId = String(params?.[0]);
      const chapterIndex = Number(chapterId.match(/(\d+)$/)?.[1] ?? 1);
      return {
        rows: [
          {
            id: chapterId,
            book_id: String(params?.[1]),
            chapter_index: chapterIndex,
            title: `Chapter ${chapterIndex}`,
            text_hash: `chapter_hash_${chapterIndex}`,
            raw_start_offset: 0,
            raw_end_offset: 12000,
            character_count: 12000,
            paragraph_count: 3,
            created_at: '2026-07-10T00:00:00.000Z',
            updated_at: '2026-07-10T00:00:00.000Z',
          },
        ],
      };
    }
    if (sql.includes('from chapters c') && sql.includes('c.id = any($3::text[])')) {
      const chapterIds = Array.isArray(params?.[2]) ? params[2].map(String) : [];
      return {
        rows: chapterIds.map((chapterId) => {
          const chapterIndex = Number(chapterId.match(/(\d+)$/)?.[1] ?? 1);
          return {
            id: chapterId,
            book_id: String(params?.[0]),
            chapter_index: chapterIndex,
            title: `Chapter ${chapterIndex}`,
            text_hash: `chapter_hash_${chapterIndex}`,
            raw_start_offset: 0,
            raw_end_offset: 12000,
            character_count: 12000,
            paragraph_count: 3,
            created_at: '2026-07-10T00:00:00.000Z',
            updated_at: '2026-07-10T00:00:00.000Z',
          };
        }),
      };
    }
    if (
      sql.includes('select id, text_hash, updated_at, paragraph_count, character_count') &&
      sql.includes('from chapters')
    ) {
      const chapterIds = Array.isArray(params?.[1]) ? params[1].map(String) : [];
      return {
        rows: chapterIds.map((chapterId) => {
          const chapterIndex = Number(chapterId.match(/(\d+)$/)?.[1] ?? 1);
          return {
            id: chapterId,
            text_hash: `chapter_hash_${chapterIndex}`,
            updated_at: '2026-07-10T00:00:00.000Z',
            paragraph_count: 3,
            character_count: 12000,
          };
        }),
      };
    }
    if (sql.includes('select id, chapter_index, text_hash') && sql.includes('from chapters')) {
      const chapterIds = Array.isArray(params?.[1]) ? params[1].map(String) : [];
      return {
        rows: chapterIds.map((chapterId) => {
          const chapterIndex = Number(chapterId.match(/(\d+)$/)?.[1] ?? 1);
          return { id: chapterId, chapter_index: chapterIndex, text_hash: `chapter_hash_${chapterIndex}` };
        }),
      };
    }
    if (sql.includes('from paragraph_search') && sql.includes('where chapter_id = $1')) {
      const chapterId = String(params?.[0]);
      const chapterIndex = Number(chapterId.match(/(\d+)$/)?.[1] ?? 1);
      const requestedIds = Array.isArray(params?.[1]) ? params[1].map(String) : [`p${chapterIndex}`];
      return {
        rows: requestedIds.map((paragraphId, index) => {
          const paragraphText = `Paragraph ${paragraphId}`;
          return {
            paragraph_id: paragraphId,
            book_id: 'book_1',
            chapter_id: chapterId,
            paragraph_index: index,
            text: paragraphText,
            paragraph: {
              id: paragraphId,
              novelId: 'book_1',
              chapterId,
              index,
              text: paragraphText,
              startOffsetInChapter: 0,
              endOffsetInChapter: paragraphText.length,
              textHash: textIntegrityHash(paragraphText),
            },
          };
        }),
      };
    }
    if (sql.includes('with target as materialized')) {
      const jobId = String(params?.[0]);
      const attemptId = String(params?.[1]);
      const bullmqJobId = String(params?.[2]);
      currentAttemptByJob.set(jobId, attemptId);
      return {
        rowCount: 1,
        rows: [
          {
            outcome: 'admitted',
            attempt_id: attemptId,
            bullmq_job_id: bullmqJobId,
            reused: false,
            limit_kind: null,
            retry_after_seconds: null,
          },
        ],
      };
    }
    if (sql.trim().startsWith('insert into provider_job_outbox') || sql.includes('update provider_job_outbox')) {
      return { rowCount: 1, rows: [] };
    }

    const result = await originalQuery(sql, params);
    if (
      sql.includes("set status = 'queued'") &&
      sql.includes('current_attempt_id is not distinct from') &&
      (sql.includes('returning id, status') || /returning id\s*$/.test(sql.trim())) &&
      result.rows.length === 0 &&
      result.rowCount !== 0
    ) {
      return { ...result, rowCount: 1, rows: [{ id: String(params?.[0]), status: 'queued' }] };
    }
    if (!sql.includes('provider_jobs') || !Array.isArray(result.rows)) return result;
    const rows = result.rows.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const row = value as Record<string, unknown>;
      const jobId =
        typeof row.provider_job_id === 'string' ? row.provider_job_id : typeof row.id === 'string' ? row.id : undefined;
      if (!jobId || typeof row.status !== 'string') return value;
      const attemptId =
        currentAttemptByJob.get(jobId) ??
        (typeof row.current_attempt_id === 'string' ? row.current_attempt_id : `provider_attempt_fixture_${jobId}`);
      currentAttemptByJob.set(jobId, attemptId);
      return { ...row, current_attempt_id: attemptId };
    });
    return { ...result, rows };
  });
  const wrapped = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') return query;
      if (property === 'connect') {
        return async () => ({ query, release: vi.fn() });
      }
      return Reflect.get(target, property, receiver);
    },
  });
  providerAttemptPoolCache.set(pool, wrapped);
  return wrapped;
}

export function expectProviderAttemptEnqueued(queue: Queue, logicalJobId: string, expectedCall = 1): void {
  expect(queue.add).toHaveBeenNthCalledWith(
    expectedCall,
    'provider-job',
    expect.objectContaining({
      jobId: logicalJobId,
      attemptId: expect.stringMatching(/^provider_attempt_[a-f0-9]{32}$/),
    }),
    { jobId: expect.stringMatching(/^provider_attempt_[a-f0-9]{32}$/) },
  );
  const calls = (queue.add as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const data = calls[expectedCall - 1]?.[1] as { attemptId?: string } | undefined;
  const options = calls[expectedCall - 1]?.[2] as { jobId?: string } | undefined;
  expect(data?.attemptId).toBe(options?.jobId);
}

export function workflowPlan(): BookAIWorkflowPlan {
  return {
    novelId: 'book_1',
    totalChapters: 2,
    totalCharacters: 24000,
    stages: [
      { id: 'character_graph_bootstrap', itemIds: ['bundle_1', 'bundle_2'] },
      { id: 'chapter_labeling', dependsOn: 'character_graph_bootstrap', itemIds: ['window_1', 'window_2'] },
      { id: 'tts_ready_preparation', dependsOn: 'chapter_labeling', itemIds: ['chapter_1', 'chapter_2'] },
    ],
    bundleWindows: [
      {
        id: 'bundle_1',
        bundleId: 'bundle_1',
        sequence: 0,
        chapterIds: ['chapter_1'],
        startChapterIndex: 1,
        endChapterIndex: 1,
        characterCount: 12000,
        textHashFingerprint: 'bundle_hash_1',
      },
      {
        id: 'bundle_2',
        bundleId: 'bundle_2',
        sequence: 1,
        chapterIds: ['chapter_2'],
        startChapterIndex: 2,
        endChapterIndex: 2,
        characterCount: 12000,
        textHashFingerprint: 'bundle_hash_2',
        previousBundleId: 'bundle_1',
      },
    ],
    labelingChapters: [
      {
        chapterId: 'chapter_1',
        chapterIndex: 1,
        textHash: 'chapter_hash_1',
        dependsOnGraph: true,
        windows: [
          {
            id: 'window_1',
            sequence: 0,
            chapterId: 'chapter_1',
            chapterIndex: 1,
            paragraphIds: ['p1'],
            startParagraphIndex: 0,
            endParagraphIndex: 0,
            characterCount: 12000,
            textHashFingerprint: 'window_hash_1',
            dependsOnGraph: true,
          },
        ],
      },
      {
        chapterId: 'chapter_2',
        chapterIndex: 2,
        textHash: 'chapter_hash_2',
        dependsOnGraph: true,
        windows: [
          {
            id: 'window_2',
            sequence: 1,
            chapterId: 'chapter_2',
            chapterIndex: 2,
            paragraphIds: ['p2'],
            startParagraphIndex: 0,
            endParagraphIndex: 0,
            characterCount: 12000,
            textHashFingerprint: 'window_hash_2',
            dependsOnGraph: true,
          },
        ],
      },
    ],
    labelingWindows: [
      {
        id: 'window_1',
        sequence: 0,
        chapterId: 'chapter_1',
        chapterIndex: 1,
        paragraphIds: ['p1'],
        startParagraphIndex: 0,
        endParagraphIndex: 0,
        characterCount: 12000,
        textHashFingerprint: 'window_hash_1',
        dependsOnGraph: true,
      },
      {
        id: 'window_2',
        sequence: 1,
        chapterId: 'chapter_2',
        chapterIndex: 2,
        paragraphIds: ['p2'],
        startParagraphIndex: 0,
        endParagraphIndex: 0,
        characterCount: 12000,
        textHashFingerprint: 'window_hash_2',
        dependsOnGraph: true,
      },
    ],
    ttsReady: {
      chapterIds: ['chapter_1', 'chapter_2'],
      dependsOnLabelingWindowIds: ['window_1', 'window_2'],
    },
  };
}

export function workflowRow(plan = workflowPlan()): Record<string, unknown> {
  return {
    id: 'workflow_1',
    user_id: 'user_test',
    book_id: 'book_1',
    provider_id: 'mock',
    model_id: 'mock-segment-labeler-v1',
    plan_hash: 'plan_hash',
    plan,
    content_revision_id: 'content_revision_1',
    base_graph_revision_id: 'graph_revision_1',
    revision_fence: 1,
    status: 'running',
    stage: 'building_graph',
    progress: {},
  };
}

export function bootstrapLink(input: {
  readonly id: string;
  readonly providerJobId: string;
  readonly bundleId: string;
  readonly sequence: number;
  readonly characterId: string;
}): Record<string, unknown> {
  return {
    id: `link_${input.id}`,
    workflow_id: 'workflow_1',
    provider_job_id: input.providerJobId,
    stage: 'character_graph_bootstrap',
    plan_item_id: input.bundleId,
    sequence: input.sequence,
    job_type: 'character_bundle_analysis',
    provider_id: 'mock',
    model_id: 'mock-segment-labeler-v1',
    input_hash: `input_${input.providerJobId}`,
    status: 'succeeded',
    error_code: null,
    error_message: null,
    progress: {
      providerOptions: { requestProfileId: 'chapter-labeling-v1-strict-tts' },
      sourceContext: { bundleId: input.bundleId, chapterIds: [`chapter_${input.sequence + 1}`] },
      bundleSummaryForNext: `${input.bundleId} summary`,
      discoveredGraph: {
        novelId: 'book_1',
        characters: [
          {
            id: input.characterId,
            novelId: 'book_1',
            canonicalName: input.characterId,
            aliases: [],
            color: '#3b82f6',
            confidence: 0.8,
            isUserConfirmed: false,
          },
        ],
        relations: [],
      },
    },
  };
}

export function mergeLink(): Record<string, unknown> {
  return {
    id: 'link_merge',
    workflow_id: 'workflow_1',
    provider_job_id: 'provider_job_merge',
    stage: 'character_graph_merge',
    plan_item_id: 'character_graph_merge',
    sequence: 0,
    job_type: 'character_graph_merge',
    provider_id: 'mock',
    model_id: 'mock-segment-labeler-v1',
    input_hash: 'merge_hash',
    status: 'succeeded',
    error_code: null,
    error_message: null,
    progress: { providerOptions: { requestProfileId: 'chapter-labeling-v1-strict-tts' } },
  };
}

export function labelingLink(input: {
  readonly id: string;
  readonly providerJobId: string;
  readonly windowId: string;
  readonly sequence: number;
  readonly status?: string;
}): Record<string, unknown> {
  return {
    id: `link_${input.id}`,
    workflow_id: 'workflow_1',
    provider_job_id: input.providerJobId,
    stage: 'chapter_labeling',
    plan_item_id: input.windowId,
    sequence: input.sequence,
    job_type: 'chapter_segment_labeling',
    provider_id: 'mock',
    model_id: 'mock-segment-labeler-v1',
    input_hash: `input_${input.providerJobId}`,
    status: input.status ?? 'succeeded',
    error_code: null,
    error_message: null,
    progress: {},
  };
}
