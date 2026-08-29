import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import pg from 'pg';
import { appWithAIRoutes, expectProviderAttemptEnqueued } from './ai-route-test-harness.js';

describe('AI analysis workflow routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('builds a whole-book AI workflow plan from chapter and paragraph metadata', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (
          sql.includes('from chapters c') &&
          sql.includes('c.book_id = $1') &&
          sql.includes('order by c.chapter_index asc')
        ) {
          expect(params).toEqual(['book_1', 'user_test']);
          return {
            rows: [
              {
                id: 'chapter_1',
                chapter_index: 1,
                title: '1. 시작',
                text_hash: 'chapter_hash_1',
                character_count: 10000,
                paragraph_count: 3,
              },
              {
                id: 'chapter_2',
                chapter_index: 2,
                title: '2. 다음',
                text_hash: 'chapter_hash_2',
                character_count: 10000,
                paragraph_count: 1,
              },
            ],
          };
        }
        if (sql.includes('from paragraph_search ps') && sql.includes('length(ps.text) as text_length')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return {
            rows: [
              {
                paragraph_id: 'p1',
                chapter_id: 'chapter_1',
                paragraph_index: 0,
                text_length: 1000,
                text_hash: 'p_hash_1',
              },
              {
                paragraph_id: 'p2',
                chapter_id: 'chapter_1',
                paragraph_index: 1,
                text_length: 1000,
                text_hash: 'p_hash_2',
              },
              {
                paragraph_id: 'p3',
                chapter_id: 'chapter_1',
                paragraph_index: 2,
                text_length: 1000,
                text_hash: 'p_hash_3',
              },
              {
                paragraph_id: 'p4',
                chapter_id: 'chapter_2',
                paragraph_index: 0,
                text_length: 1000,
                text_hash: 'p_hash_4',
              },
            ],
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'GET',
      url: '/api/books/book_1/analysis-workflow-plan?targetBundleCharacters=15000&maxLabelingParagraphs=2',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('본문');
    const plan = response.json().plan;
    expect(plan).toMatchObject({
      novelId: 'book_1',
      totalChapters: 2,
      totalCharacters: 20000,
      stages: [
        expect.objectContaining({ id: 'character_graph_bootstrap' }),
        expect.objectContaining({ id: 'character_graph_merge', dependsOn: 'character_graph_bootstrap' }),
        expect.objectContaining({ id: 'chapter_labeling', dependsOn: 'character_graph_merge' }),
        expect.objectContaining({ id: 'tts_ready_preparation', dependsOn: 'chapter_labeling' }),
      ],
    });
    expect(plan.bundleWindows).toHaveLength(2);
    expect(plan.labelingChapters).toHaveLength(2);
    expect(plan.labelingChapters[0].windows.map((window: { paragraphIds: string[] }) => window.paragraphIds)).toEqual([
      ['p1', 'p2'],
      ['p3'],
    ]);
    expect(plan.ttsReady.dependsOnLabelingWindowIds).toEqual(
      plan.labelingWindows.map((window: { id: string }) => window.id),
    );

    await app.close();
  });

  it('starts a hosted book AI workflow and queues the first graph bootstrap bundle job', async () => {
    vi.stubEnv('AI_PROVIDER_ENABLED', 'mock');
    const workflowRows = new Map<string, Record<string, unknown>>();
    const providerRows = new Map<string, Record<string, unknown>>();
    const workflowLinks: Record<string, unknown>[] = [];
    const chapterRows = [
      {
        id: 'chapter_1',
        chapter_index: 1,
        title: '1. start',
        text_hash: 'chapter_hash_1',
        updated_at: '2026-07-07T00:00:00.000Z',
        character_count: 10000,
        paragraph_count: 2,
      },
      {
        id: 'chapter_2',
        chapter_index: 2,
        title: '2. next',
        text_hash: 'chapter_hash_2',
        updated_at: '2026-07-07T00:00:00.000Z',
        character_count: 10000,
        paragraph_count: 2,
      },
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from provider_settings')) {
          return {
            rows: [
              {
                scope: 'llm_labeling',
                default_provider_id: 'mock',
                enabled_provider_ids: ['mock'],
                model_overrides: { mock: 'mock-segment-labeler-v1' },
                provider_options: { mock: { requestProfileId: 'chapter-labeling-v1-strict-tts' } },
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        if (
          sql.includes('from chapters c') &&
          sql.includes('c.book_id = $1') &&
          sql.includes('order by c.chapter_index asc') &&
          !sql.includes('c.id = any')
        ) {
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: chapterRows };
        }
        if (sql.includes('from paragraph_search ps') && sql.includes('length(ps.text) as text_length')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return {
            rows: [
              {
                paragraph_id: 'p1',
                chapter_id: 'chapter_1',
                paragraph_index: 0,
                text_length: 5000,
                text_hash: 'p_hash_1',
              },
              {
                paragraph_id: 'p2',
                chapter_id: 'chapter_1',
                paragraph_index: 1,
                text_length: 5000,
                text_hash: 'p_hash_2',
              },
              {
                paragraph_id: 'p3',
                chapter_id: 'chapter_2',
                paragraph_index: 0,
                text_length: 5000,
                text_hash: 'p_hash_3',
              },
              {
                paragraph_id: 'p4',
                chapter_id: 'chapter_2',
                paragraph_index: 1,
                text_length: 5000,
                text_hash: 'p_hash_4',
              },
            ],
          };
        }
        if (sql.includes('from library_books') && sql.includes('normalized_text_hash')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return {
            rows: [
              {
                id: 'book_1',
                normalized_text_hash: 'book_hash',
                updated_at: '2026-07-07T00:00:00.000Z',
                total_chapters: 2,
                total_characters: 20000,
                total_paragraphs: 4,
              },
            ],
          };
        }
        if (sql.includes('from chapters c') && sql.includes('c.id = any($3::text[])')) {
          const requested = new Set(params?.[2] as string[]);
          return { rows: chapterRows.filter((row) => requested.has(row.id)) };
        }
        if (sql.includes('from characters')) return { rows: [] };
        if (sql.includes('from character_relations')) return { rows: [] };
        if (sql.includes('from user_corrections')) return { rows: [] };
        if (sql.includes('from provider_jobs') && sql.includes('where book_id')) return { rows: [] };
        if (
          sql.includes('from book_ai_workflows') &&
          sql.includes("status = 'running'") &&
          sql.includes('for update')
        ) {
          return { rows: [] };
        }
        if (sql.includes('insert into book_ai_workflows')) {
          const row = {
            id: params?.[0],
            user_id: params?.[1],
            book_id: params?.[2],
            workflow_type: 'book_ai_tts',
            provider_id: params?.[3],
            model_id: params?.[4],
            plan_hash: params?.[5],
            plan: JSON.parse(String(params?.[6])),
            status: 'running',
            stage: 'building_graph',
            progress: JSON.parse(String(params?.[7])),
            error_code: null,
            error_message: null,
            created_at: '2026-07-07T00:00:00.000Z',
            updated_at: '2026-07-07T00:00:00.000Z',
            started_at: '2026-07-07T00:00:00.000Z',
            finished_at: null,
          };
          workflowRows.set(String(row.id), row);
          return { rows: [row] };
        }
        if (sql.includes('insert into provider_jobs')) {
          const row = {
            id: params?.[0],
            book_id: params?.[2],
            chapter_id: null,
            job_type: 'character_bundle_analysis',
            provider_id: params?.[3],
            model_id: params?.[4],
            input_hash: params?.[5],
            status: 'queued',
            stage: 'queued',
            progress: JSON.parse(String(params?.[6])),
            error_code: null,
            error_message: null,
            created_at: '2026-07-07T00:00:00.000Z',
            updated_at: '2026-07-07T00:00:00.000Z',
            started_at: null,
            finished_at: null,
          };
          providerRows.set(String(row.id), row);
          return { rows: [row] };
        }
        if (sql.includes('insert into book_ai_workflow_jobs')) {
          workflowLinks.push({
            id: params?.[0],
            workflow_id: params?.[1],
            provider_job_id: params?.[2],
            stage: 'character_graph_bootstrap',
            plan_item_id: params?.[3],
            sequence: params?.[4],
            created_at: '2026-07-07T00:00:00.000Z',
          });
          return { rows: [] };
        }
        if (sql.includes('update book_ai_workflows')) {
          const row = workflowRows.get(String(params?.[0]));
          if (row) {
            row.progress = JSON.parse(String(params?.[2]));
            row.updated_at = '2026-07-07T00:00:01.000Z';
          }
          return { rows: row ? [row] : [] };
        }
        if (sql.includes('update library_books set analysis_status')) {
          expect(params).toEqual(['building_graph', 'book_1', 'user_test']);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) {
          return { rows: [workflowRows.get(String(params?.[0]))].filter(Boolean) };
        }
        if (sql.includes('from book_ai_workflow_jobs wj')) {
          return {
            rows: workflowLinks.map((link) => ({
              ...link,
              provider_job: providerRows.get(String(link.provider_job_id)),
            })),
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const providerQueue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const app = await appWithAIRoutes(pool, providerQueue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-workflows',
      payload: { planOptions: { targetBundleCharacters: 15000, maxLabelingParagraphs: 2 } },
    });

    expect(response.statusCode, response.body).toBe(202);
    const workflow = response.json().workflow;
    expect(workflow).toMatchObject({
      novelId: 'book_1',
      workflowDefinitionId: 'moya.ai.tts.book-preparation',
      workflowVersion: '1.0.0',
      providerId: 'mock',
      modelId: 'mock-segment-labeler-v1',
      status: 'running',
      stage: 'building_graph',
      progress: expect.objectContaining({
        totalBundleWindows: 2,
        queuedGraphBootstrapJobs: 1,
      }),
    });
    expect(workflow.jobs).toHaveLength(1);
    expect(workflow.jobs.map((job: { stage: string }) => job.stage)).toEqual(['character_graph_bootstrap']);
    expect(workflow.jobs[0].job.type).toBe('character_bundle_analysis');
    expect(workflow.jobs[0].job.progress.providerOptions).toBeUndefined();
    expect(providerQueue.add).toHaveBeenCalledTimes(1);
    expectProviderAttemptEnqueued(providerQueue, workflow.jobs[0].providerJobId);

    await app.close();
  });

  it('rejects active plan drift and reuses only an exact hosted workflow identity', async () => {
    vi.stubEnv('AI_PROVIDER_ENABLED', 'mock');
    const activeWorkflow = {
      id: 'workflow_active',
      user_id: 'user_test',
      book_id: 'book_1',
      workflow_type: 'book_ai_tts',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      plan_hash: 'sha256:legacy-three-stage-plan',
      plan: {},
      status: 'running',
      stage: 'building_graph',
      progress: { reused: true },
      error_code: null,
      error_message: null,
      created_at: '2026-07-07T00:00:00.000Z',
      updated_at: '2026-07-07T00:00:00.000Z',
      started_at: '2026-07-07T00:00:00.000Z',
      finished_at: null,
    };
    const chapterRows = [
      {
        id: 'chapter_1',
        chapter_index: 1,
        title: '1. start',
        text_hash: 'chapter_hash_1',
        updated_at: '2026-07-07T00:00:00.000Z',
        character_count: 8000,
        paragraph_count: 1,
      },
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from provider_settings')) {
          return {
            rows: [
              {
                scope: 'llm_labeling',
                default_provider_id: 'mock',
                enabled_provider_ids: ['mock'],
                model_overrides: { mock: 'mock-segment-labeler-v1' },
                provider_options: { mock: { requestProfileId: 'chapter-labeling-v1-strict-tts' } },
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        if (
          sql.includes('from chapters c') &&
          sql.includes('order by c.chapter_index asc') &&
          !sql.includes('c.id = any')
        ) {
          return { rows: chapterRows };
        }
        if (sql.includes('from paragraph_search ps') && sql.includes('length(ps.text) as text_length')) {
          return {
            rows: [
              {
                paragraph_id: 'p1',
                chapter_id: 'chapter_1',
                paragraph_index: 0,
                text_length: 8000,
                text_hash: 'p_hash_1',
              },
            ],
          };
        }
        if (sql.includes('from library_books') && sql.includes('normalized_text_hash')) {
          return {
            rows: [
              {
                id: 'book_1',
                normalized_text_hash: 'book_hash',
                updated_at: '2026-07-07T00:00:00.000Z',
                total_chapters: 1,
                total_characters: 8000,
                total_paragraphs: 1,
              },
            ],
          };
        }
        if (sql.includes('from chapters c') && sql.includes('c.id = any($3::text[])')) return { rows: chapterRows };
        if (sql.includes('from characters')) return { rows: [] };
        if (sql.includes('from character_relations')) return { rows: [] };
        if (sql.includes('from user_corrections')) return { rows: [] };
        if (
          sql.includes('from book_ai_workflows') &&
          sql.includes("status = 'running'") &&
          sql.includes('for update')
        ) {
          expect(params).toEqual(['user_test', 'book_1', 'mock', 'mock-segment-labeler-v1', 'content_revision_1']);
          activeWorkflow.plan = {
            novelId: 'book_1',
            totalChapters: 1,
            totalCharacters: 8000,
            stages: [],
            bundleWindows: [],
            labelingChapters: [],
            labelingWindows: [],
            ttsReady: { chapterIds: ['chapter_1'], dependsOnLabelingWindowIds: [] },
          };
          return { rows: [activeWorkflow] };
        }
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [activeWorkflow] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: [] };
        if (sql.includes('insert into book_ai_workflows') || sql.includes('insert into provider_jobs')) {
          throw new Error(`duplicate workflow should not insert rows: ${sql}`);
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const providerQueue = {
      add: vi.fn(),
    } as unknown as Queue;
    const app = await appWithAIRoutes(pool, providerQueue);

    const conflictResponse = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-workflows',
      payload: { planOptions: { targetBundleCharacters: 15000, maxLabelingParagraphs: 2 } },
    });

    expect(conflictResponse.statusCode, conflictResponse.body).toBe(409);
    expect(conflictResponse.json()).toMatchObject({
      errorCode: 'active_workflow_identity_conflict',
      activeWorkflow: {
        workflowId: 'workflow_active',
        workflowDefinitionId: 'moya.ai.tts.book-preparation',
        workflowVersion: '1.0.0',
        planHash: 'sha256:legacy-three-stage-plan',
      },
      requestedWorkflow: {
        workflowDefinitionId: 'moya.ai.tts.book-preparation',
        workflowVersion: '1.0.0',
      },
    });

    activeWorkflow.plan_hash = conflictResponse.json().requestedWorkflow.planHash;
    const reuseResponse = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-workflows',
      payload: {
        workflowDefinitionId: 'moya.ai.tts.book-preparation',
        workflowVersion: '1.0.0',
        planOptions: { targetBundleCharacters: 15000, maxLabelingParagraphs: 2 },
      },
    });

    expect(reuseResponse.statusCode, reuseResponse.body).toBe(200);
    expect(reuseResponse.json().workflow).toMatchObject({
      id: 'workflow_active',
      workflowDefinitionId: 'moya.ai.tts.book-preparation',
      workflowVersion: '1.0.0',
      status: 'running',
      stage: 'building_graph',
    });
    expect(providerQueue.add).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining('insert into provider_jobs'),
      expect.anything(),
    );
    await app.close();
  });

  it('rejects unsupported or partial hosted workflow definition references before provider work', async () => {
    const pool = { query: vi.fn() } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-workflows',
      payload: { workflowDefinitionId: 'community.workflow', workflowVersion: '1.0.0' },
    });
    const partial = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-workflows',
      payload: { workflowDefinitionId: 'moya.ai.tts.book-preparation' },
    });

    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toMatchObject({ errorCode: 'unsupported_workflow_definition' });
    expect(partial.statusCode).toBe(400);
    expect(partial.json()).toMatchObject({ errorCode: 'unsupported_workflow_definition' });
    expect(pool.query).not.toHaveBeenCalled();
    await app.close();
  });

  it('retries a hosted book AI workflow in needs_review and requeues failed child jobs', async () => {
    const workflowRow: Record<string, unknown> = {
      id: 'workflow_1',
      user_id: 'user_test',
      book_id: 'book_1',
      workflow_type: 'book_ai_tts',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      plan_hash: 'plan_hash',
      plan: {
        novelId: 'book_1',
        bundleWindows: [],
        labelingWindows: [],
        labelingChapters: [],
        ttsReady: { chapterIds: [], dependsOnLabelingWindowIds: [] },
      },
      status: 'needs_review',
      stage: 'needs_review',
      progress: { failedProviderJobId: 'provider_job_label_failed', failedStage: 'chapter_labeling' },
      error_code: 'validation_failed',
      error_message: 'Sparse labels',
      created_at: '2026-07-07T00:00:00.000Z',
      updated_at: '2026-07-07T00:00:01.000Z',
      started_at: '2026-07-07T00:00:00.000Z',
      finished_at: null,
    };
    const providerJobRow: Record<string, unknown> = {
      id: 'provider_job_label_failed',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'label_hash',
      status: 'failed',
      stage: 'failed',
      progress: { providerOptions: { secretShouldNotLeak: 'x' }, sourceContext: { labelingWindowId: 'window_1' } },
      error_code: 'validation_failed',
      error_message: 'Sparse labels',
      created_at: '2026-07-07T00:00:00.000Z',
      updated_at: '2026-07-07T00:00:01.000Z',
      started_at: '2026-07-07T00:00:00.000Z',
      finished_at: '2026-07-07T00:00:01.000Z',
    };
    const workflowLink = {
      id: 'workflow_link_1',
      workflow_id: 'workflow_1',
      provider_job_id: 'provider_job_label_failed',
      stage: 'chapter_labeling',
      plan_item_id: 'window_1',
      sequence: 0,
      created_at: '2026-07-07T00:00:00.000Z',
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('select id, user_id, book_id, provider_id') && sql.includes('from book_ai_workflows')) {
          expect(params).toEqual(['workflow_1', 'user_test']);
          return { rows: [workflowRow] };
        }
        if (sql.includes('from book_ai_workflow_jobs wj') && !sql.includes('jsonb_build_object')) {
          return {
            rows: [
              {
                ...workflowLink,
                job_type: providerJobRow.job_type,
                provider_id: providerJobRow.provider_id,
                model_id: providerJobRow.model_id,
                input_hash: providerJobRow.input_hash,
                status: providerJobRow.status,
                progress: providerJobRow.progress,
                error_code: providerJobRow.error_code,
                error_message: providerJobRow.error_message,
              },
            ],
          };
        }
        if (sql.includes('update book_ai_workflows') && sql.includes("status = 'running'")) {
          workflowRow.status = 'running';
          workflowRow.stage = 'labeling_chapters';
          workflowRow.progress = JSON.parse(String(params?.[3]));
          workflowRow.error_code = null;
          workflowRow.error_message = null;
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('update provider_jobs') && sql.includes("status = 'queued'")) {
          expect(sql).toContain('current_attempt_id is not distinct from $5');
          expect(params?.[4]).toMatch(/^provider_attempt_/);
          providerJobRow.status = 'queued';
          providerJobRow.stage = 'queued';
          providerJobRow.error_code = null;
          providerJobRow.error_message = null;
          providerJobRow.started_at = null;
          providerJobRow.finished_at = null;
          providerJobRow.progress = {
            ...(providerJobRow.progress as Record<string, unknown>),
            workflowRetry: JSON.parse(String(params?.[2])),
          };
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('select id, book_id, workflow_type') && sql.includes('from book_ai_workflows')) {
          expect(params).toEqual(['workflow_1', 'user_test']);
          return { rows: [workflowRow] };
        }
        if (sql.includes('from book_ai_workflow_jobs wj') && sql.includes('jsonb_build_object')) {
          return { rows: [{ ...workflowLink, provider_job: providerJobRow }] };
        }
        if (sql.includes('from book_ai_workflow_jobs wj') && sql.includes('pj.analysis_input_revision_id')) {
          return {
            rows: [
              {
                ...workflowLink,
                job_type: providerJobRow.job_type,
                provider_id: providerJobRow.provider_id,
                model_id: providerJobRow.model_id,
                input_hash: providerJobRow.input_hash,
                status: providerJobRow.status,
                progress: providerJobRow.progress,
                error_code: providerJobRow.error_code,
                error_message: providerJobRow.error_message,
                current_attempt_id: providerJobRow.current_attempt_id,
                analysis_input_revision_id: null,
              },
            ],
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const providerQueue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const app = await appWithAIRoutes(pool, providerQueue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/analysis-workflows/workflow_1/retry',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain('secretShouldNotLeak');
    expect(response.json().workflow).toMatchObject({
      id: 'workflow_1',
      status: 'running',
      stage: 'labeling_chapters',
      progress: expect.objectContaining({
        retryCount: 1,
        retriedProviderJobIds: ['provider_job_label_failed'],
      }),
      jobs: [
        expect.objectContaining({
          providerJobId: 'provider_job_label_failed',
          job: expect.objectContaining({
            status: 'queued',
            stage: 'queued',
            progress: expect.objectContaining({
              sourceContext: { labelingWindowId: 'window_1' },
              workflowRetry: expect.objectContaining({ workflowId: 'workflow_1', retryCount: 1 }),
            }),
          }),
        }),
      ],
    });
    expectProviderAttemptEnqueued(providerQueue, 'provider_job_label_failed');

    const unsupportedAction = await app.inject({
      method: 'POST',
      url: '/api/analysis-workflows/workflow_1/retry',
      payload: { action: 'repair_failed_output' },
    });
    expect(unsupportedAction.statusCode).toBe(400);
    expect(unsupportedAction.json()).toEqual({
      error: 'unsupported workflow retry action',
      supportedActions: ['retry_same_request'],
    });

    await app.close();

    workflowRow.status = 'needs_review';
    workflowRow.stage = 'needs_review';
    workflowRow.progress = { failedProviderJobId: 'provider_job_label_failed', failedStage: 'chapter_labeling' };
    providerJobRow.status = 'failed';
    providerJobRow.stage = 'failed';
    providerJobRow.error_code = 'validation_failed';
    providerJobRow.error_message = 'Sparse labels';
    const limitedQueue = { add: vi.fn() } as unknown as Queue;
    const limitedApp = await appWithAIRoutes(pool, limitedQueue, { limit: 'active_attempts' });

    const limitedResponse = await limitedApp.inject({
      method: 'POST',
      url: '/api/analysis-workflows/workflow_1/retry',
    });

    expect(limitedResponse.statusCode).toBe(429);
    expect(limitedResponse.json()).toEqual({
      error: 'provider_job_admission_rejected',
      code: 'provider_job_admission_rejected',
      limit: 'active_attempts',
    });
    expect(limitedQueue.add).not.toHaveBeenCalled();
    await limitedApp.close();
  });

  it('cancels a hosted book AI workflow and linked active provider jobs', async () => {
    const workflowRow: Record<string, unknown> = {
      id: 'workflow_cancel',
      user_id: 'user_test',
      book_id: 'book_1',
      workflow_type: 'book_ai_tts',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      plan_hash: 'plan_hash',
      content_revision_id: 'content_revision_1',
      base_graph_revision_id: 'graph_revision_1',
      revision_fence: 1,
      plan: {
        novelId: 'book_1',
        bundleWindows: [],
        labelingWindows: [],
        labelingChapters: [],
        ttsReady: { chapterIds: [], dependsOnLabelingWindowIds: [] },
      },
      status: 'running',
      stage: 'labeling_chapters',
      progress: { totalLabelingWindows: 2 },
      error_code: null,
      error_message: null,
      created_at: '2026-07-07T00:00:00.000Z',
      updated_at: '2026-07-07T00:00:01.000Z',
      started_at: '2026-07-07T00:00:00.000Z',
      finished_at: null,
    };
    const providerJobRow: Record<string, unknown> = {
      id: 'provider_job_running',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'label_hash',
      status: 'running',
      stage: 'labeling_segments',
      progress: { sourceContext: { labelingWindowId: 'window_1' } },
      error_code: null,
      error_message: null,
      created_at: '2026-07-07T00:00:00.000Z',
      updated_at: '2026-07-07T00:00:01.000Z',
      started_at: '2026-07-07T00:00:00.000Z',
      finished_at: null,
    };
    const workflowLink = {
      id: 'workflow_link_cancel',
      workflow_id: 'workflow_cancel',
      provider_job_id: 'provider_job_running',
      stage: 'chapter_labeling',
      plan_item_id: 'window_1',
      sequence: 0,
      created_at: '2026-07-07T00:00:00.000Z',
    };
    const bookUpdates: Record<string, unknown>[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1 and user_id = $2')) {
          expect(params).toEqual(['workflow_cancel', 'user_test']);
          return { rows: [workflowRow] };
        }
        if (sql.includes('from book_ai_workflow_jobs wj') && sql.includes('jsonb_build_object')) {
          return { rows: [{ ...workflowLink, provider_job: providerJobRow }] };
        }
        if (sql.includes('from book_ai_workflow_jobs wj') && sql.includes('pj.analysis_input_revision_id')) {
          return {
            rows: [
              {
                ...workflowLink,
                job_type: providerJobRow.job_type,
                provider_id: providerJobRow.provider_id,
                model_id: providerJobRow.model_id,
                input_hash: providerJobRow.input_hash,
                status: providerJobRow.status,
                progress: providerJobRow.progress,
                error_code: providerJobRow.error_code,
                error_message: providerJobRow.error_message,
                current_attempt_id: providerJobRow.current_attempt_id,
                analysis_input_revision_id: null,
              },
            ],
          };
        }
        if (sql.includes("pj.status in ('queued', 'running')")) {
          expect(params).toEqual(['workflow_cancel', 'user_test']);
          return { rows: [providerJobRow] };
        }
        if (sql.includes('update provider_jobs') && sql.includes("set status = 'cancelled'")) {
          providerJobRow.status = 'cancelled';
          providerJobRow.stage = 'cancelled';
          providerJobRow.progress = JSON.parse(String(params?.[2]));
          providerJobRow.error_code = 'provider_job_cancelled';
          providerJobRow.error_message = params?.[3];
          providerJobRow.finished_at = '2026-07-07T00:00:02.000Z';
          return { rowCount: 1, rows: [providerJobRow] };
        }
        if (sql.includes('update provider_jobs') && sql.includes('set progress = $3')) {
          providerJobRow.progress = JSON.parse(String(params?.[2]));
          return { rowCount: 1, rows: [providerJobRow] };
        }
        if (sql.includes("jsonb_build_object('queueRemovals'")) {
          workflowRow.progress = {
            ...(workflowRow.progress as Record<string, unknown>),
            queueRemovals: JSON.parse(String(params?.[2])),
          };
          return { rowCount: 1, rows: [workflowRow] };
        }
        if (sql.includes('update book_ai_workflows') && sql.includes("set status = 'cancelled'")) {
          workflowRow.status = 'cancelled';
          workflowRow.stage = 'cancelled';
          workflowRow.progress = JSON.parse(String(params?.[2]));
          workflowRow.error_code = 'workflow_cancelled';
          workflowRow.error_message = params?.[3];
          workflowRow.finished_at = '2026-07-07T00:00:02.000Z';
          return { rowCount: 1, rows: [workflowRow] };
        }
        if (sql.includes('update library_books') && sql.includes('active_content_revision_id')) {
          bookUpdates.push({ status: 'cancelled', bookId: params?.[0], userId: params?.[1] });
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('update library_books')) {
          bookUpdates.push({ status: params?.[0], bookId: params?.[1], userId: params?.[2] });
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const remove = vi.fn(async () => undefined);
    const providerQueue = {
      getJob: vi.fn(async () => ({ remove })),
    } as unknown as Queue;
    const app = await appWithAIRoutes(pool, providerQueue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/analysis-workflows/workflow_cancel/cancel',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().workflow).toMatchObject({
      id: 'workflow_cancel',
      status: 'cancelled',
      stage: 'cancelled',
      progress: expect.objectContaining({
        cancelled: true,
        cancelledProviderJobIds: ['provider_job_running'],
        queueRemovals: {
          provider_job_running: { attempted: true, removed: true },
        },
      }),
      jobs: [
        expect.objectContaining({
          providerJobId: 'provider_job_running',
          job: expect.objectContaining({
            status: 'cancelled',
            stage: 'cancelled',
            progress: expect.objectContaining({
              cancelled: true,
              queueRemoval: { attempted: true, removed: true },
            }),
          }),
        }),
      ],
    });
    expect(providerQueue.getJob).toHaveBeenCalledWith(expect.stringMatching(/^provider_attempt_/));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(bookUpdates).toEqual([{ status: 'cancelled', bookId: 'book_1', userId: 'user_test' }]);

    await app.close();
  });
});
