import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import pg from 'pg';
import {
  advanceBookAIWorkflow,
  reconcileTerminalBookAIWorkflowProviderJobs,
  resumeBookAIWorkflow,
} from '../book-ai-workflow-service.js';
import {
  testConfig,
  providerAttemptAwarePool,
  expectProviderAttemptEnqueued,
  workflowRow,
  bootstrapLink,
  mergeLink,
  labelingLink,
} from './book-ai-workflow-test-harness.js';

describe('book AI workflow service', () => {
  it('moves failed workflow children into resumable needs_review state', async () => {
    const workflowUpdates: Record<string, unknown>[] = [];
    const bookUpdates: Record<string, unknown>[] = [];
    const failedLink = {
      id: 'link_window_1',
      workflow_id: 'workflow_1',
      provider_job_id: 'provider_job_label_failed',
      stage: 'chapter_labeling',
      plan_item_id: 'window_1',
      sequence: 0,
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'label_hash',
      status: 'failed',
      error_code: 'validation_failed',
      error_message: 'Sparse labels',
      progress: {},
    };
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
        progress: {},
      },
      failedLink,
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflowRow()] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({
            workflowId: params?.[0],
            status: params?.[2],
            stage: params?.[3],
            progress: JSON.parse(String(params?.[4])),
            errorCode: params?.[5],
            errorMessage: params?.[6],
            finished: params?.[7],
          });
          return { rows: [] };
        }
        if (sql.includes('update library_books')) {
          bookUpdates.push({ status: params?.[0], bookId: params?.[1], userId: params?.[2] });
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    await advanceBookAIWorkflow(pool, testConfig(), undefined, 'workflow_1');

    expect(workflowUpdates).toEqual([
      expect.objectContaining({
        status: 'needs_review',
        stage: 'needs_review',
        errorCode: 'validation_failed',
        errorMessage: 'Sparse labels',
        finished: false,
        progress: expect.objectContaining({
          failedProviderJobId: 'provider_job_label_failed',
          failedStage: 'chapter_labeling',
          failedPlanItemId: 'window_1',
          failedJobType: 'chapter_segment_labeling',
          workflowReviewTargets: [
            expect.objectContaining({
              kind: 'failed_child_job',
              providerJobId: 'provider_job_label_failed',
              planItemId: 'window_1',
              recommendedAction: 'inspect_failed_job',
            }),
          ],
        }),
      }),
    ]);
    expect(bookUpdates).toEqual([{ status: 'needs_review', bookId: 'book_1', userId: 'user_test' }]);
  });

  it('reconciles terminal linked provider jobs left behind after worker restart', async () => {
    const workflowUpdates: Record<string, unknown>[] = [];
    const bookUpdates: Record<string, unknown>[] = [];
    const failedLink = {
      ...bootstrapLink({
        id: '1',
        providerJobId: 'provider_job_failed',
        bundleId: 'bundle_1',
        sequence: 0,
        characterId: 'char_a',
      }),
      status: 'failed',
      error_code: 'provider_error_schema',
      error_message: 'Provider result failed validation',
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('select distinct wj.provider_job_id')) {
          expect(params).toEqual(['user_test']);
          return { rowCount: 1, rows: [{ provider_job_id: 'provider_job_failed' }] };
        }
        if (sql.includes('select distinct wj.workflow_id')) {
          expect(params).toEqual(['provider_job_failed', 'user_test']);
          return { rows: [{ workflow_id: 'workflow_1' }] };
        }
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflowRow()] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: [failedLink] };
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({
            workflowId: params?.[0],
            status: params?.[2],
            stage: params?.[3],
            progress: JSON.parse(String(params?.[4])),
            errorCode: params?.[5],
            errorMessage: params?.[6],
          });
          return { rows: [] };
        }
        if (sql.includes('update library_books')) {
          bookUpdates.push({ status: params?.[0], bookId: params?.[1], userId: params?.[2] });
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    await expect(reconcileTerminalBookAIWorkflowProviderJobs(pool, testConfig(), undefined)).resolves.toBe(1);

    expect(workflowUpdates).toEqual([
      expect.objectContaining({
        workflowId: 'workflow_1',
        status: 'needs_review',
        stage: 'needs_review',
        errorCode: 'provider_error_schema',
        errorMessage: 'Provider result failed validation',
        progress: expect.objectContaining({
          failedProviderJobId: 'provider_job_failed',
          workflowReviewTargets: [
            expect.objectContaining({
              kind: 'failed_child_job',
              providerJobId: 'provider_job_failed',
            }),
          ],
        }),
      }),
    ]);
    expect(bookUpdates).toEqual([{ status: 'needs_review', bookId: 'book_1', userId: 'user_test' }]);
  });

  it('requeues failed workflow children when a needs_review workflow is retried', async () => {
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const workflow = {
      ...workflowRow(),
      status: 'needs_review',
      stage: 'needs_review',
      progress: {
        failedProviderJobId: 'provider_job_label_failed',
        failedStage: 'chapter_labeling',
        failedPlanItemId: 'window_1',
        workflowReviewTargets: [
          {
            id: 'failed_child_job:provider_job_label_failed',
            kind: 'failed_child_job',
            providerJobId: 'provider_job_label_failed',
            planItemId: 'window_1',
            repairMode: 'auto_repair_on_validation_failure',
          },
        ],
      },
    };
    const links = [
      {
        id: 'link_window_1',
        workflow_id: 'workflow_1',
        provider_job_id: 'provider_job_label_failed',
        stage: 'chapter_labeling',
        plan_item_id: 'window_1',
        sequence: 0,
        job_type: 'chapter_segment_labeling',
        provider_id: 'mock',
        model_id: 'mock-segment-labeler-v1',
        input_hash: 'label_hash',
        status: 'failed',
        error_code: 'validation_failed',
        error_message: 'Sparse labels',
        progress: {},
      },
    ];
    const workflowUpdates: Record<string, unknown>[] = [];
    const providerJobUpdates: Record<string, unknown>[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflow] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({
            workflowId: params?.[0],
            userId: params?.[1],
            failedStage: params?.[2],
            progress: JSON.parse(String(params?.[3])),
          });
          workflow.status = 'running';
          workflow.stage = 'labeling_chapters';
          return { rows: [] };
        }
        if (sql.includes('update provider_jobs')) {
          providerJobUpdates.push({
            providerJobId: params?.[0],
            userId: params?.[1],
            retry: JSON.parse(String(params?.[2])),
          });
          links[0].status = 'queued';
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    const resumed = await resumeBookAIWorkflow(providerAttemptAwarePool(pool), testConfig(), queue, 'workflow_1');

    expect(resumed?.row.status).toBe('running');
    expect(workflowUpdates).toEqual([
      expect.objectContaining({
        failedStage: 'chapter_labeling',
        progress: expect.objectContaining({
          retryCount: 1,
          retriedProviderJobIds: ['provider_job_label_failed'],
          retriedReviewTargetIds: ['failed_child_job:provider_job_label_failed'],
          retryTransition: 'retry_same_request',
        }),
      }),
    ]);
    expect(workflowUpdates[0]?.progress).not.toHaveProperty('workflowReviewTargets');
    expect(providerJobUpdates).toEqual([
      expect.objectContaining({
        providerJobId: 'provider_job_label_failed',
        retry: expect.objectContaining({
          workflowId: 'workflow_1',
          retryCount: 1,
          transition: 'retry_same_request',
        }),
      }),
    ]);
    expectProviderAttemptEnqueued(queue, 'provider_job_label_failed');
  });

  it('does not resume or retry a workflow while a linked manual review is unresolved', async () => {
    const queue = {
      add: vi.fn(),
    } as unknown as Queue;
    const workflow = {
      ...workflowRow(),
      status: 'needs_review',
      stage: 'needs_review',
    };
    const reviewedLink = {
      ...labelingLink({
        id: 'window_1',
        providerJobId: 'provider_job_label_review',
        windowId: 'window_1',
        sequence: 0,
        status: 'succeeded',
      }),
      progress: {
        manualReview: { status: 'open', reviewArtifactId: 'review_1' },
      },
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflow] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: [reviewedLink] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    const resumed = await resumeBookAIWorkflow(pool, testConfig(), queue, 'workflow_1');

    expect(resumed).toEqual({ row: workflow, links: [reviewedLink] });
    expect(workflow.status).toBe('needs_review');
    expect(queue.add).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('allows generic resume after the linked manual review was promoted', async () => {
    const queue = {
      add: vi.fn(),
    } as unknown as Queue;
    const workflow = {
      ...workflowRow(),
      status: 'needs_review',
      stage: 'needs_review',
    };
    const pendingBootstrap = {
      ...bootstrapLink({
        id: 'pending_bundle',
        providerJobId: 'provider_job_bundle_pending',
        bundleId: 'bundle_1',
        sequence: 0,
        characterId: 'character_a',
      }),
      status: 'running',
    };
    const promotedReview = {
      ...labelingLink({
        id: 'window_1',
        providerJobId: 'provider_job_label_review',
        windowId: 'window_1',
        sequence: 0,
        status: 'succeeded',
      }),
      progress: {
        manualReview: { status: 'promoted', reviewArtifactId: 'review_1' },
      },
    };
    const links = [pendingBootstrap, promotedReview];
    const workflowUpdates: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflow] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push(sql);
          workflow.status = 'running';
          workflow.stage = 'building_graph';
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    const resumed = await resumeBookAIWorkflow(pool, testConfig(), queue, 'workflow_1');

    expect(resumed?.row.status).toBe('running');
    expect(workflowUpdates).toHaveLength(2);
    expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('update provider_jobs'), expect.anything());
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('requeues labeling windows that contain missing planned paragraphs on retry', async () => {
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const workflow = {
      ...workflowRow(),
      status: 'needs_review',
      stage: 'needs_review',
      progress: {
        failedStage: 'tts_ready_verification',
        ttsReadiness: {
          ok: false,
          errorCode: 'tts_readiness_missing_paragraphs',
          missingPlannedParagraphIds: ['p2'],
          metrics: {
            missingPlannedParagraphCount: 1,
          },
        },
      },
    };
    const links = [
      mergeLink(),
      labelingLink({
        id: 'window_1',
        providerJobId: 'provider_job_label_1',
        windowId: 'window_1',
        sequence: 0,
        status: 'succeeded',
      }),
      labelingLink({
        id: 'window_2',
        providerJobId: 'provider_job_label_2',
        windowId: 'window_2',
        sequence: 1,
        status: 'succeeded',
      }),
    ];
    const workflowUpdates: Record<string, unknown>[] = [];
    const providerJobUpdates: Record<string, unknown>[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflow] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('update book_ai_workflows')) {
          const nextProgress = JSON.parse(String(params?.[3]));
          workflowUpdates.push({
            workflowId: params?.[0],
            userId: params?.[1],
            failedStage: params?.[2],
            progress: nextProgress,
          });
          workflow.status = 'running';
          workflow.stage = 'labeling_chapters';
          workflow.progress = nextProgress;
          return { rows: [] };
        }
        if (sql.includes('update provider_jobs')) {
          providerJobUpdates.push({
            providerJobId: params?.[0],
            userId: params?.[1],
            retry: JSON.parse(String(params?.[2])),
          });
          const link = links.find((item) => item.provider_job_id === params?.[0]);
          if (link) link.status = 'queued';
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    const resumed = await resumeBookAIWorkflow(providerAttemptAwarePool(pool), testConfig(), queue, 'workflow_1');

    expect(resumed?.row.status).toBe('running');
    expect(workflowUpdates).toEqual([
      expect.objectContaining({
        failedStage: 'chapter_labeling',
        progress: expect.objectContaining({
          retryCount: 1,
          retryReason: 'missing_planned_paragraph_labels',
          retryTransition: 'retry_same_request',
          retriedProviderJobIds: ['provider_job_label_2'],
          retriedLabelingWindowIds: ['window_2'],
        }),
      }),
    ]);
    expect(providerJobUpdates).toEqual([
      expect.objectContaining({
        providerJobId: 'provider_job_label_2',
        retry: expect.objectContaining({
          workflowId: 'workflow_1',
          retryCount: 1,
          transition: 'retry_same_request',
        }),
      }),
    ]);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expectProviderAttemptEnqueued(queue, 'provider_job_label_2');
  });

  it('retries only the failed repair child while leaving its failed labeling parent immutable', async () => {
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const workflow = {
      ...workflowRow(),
      status: 'needs_review',
      stage: 'needs_review',
      progress: {
        failedProviderJobId: 'provider_job_repair_1',
        failedStage: 'chapter_label_repair',
      },
    };
    const links = [
      {
        ...labelingLink({
          id: 'window_1',
          providerJobId: 'provider_job_label_failed',
          windowId: 'window_1',
          sequence: 0,
          status: 'failed',
        }),
        error_code: 'provider_error_schema',
      },
      {
        id: 'link_repair_1',
        workflow_id: 'workflow_1',
        provider_job_id: 'provider_job_repair_1',
        stage: 'chapter_label_repair',
        plan_item_id: 'repair:window_1:candidate_1',
        sequence: 0,
        job_type: 'chapter_label_repair',
        provider_id: 'mock',
        model_id: 'mock-segment-labeler-v1',
        input_hash: 'repair_hash_1',
        status: 'failed',
        progress: { sourceContext: { labelingWindowId: 'window_1' } },
        error_code: 'provider_error_schema',
        error_message: 'Repair output remained invalid.',
        current_attempt_id: null,
      },
    ];
    const retriedJobIds: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflow] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('update book_ai_workflows')) {
          workflow.status = 'running';
          workflow.stage = 'labeling_chapters';
          workflow.progress = JSON.parse(String(params?.[3]));
          return { rows: [] };
        }
        if (sql.includes('update provider_jobs')) {
          retriedJobIds.push(String(params?.[0]));
          links[1].status = 'queued';
          return { rows: [{ id: params?.[0] }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    const resumed = await resumeBookAIWorkflow(providerAttemptAwarePool(pool), testConfig(), queue, 'workflow_1');

    expect(resumed?.row.status).toBe('running');
    expect(retriedJobIds).toEqual(['provider_job_repair_1']);
    expect(links[0].status).toBe('failed');
    expect(workflow.progress).toMatchObject({
      retryTransition: 'retry_same_request',
      retriedProviderJobIds: ['provider_job_repair_1'],
      retriedLabelingWindowIds: ['window_1'],
    });
    expectProviderAttemptEnqueued(queue, 'provider_job_repair_1');
  });
});
