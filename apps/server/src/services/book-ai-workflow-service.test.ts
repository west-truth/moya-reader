import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import pg from 'pg';
import type { BookAIWorkflowPlan } from '../../../../src/providers/book-ai-workflow-plan';
import { advanceBookAIWorkflow } from './book-ai-workflow-service.js';
import {
  testConfig,
  providerAttemptAwarePool,
  expectProviderAttemptEnqueued,
  workflowPlan,
  workflowRow,
  bootstrapLink,
} from './book-ai-workflow/book-ai-workflow-test-harness.js';

describe('book AI workflow service', () => {
  it('queues the next graph bootstrap bundle with the previous bundle summary', async () => {
    const insertedJobs: Record<string, unknown>[] = [];
    const linkedJobs: Record<string, unknown>[] = [];
    const workflowUpdates: Record<string, unknown>[] = [];
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const links = [
      bootstrapLink({
        id: '1',
        providerJobId: 'provider_job_bundle_1',
        bundleId: 'bundle_1',
        sequence: 0,
        characterId: 'char_a',
      }),
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflowRow()] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('from library_books')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return {
            rows: [
              {
                normalized_text_hash: 'book_hash',
                total_chapters: 2,
                total_characters: 24000,
                total_paragraphs: 6,
                updated_at: '2026-07-07T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('from chapters c')) {
          expect(params).toEqual(['book_1', 'user_test', ['chapter_2']]);
          return {
            rows: [
              {
                id: 'chapter_2',
                text_hash: 'chapter_hash_2',
                updated_at: '2026-07-07T00:00:00.000Z',
                paragraph_count: 3,
                character_count: 12000,
              },
            ],
          };
        }
        if (sql.includes('from provider_jobs') && sql.includes('where book_id = $1')) return { rows: [] };
        if (sql.includes('insert into provider_jobs')) {
          const row = {
            id: params?.[0],
            user_id: params?.[1],
            book_id: params?.[2],
            chapter_id: params?.[3],
            job_type: params?.[4],
            provider_id: params?.[5],
            model_id: params?.[6],
            input_hash: params?.[7],
            status: 'queued',
            progress: JSON.parse(String(params?.[8])),
          };
          insertedJobs.push(row);
          return { rows: [{ id: row.id, status: row.status }] };
        }
        if (sql.includes('insert into book_ai_workflow_jobs')) {
          linkedJobs.push({
            workflow_id: params?.[1],
            provider_job_id: params?.[2],
            stage: params?.[3],
            plan_item_id: params?.[4],
            sequence: params?.[5],
          });
          return { rows: [] };
        }
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({ status: params?.[2], stage: params?.[3], progress: JSON.parse(String(params?.[4])) });
          return { rows: [] };
        }
        if (sql.includes('select payload from character_')) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    await advanceBookAIWorkflow(providerAttemptAwarePool(pool), testConfig(), queue, 'workflow_1');

    expect(insertedJobs).toHaveLength(1);
    expect(insertedJobs[0]).toMatchObject({
      book_id: 'book_1',
      chapter_id: null,
      job_type: 'character_bundle_analysis',
      provider_id: 'mock',
      status: 'queued',
    });
    expect(insertedJobs[0].progress).toMatchObject({
      sourceContext: {
        workflowId: 'workflow_1',
        workflowStage: 'character_graph_bootstrap',
        bundleId: 'bundle_2',
        planWindowId: 'bundle_2',
        sequence: 1,
        chapterIds: ['chapter_2'],
        previousBundleId: 'bundle_1',
        previousBundleJobId: 'provider_job_bundle_1',
        summary: 'bundle_1 summary',
      },
    });
    expect(linkedJobs).toEqual([
      expect.objectContaining({
        stage: 'character_graph_bootstrap',
        plan_item_id: 'bundle_2',
        sequence: 1,
      }),
    ]);
    expect(workflowUpdates.at(-1)).toMatchObject({
      stage: 'building_graph',
      progress: expect.objectContaining({
        queuedGraphBootstrapJobs: 1,
        nextGraphBootstrapJob: expect.objectContaining({
          previousBundleJobId: 'provider_job_bundle_1',
          hasPreviousBundleSummary: true,
        }),
      }),
    });
    expectProviderAttemptEnqueued(queue, String(insertedJobs[0].id));
  });

  it('continues advancing when a newly linked graph bootstrap job is already succeeded', async () => {
    const basePlan = workflowPlan();
    const plan = {
      ...basePlan,
      totalChapters: 1,
      totalCharacters: 12000,
      stages: [
        { id: 'character_graph_bootstrap', itemIds: ['bundle_1'] },
        { id: 'chapter_labeling', dependsOn: 'character_graph_bootstrap', itemIds: ['window_1'] },
        { id: 'tts_ready_preparation', dependsOn: 'chapter_labeling', itemIds: ['chapter_1'] },
      ],
      bundleWindows: [basePlan.bundleWindows[0]],
      labelingChapters: [basePlan.labelingChapters[0]],
      labelingWindows: [basePlan.labelingWindows[0]],
      ttsReady: {
        chapterIds: ['chapter_1'],
        dependsOnLabelingWindowIds: ['window_1'],
      },
    } satisfies BookAIWorkflowPlan;
    const insertedJobs: Record<string, unknown>[] = [];
    const linkedJobs: Record<string, unknown>[] = [];
    const links: Record<string, unknown>[] = [];
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const cachedBootstrapProgress = {
      providerOptions: { requestProfileId: 'chapter-labeling-v1-strict-tts' },
      sourceContext: { bundleId: 'bundle_1', chapterIds: ['chapter_1'] },
      bundleSummaryForNext: 'bundle_1 summary',
      discoveredGraph: {
        novelId: 'book_1',
        characters: [
          {
            id: 'char_cached',
            novelId: 'book_1',
            canonicalName: 'Cached',
            aliases: [],
            color: '#3b82f6',
            confidence: 0.8,
            isUserConfirmed: false,
          },
        ],
        relations: [],
      },
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1'))
          return { rows: [workflowRow(plan)] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('from library_books')) {
          return {
            rows: [
              {
                normalized_text_hash: 'book_hash',
                total_chapters: 1,
                total_characters: 12000,
                total_paragraphs: 3,
                updated_at: '2026-07-07T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('from chapters c')) {
          return {
            rows: [
              {
                id: 'chapter_1',
                text_hash: 'chapter_hash_1',
                updated_at: '2026-07-07T00:00:00.000Z',
                paragraph_count: 3,
                character_count: 12000,
              },
            ],
          };
        }
        if (sql.includes('from provider_jobs') && sql.includes('where book_id = $1')) {
          if (params?.[2] === 'character_bundle_analysis') {
            return {
              rows: [
                {
                  provider_job_id: 'provider_job_bundle_cached',
                  job_type: 'character_bundle_analysis',
                  provider_id: 'mock',
                  model_id: 'mock-segment-labeler-v1',
                  input_hash: 'cached_bundle_hash',
                  status: 'succeeded',
                  progress: cachedBootstrapProgress,
                  error_code: null,
                  error_message: null,
                },
              ],
            };
          }
          return { rows: [] };
        }
        if (sql.includes('insert into provider_jobs')) {
          const row = {
            id: params?.[0],
            job_type: params?.[4],
            status: 'queued',
            progress: JSON.parse(String(params?.[8])),
          };
          insertedJobs.push(row);
          return { rows: [{ id: row.id, status: row.status }] };
        }
        if (sql.includes('insert into book_ai_workflow_jobs')) {
          const providerJobId = String(params?.[2]);
          const stage = String(params?.[3]);
          const link = {
            id: params?.[0],
            workflow_id: params?.[1],
            provider_job_id: providerJobId,
            stage,
            plan_item_id: params?.[4],
            sequence: params?.[5],
            job_type: stage === 'character_graph_merge' ? 'character_graph_merge' : 'character_bundle_analysis',
            provider_id: 'mock',
            model_id: 'mock-segment-labeler-v1',
            input_hash: stage === 'character_graph_merge' ? 'merge_hash' : 'cached_bundle_hash',
            status: providerJobId === 'provider_job_bundle_cached' ? 'succeeded' : 'queued',
            progress: providerJobId === 'provider_job_bundle_cached' ? cachedBootstrapProgress : {},
            error_code: null,
            error_message: null,
          };
          linkedJobs.push(link);
          links.push(link);
          return { rows: [] };
        }
        if (sql.includes('update book_ai_workflows')) return { rows: [] };
        if (sql.includes('select payload from character_')) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    await advanceBookAIWorkflow(providerAttemptAwarePool(pool), testConfig(), queue, 'workflow_1');

    expect(linkedJobs.map((job) => job.stage)).toEqual(['character_graph_bootstrap', 'character_graph_merge']);
    expect(insertedJobs).toEqual([expect.objectContaining({ job_type: 'character_graph_merge' })]);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expectProviderAttemptEnqueued(queue, String(insertedJobs[0].id));
  });

  it('enqueues a graph merge job after graph bootstrap bundle jobs succeed', async () => {
    const insertedJobs: Record<string, unknown>[] = [];
    const linkedJobs: Record<string, unknown>[] = [];
    const workflowUpdates: Record<string, unknown>[] = [];
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const links = [
      bootstrapLink({
        id: '1',
        providerJobId: 'provider_job_bundle_1',
        bundleId: 'bundle_1',
        sequence: 0,
        characterId: 'char_a',
      }),
      bootstrapLink({
        id: '2',
        providerJobId: 'provider_job_bundle_2',
        bundleId: 'bundle_2',
        sequence: 1,
        characterId: 'char_b',
      }),
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) {
          expect(params).toEqual(['workflow_1', 'user_test']);
          return { rows: [workflowRow()] };
        }
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('from provider_jobs') && sql.includes('where book_id = $1')) return { rows: [] };
        if (sql.includes('insert into provider_jobs')) {
          const row = {
            id: params?.[0],
            user_id: params?.[1],
            book_id: params?.[2],
            chapter_id: params?.[3],
            job_type: params?.[4],
            provider_id: params?.[5],
            model_id: params?.[6],
            input_hash: params?.[7],
            status: 'queued',
            progress: JSON.parse(String(params?.[8])),
          };
          insertedJobs.push(row);
          return { rows: [{ id: row.id, status: row.status }] };
        }
        if (sql.includes('insert into book_ai_workflow_jobs')) {
          linkedJobs.push({
            id: params?.[0],
            workflow_id: params?.[1],
            provider_job_id: params?.[2],
            stage: params?.[3],
            plan_item_id: params?.[4],
            sequence: params?.[5],
          });
          return { rows: [] };
        }
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({ status: params?.[2], stage: params?.[3], progress: JSON.parse(String(params?.[4])) });
          return { rows: [] };
        }
        if (sql.includes('select payload from character_')) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    await advanceBookAIWorkflow(providerAttemptAwarePool(pool), testConfig(), queue, 'workflow_1');

    expect(insertedJobs).toHaveLength(1);
    expect(insertedJobs[0]).toMatchObject({
      book_id: 'book_1',
      chapter_id: null,
      job_type: 'character_graph_merge',
      provider_id: 'mock',
      status: 'queued',
    });
    expect(insertedJobs[0].progress).toMatchObject({
      sourceContext: expect.objectContaining({
        workflowId: 'workflow_1',
        workflowStage: 'character_graph_merge',
        sourceBundleJobIds: ['provider_job_bundle_1', 'provider_job_bundle_2'],
      }),
    });
    expect(linkedJobs).toEqual([
      expect.objectContaining({
        workflow_id: 'workflow_1',
        provider_job_id: insertedJobs[0].id,
        stage: 'character_graph_merge',
        plan_item_id: 'character_graph_merge',
        sequence: 0,
      }),
    ]);
    expect(workflowUpdates.at(-1)).toMatchObject({ stage: 'merging_graph' });
    expectProviderAttemptEnqueued(queue, String(insertedJobs[0].id));
  });

  it('enqueues the first graph-aware chapter labeling job after graph merge succeeds', async () => {
    const insertedJobs: Record<string, unknown>[] = [];
    const linkedJobs: Record<string, unknown>[] = [];
    const workflowUpdates: Record<string, unknown>[] = [];
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const links = [
      bootstrapLink({
        id: '1',
        providerJobId: 'provider_job_bundle_1',
        bundleId: 'bundle_1',
        sequence: 0,
        characterId: 'char_a',
      }),
      bootstrapLink({
        id: '2',
        providerJobId: 'provider_job_bundle_2',
        bundleId: 'bundle_2',
        sequence: 1,
        characterId: 'char_b',
      }),
      {
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
      },
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflowRow()] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('from chapters c')) {
          expect(params).toEqual(['book_1', 'user_test', ['chapter_1']]);
          return {
            rows: [
              {
                id: 'chapter_1',
                text_hash: 'chapter_hash_1',
                updated_at: '2026-07-07T00:00:00.000Z',
                paragraph_count: 3,
                character_count: 12000,
              },
            ],
          };
        }
        if (sql.includes('from provider_jobs') && sql.includes('where book_id = $1')) return { rows: [] };
        if (sql.includes('insert into provider_jobs')) {
          const row = {
            id: params?.[0],
            user_id: params?.[1],
            book_id: params?.[2],
            chapter_id: params?.[3],
            job_type: params?.[4],
            provider_id: params?.[5],
            model_id: params?.[6],
            input_hash: params?.[7],
            status: 'queued',
            progress: JSON.parse(String(params?.[8])),
          };
          insertedJobs.push(row);
          return { rows: [{ id: row.id, status: row.status }] };
        }
        if (sql.includes('insert into book_ai_workflow_jobs')) {
          linkedJobs.push({
            workflow_id: params?.[1],
            provider_job_id: params?.[2],
            stage: params?.[3],
            plan_item_id: params?.[4],
            sequence: params?.[5],
          });
          return { rows: [] };
        }
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({ status: params?.[2], stage: params?.[3], progress: JSON.parse(String(params?.[4])) });
          return { rows: [] };
        }
        if (sql.includes('select payload from character_')) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    await advanceBookAIWorkflow(providerAttemptAwarePool(pool), testConfig(), queue, 'workflow_1');

    expect(insertedJobs).toHaveLength(1);
    expect(insertedJobs.map((job) => job.job_type)).toEqual(['chapter_segment_labeling']);
    expect(insertedJobs.map((job) => job.chapter_id)).toEqual(['chapter_1']);
    expect(insertedJobs[0].progress).toMatchObject({
      sourceContext: {
        workflowId: 'workflow_1',
        workflowStage: 'chapter_labeling',
        graphMergeJobId: 'provider_job_merge',
        chapterId: 'chapter_1',
        planWindowId: 'window_1',
        labelingWindowId: 'window_1',
        paragraphIds: ['p1'],
        coversFullChapter: true,
      },
      budgetEstimate: {
        planItemId: 'window_1',
        labelingWindowId: 'window_1',
        paragraphCount: 1,
      },
    });
    expect(linkedJobs.map((job) => job.stage)).toEqual(['chapter_labeling']);
    expect(linkedJobs.map((job) => job.plan_item_id)).toEqual(['window_1']);
    expect(workflowUpdates.at(-1)).toMatchObject({
      stage: 'labeling_chapters',
      progress: expect.objectContaining({
        totalLabelingChapters: 2,
        totalLabelingWindows: 2,
        queuedLabelingJobs: 1,
        queuedLabelingWindowIds: ['window_1'],
      }),
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('enqueues the next split-chapter labeling window after the previous window succeeds', async () => {
    const windowA = {
      id: 'window_1a',
      sequence: 0,
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphIds: ['p1'],
      startParagraphIndex: 0,
      endParagraphIndex: 0,
      characterCount: 6000,
      textHashFingerprint: 'window_hash_1a',
      dependsOnGraph: true as const,
    };
    const windowB = {
      id: 'window_1b',
      sequence: 1,
      chapterId: 'chapter_1',
      chapterIndex: 1,
      paragraphIds: ['p2'],
      startParagraphIndex: 1,
      endParagraphIndex: 1,
      characterCount: 6000,
      textHashFingerprint: 'window_hash_1b',
      dependsOnGraph: true as const,
    };
    const splitPlan: BookAIWorkflowPlan = {
      ...workflowPlan(),
      totalChapters: 1,
      totalCharacters: 12000,
      stages: [
        { id: 'character_graph_bootstrap', itemIds: ['bundle_1'] },
        { id: 'chapter_labeling', dependsOn: 'character_graph_bootstrap', itemIds: ['window_1a', 'window_1b'] },
        { id: 'tts_ready_preparation', dependsOn: 'chapter_labeling', itemIds: ['chapter_1'] },
      ],
      bundleWindows: [workflowPlan().bundleWindows[0]],
      labelingChapters: [
        {
          chapterId: 'chapter_1',
          chapterIndex: 1,
          textHash: 'chapter_hash_1',
          dependsOnGraph: true,
          windows: [windowA, windowB],
        },
      ],
      labelingWindows: [windowA, windowB],
      ttsReady: {
        chapterIds: ['chapter_1'],
        dependsOnLabelingWindowIds: ['window_1a', 'window_1b'],
      },
    };
    const insertedJobs: Record<string, unknown>[] = [];
    const linkedJobs: Record<string, unknown>[] = [];
    const workflowUpdates: Record<string, unknown>[] = [];
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const links = [
      bootstrapLink({
        id: '1',
        providerJobId: 'provider_job_bundle_1',
        bundleId: 'bundle_1',
        sequence: 0,
        characterId: 'char_a',
      }),
      {
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
      },
      {
        id: 'link_window_1a',
        workflow_id: 'workflow_1',
        provider_job_id: 'provider_job_label_1a',
        stage: 'chapter_labeling',
        plan_item_id: 'window_1a',
        sequence: 0,
        job_type: 'chapter_segment_labeling',
        provider_id: 'mock',
        model_id: 'mock-segment-labeler-v1',
        input_hash: 'label_hash_1a',
        status: 'succeeded',
        error_code: null,
        error_message: null,
        progress: {},
      },
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1'))
          return { rows: [workflowRow(splitPlan)] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('from chapters c')) {
          expect(params).toEqual(['book_1', 'user_test', ['chapter_1']]);
          return {
            rows: [
              {
                id: 'chapter_1',
                text_hash: 'chapter_hash_1',
                updated_at: '2026-07-07T00:00:00.000Z',
                paragraph_count: 2,
                character_count: 12000,
              },
            ],
          };
        }
        if (sql.includes('from provider_jobs') && sql.includes('where book_id = $1')) return { rows: [] };
        if (sql.includes('insert into provider_jobs')) {
          const row = {
            id: params?.[0],
            book_id: params?.[2],
            chapter_id: params?.[3],
            job_type: params?.[4],
            input_hash: params?.[7],
            status: 'queued',
            progress: JSON.parse(String(params?.[8])),
          };
          insertedJobs.push(row);
          return { rows: [{ id: row.id, status: row.status }] };
        }
        if (sql.includes('insert into book_ai_workflow_jobs')) {
          linkedJobs.push({
            provider_job_id: params?.[2],
            stage: params?.[3],
            plan_item_id: params?.[4],
            sequence: params?.[5],
          });
          return { rows: [] };
        }
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({ status: params?.[2], stage: params?.[3], progress: JSON.parse(String(params?.[4])) });
          return { rows: [] };
        }
        if (sql.includes('select payload from character_')) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    await advanceBookAIWorkflow(providerAttemptAwarePool(pool), testConfig(), queue, 'workflow_1');

    expect(insertedJobs).toHaveLength(1);
    expect(insertedJobs.map((job) => job.chapter_id)).toEqual(['chapter_1']);
    expect(insertedJobs.map((job) => (job.progress as Record<string, unknown>).sourceContext)).toEqual([
      expect.objectContaining({ labelingWindowId: 'window_1b', paragraphIds: ['p2'], coversFullChapter: false }),
    ]);
    expect(
      insertedJobs.map(
        (job) => (job.progress as { budgetEstimate: Record<string, unknown> }).budgetEstimate.inputCharacters,
      ),
    ).toEqual([6000]);
    expect(linkedJobs.map((job) => job.plan_item_id)).toEqual(['window_1b']);
    expect(workflowUpdates.at(-1)).toMatchObject({
      stage: 'labeling_chapters',
      progress: expect.objectContaining({
        totalLabelingChapters: 1,
        totalLabelingWindows: 2,
        queuedLabelingJobs: 1,
        queuedLabelingWindowIds: ['window_1b'],
      }),
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
