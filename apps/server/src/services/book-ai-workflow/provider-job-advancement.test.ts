import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import pg from 'pg';
import { advanceBookAIWorkflow, advanceBookAIWorkflowsForProviderJob } from '../book-ai-workflow-service.js';
import { pinChapterLabelingInput } from './analysis-input-builder.js';
import { loadAnalysisInputRevisionForJob } from './analysis-input-repository.js';
import { loadAnalysisArtifact } from './staging-artifact-repository.js';
import { resolveChapterLabelingRequestProfile } from '../../../../../src/providers/chapter-labeling-request-profile';
import { characterGraphIntegrityHash } from '@noveldesk/text-core/identity/ai';
import { segmentTextIntegrityHash } from '../../../../../src/domain/identity/ai-identities';
import type { ChapterLabelingResult } from '../../../../../src/providers/ai';
import type { BookAIWorkflowRow } from './workflow-contracts.js';
import type { ProviderJobRow } from '../provider-jobs/contracts.js';
import { processChapterLabelingJob } from '../provider-jobs/chapter-labeling-handler.js';
import {
  AnalysisReviewConflictError,
  listWorkflowAnalysisReviews,
  saveChapterLabelReviewDraft,
} from './analysis-review-service.js';
import { approveAnalysisReview } from './analysis-review-promotion-service.js';
import {
  testConfig,
  providerAttemptAwarePool,
  expectProviderAttemptEnqueued,
  workflowRow,
  workflowPlan,
  bootstrapLink,
  mergeLink,
  labelingLink,
} from './book-ai-workflow-test-harness.js';

describe('book AI workflow service', () => {
  it('advances a linked workflow after a labeling provider job finishes and queues the next planned window', async () => {
    const insertedJobs: Record<string, unknown>[] = [];
    const linkedJobs: Record<string, unknown>[] = [];
    const workflowUpdates: Record<string, unknown>[] = [];
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const links: Record<string, unknown>[] = [
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
      mergeLink(),
      labelingLink({
        id: 'window_1',
        providerJobId: 'provider_job_label_1',
        windowId: 'window_1',
        sequence: 0,
        status: 'succeeded',
      }),
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('select distinct wj.workflow_id')) {
          expect(params).toEqual(['provider_job_label_1', 'user_test']);
          return { rows: [{ workflow_id: 'workflow_1' }] };
        }
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflowRow()] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('join book_content_revisions content')) {
          const graph = { novelId: 'book_1', characters: [], relations: [] };
          return {
            rows: [
              {
                id: 'book_1',
                user_id: 'user_test',
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
        if (sql.trim().startsWith('update provider_jobs')) return { rowCount: 1, rows: [] };
        if (sql.includes('insert into book_ai_workflow_jobs')) {
          const linked = {
            id: `link_${params?.[2]}`,
            workflow_id: params?.[1],
            provider_job_id: params?.[2],
            stage: params?.[3],
            plan_item_id: params?.[4],
            sequence: params?.[5],
            job_type: 'chapter_segment_labeling',
            provider_id: 'mock',
            model_id: 'mock-segment-labeler-v1',
            input_hash: 'label_hash_2',
            status: 'queued',
            error_code: null,
            error_message: null,
            progress: insertedJobs.at(-1)?.progress ?? {},
          };
          linkedJobs.push(linked);
          links.push(linked);
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

    await advanceBookAIWorkflowsForProviderJob(
      providerAttemptAwarePool(pool),
      testConfig(),
      queue,
      'provider_job_label_1',
    );

    expect(insertedJobs).toHaveLength(1);
    expect(insertedJobs[0]).toMatchObject({
      chapter_id: 'chapter_2',
      job_type: 'chapter_segment_labeling',
    });
    expect(insertedJobs[0].progress).toMatchObject({
      sourceContext: expect.objectContaining({
        labelingWindowId: 'window_2',
        paragraphIds: ['p2'],
      }),
      budgetEstimate: expect.objectContaining({
        planItemId: 'window_2',
        labelingWindowId: 'window_2',
      }),
    });
    expect(linkedJobs).toEqual([
      expect.objectContaining({
        workflow_id: 'workflow_1',
        stage: 'chapter_labeling',
        plan_item_id: 'window_2',
        sequence: 1,
      }),
    ]);
    expect(workflowUpdates.at(-1)).toMatchObject({
      stage: 'labeling_chapters',
      progress: expect.objectContaining({
        queuedLabelingWindowIds: ['window_2'],
      }),
    });
    expectProviderAttemptEnqueued(queue, String(insertedJobs[0].id));
  });

  it('creates a separate immutable repair child for a failed pinned labeling candidate', async () => {
    const queue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const workflow = workflowRow() as unknown as BookAIWorkflowRow;
    const plan = workflow.plan as ReturnType<typeof workflowPlan>;
    const parentJob: ProviderJobRow = {
      id: 'provider_job_label_failed',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_provider_job_label_failed',
      status: 'running',
      progress: {},
    };
    const insertedJobs: Record<string, unknown>[] = [];
    const artifacts = new Map<string, Record<string, unknown>>();
    const links: Record<string, unknown>[] = [
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
      mergeLink(),
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('speaker-workflow:ownership')) return { rows: [{ allowed: true }] };
        if (sql.includes('speaker-workflow:load-active-provenance')) return { rows: [] };
        if (sql.includes('speaker-workflow:insert-provenance')) {
          const rows = JSON.parse(String(params?.[1])) as Array<{ id: string }>;
          return { rowCount: rows.length, rows: rows.map(({ id }) => ({ id })) };
        }
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflow] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('from paragraph_search') && sql.includes('where book_id = $1')) {
          const paragraphIds = Array.isArray(params?.[1]) ? params[1].map(String) : [];
          return {
            rows: paragraphIds.map((paragraphId, index) => ({
              paragraph_id: paragraphId,
              chapter_id: 'chapter_1',
              paragraph_index: index,
              text: `Paragraph ${paragraphId}`,
            })),
          };
        }
        if (sql.includes('join book_content_revisions content')) {
          const graph = { novelId: 'book_1', characters: [], relations: [] };
          return {
            rows: [
              {
                id: 'book_1',
                user_id: 'user_test',
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
        if (sql.includes('insert into analysis_staging_artifacts')) {
          const row = {
            id: params?.[0],
            input_revision_id: params?.[1],
            provider_job_id: params?.[2],
            workflow_id: params?.[3],
            book_id: params?.[4],
            chapter_id: params?.[5],
            artifact_type: params?.[6],
            output_hash: params?.[7],
            payload: JSON.parse(String(params?.[8])),
            metadata: JSON.parse(String(params?.[9])),
            expected_content_revision_id: params?.[10],
            expected_graph_revision_id: params?.[11],
            status: 'staged',
            stale_reason: null,
            created_at: '2026-07-11T00:00:00.000Z',
            promoted_at: null,
          };
          artifacts.set(String(row.id), row);
          return { rows: [row] };
        }
        if (sql.includes('from analysis_staging_artifacts where id = $1')) {
          return { rows: [artifacts.get(String(params?.[0]))].filter(Boolean) };
        }
        if (sql.includes('from provider_jobs') && sql.includes('where id = $1 and user_id = $2')) {
          const row = insertedJobs.find((item) => item.id === params?.[0]);
          if (row) return { rows: [{ ...row, status: 'running' }] };
          return { rows: params?.[0] === parentJob.id ? [parentJob] : [] };
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
        if (sql.trim().startsWith('update provider_jobs set') && sql.includes('progress = coalesce(progress')) {
          const progressPatchValue = params?.find((value) => typeof value === 'string' && value.trim().startsWith('{'));
          const progressPatch = JSON.parse(String(progressPatchValue)) as Record<string, unknown>;
          const providerJobId = String(params?.at(-1));
          if (providerJobId === parentJob.id) {
            parentJob.progress = { ...(parentJob.progress as Record<string, unknown>), ...progressPatch };
          }
          const inserted = insertedJobs.find((item) => item.id === providerJobId);
          if (inserted) inserted.progress = { ...(inserted.progress as Record<string, unknown>), ...progressPatch };
          const linked = links.find((item) => item.provider_job_id === providerJobId);
          if (linked) linked.progress = { ...(linked.progress as Record<string, unknown>), ...progressPatch };
          return { rowCount: 1, rows: [] };
        }
        if (
          sql.trim().startsWith('update provider_jobs job') &&
          sql.includes("job.job_type = 'chapter_label_repair'")
        ) {
          const reviewId = String(params?.[1]);
          let rowCount = 0;
          for (const linked of links) {
            if (linked.stage !== 'chapter_label_repair' || !['failed', 'cancelled'].includes(String(linked.status))) {
              continue;
            }
            linked.progress = {
              ...(linked.progress as Record<string, unknown>),
              manualReview: { status: 'superseded', reviewArtifactId: reviewId },
            };
            const inserted = insertedJobs.find((item) => item.id === linked.provider_job_id);
            if (inserted) inserted.progress = linked.progress;
            rowCount += 1;
          }
          return { rowCount, rows: [] };
        }
        if (sql.trim().startsWith('update provider_jobs')) return { rowCount: 1, rows: [] };
        if (sql.includes('insert into book_ai_workflow_jobs')) {
          const job = insertedJobs.at(-1);
          links.push({
            id: params?.[0],
            workflow_id: params?.[1],
            provider_job_id: params?.[2],
            stage: params?.[3],
            plan_item_id: params?.[4],
            sequence: params?.[5],
            job_type: job?.job_type,
            provider_id: job?.provider_id,
            model_id: job?.model_id,
            input_hash: job?.input_hash,
            status: job?.status,
            progress: job?.progress,
            error_code: null,
            error_message: null,
          });
          return { rows: [] };
        }
        if (sql.includes('update book_ai_workflows')) {
          if (sql.includes('manualReviewResume')) {
            workflow.status = 'running';
            workflow.stage = 'labeling_chapters';
          } else if (params?.[2]) {
            workflow.status = String(params[2]) as BookAIWorkflowRow['status'];
            workflow.stage = String(params?.[3] ?? workflow.stage) as BookAIWorkflowRow['stage'];
          }
          return { rows: [] };
        }
        if (sql.includes('select payload from character_')) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const wrappedPool = providerAttemptAwarePool(pool);
    const providerOptions = {
      requestProfileId: 'chapter-labeling-v1-strict-tts',
      autoRepairOnValidationFailure: true,
    };
    const parentRevision = await pinChapterLabelingInput(wrappedPool, {
      workflow,
      job: parentJob,
      plan,
      window: plan.labelingWindows[0],
      providerOptions,
      requestProfile: resolveChapterLabelingRequestProfile(providerOptions),
    });
    if (parentRevision.sourceSnapshot.kind !== 'chapter_labeling') throw new Error('expected labeling source');
    const paragraph = parentRevision.sourceSnapshot.paragraphs[0];
    if (!paragraph) throw new Error('expected pinned paragraph');
    const candidate: ChapterLabelingResult = {
      characters: [],
      segments: [
        {
          id: 'segment_invalid',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          paragraphId: paragraph.id,
          segmentIndex: 0,
          startOffset: 0,
          endOffset: paragraph.text.length,
          segmentTextHash: 'invalid_hash',
          type: 'narration',
          speakerId: 'narrator',
          candidateSpeakers: ['narrator'],
          listenerIds: [],
          emotion: 'neutral',
          confidence: 1,
          isUserCorrected: false,
        },
      ],
    };
    const inlineRepair = vi.fn(async () => candidate);
    await expect(
      processChapterLabelingJob(
        wrappedPool,
        testConfig(),
        parentJob,
        {
          createAIProvider: () => ({
            providerId: 'mock',
            displayName: 'Invalid pinned labeling test',
            labelChapterSegments: vi.fn(async () => candidate),
            repairChapterLabels: inlineRepair,
          }),
        },
        undefined,
        parentRevision,
      ),
    ).rejects.toMatchObject({ name: 'ChapterLabelingValidationError' });
    expect(inlineRepair).not.toHaveBeenCalled();
    const candidateArtifactId = String([...artifacts.keys()][0]);
    const candidateArtifact = await loadAnalysisArtifact(wrappedPool, candidateArtifactId);
    if (!candidateArtifact) throw new Error('expected staged repair candidate');
    expect(candidateArtifact.payload).toEqual(candidate);
    const repairInputFingerprint = String(candidateArtifact.metadata.repairInputFingerprint);
    const pinnedRepairIssues = candidateArtifact.metadata.repairIssues;
    expect(pinnedRepairIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'segment_text_hash_mismatch' })]),
    );
    const reviews = await listWorkflowAnalysisReviews(wrappedPool, workflow.id, workflow.user_id);
    expect(reviews).toEqual([
      expect.objectContaining({
        workflowId: workflow.id,
        providerJobId: parentJob.id,
        stagingArtifactId: candidateArtifact.id,
        status: 'open',
        reviewRevision: 1,
        validationIssues: expect.arrayContaining([expect.objectContaining({ code: 'segment_text_hash_mismatch' })]),
      }),
    ]);
    parentJob.status = 'failed';
    links.push({
      ...labelingLink({
        id: 'window_1',
        providerJobId: parentJob.id,
        windowId: 'window_1',
        sequence: 0,
        status: 'failed',
      }),
      input_hash: parentJob.input_hash,
      analysis_input_revision_id: parentRevision.id,
      error_code: 'provider_error_schema',
      error_message: 'Provider output did not match the expected schema or validation rules.',
      progress: {
        providerOptions,
        sourceContext: { workflowId: workflow.id, labelingWindowId: 'window_1' },
        autoRepair: {
          enabled: true,
          delegated: true,
          candidateArtifactId: candidateArtifact.id,
          repairInputFingerprint,
        },
      },
    });

    await advanceBookAIWorkflow(wrappedPool, testConfig(), queue, workflow.id);

    expect(insertedJobs).toHaveLength(1);
    expect(insertedJobs[0]).toMatchObject({
      job_type: 'chapter_label_repair',
      progress: {
        sourceContext: expect.objectContaining({
          labelingWindowId: 'window_1',
          parentProviderJobId: parentJob.id,
          candidateArtifactId: candidateArtifact.id,
        }),
      },
    });
    const childJobId = String(insertedJobs[0]?.id);
    const childRevision = await loadAnalysisInputRevisionForJob(wrappedPool, childJobId);
    expect(childRevision?.sourceSnapshot).toMatchObject({
      kind: 'chapter_label_repair',
      parentInputRevisionId: parentRevision.id,
      parentProviderJobId: parentJob.id,
      candidateArtifactId: candidateArtifact.id,
      repairIssues: pinnedRepairIssues,
    });
    expect(links).toContainEqual(
      expect.objectContaining({
        provider_job_id: childJobId,
        stage: 'chapter_label_repair',
        sequence: 0,
      }),
    );
    expectProviderAttemptEnqueued(queue, childJobId);

    const repairChapterLabels = vi.fn(async () => {
      throw new Error('stop_after_pinned_repair_input');
    });
    const childJobRow: ProviderJobRow = {
      id: childJobId,
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_label_repair',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: String(insertedJobs[0]?.input_hash),
      status: 'running',
      progress: insertedJobs[0]?.progress ?? {},
    };
    await expect(
      processChapterLabelingJob(
        wrappedPool,
        testConfig(),
        childJobRow,
        {
          createAIProvider: () => ({
            providerId: 'mock',
            displayName: 'Pinned repair test',
            labelChapterSegments: vi.fn(),
            repairChapterLabels,
          }),
        },
        undefined,
        childRevision,
      ),
    ).rejects.toThrow('stop_after_pinned_repair_input');
    expect(repairChapterLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        existingResult: candidate,
        validationIssues: pinnedRepairIssues,
      }),
    );
    expect(
      (pool.query as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([sql]) =>
        String(sql).includes('from labeled_segments'),
      ),
    ).toBe(false);
    childJobRow.status = 'failed';
    insertedJobs[0].status = 'failed';
    const repairLink = links.find((link) => link.provider_job_id === childJobId);
    if (!repairLink) throw new Error('expected repair workflow link');
    repairLink.status = 'failed';
    workflow.status = 'needs_review';
    workflow.stage = 'needs_review';

    const draftCandidate = {
      ...candidate,
      unexpectedField: 'drop-me',
      segments: candidate.segments.map((segment) => ({
        ...segment,
        segmentTextHash: segmentTextIntegrityHash(paragraph.text),
        emotion: 'sad',
        unexpectedField: 'drop-me',
      })),
    } as unknown as ChapterLabelingResult;
    const savedReview = await saveChapterLabelReviewDraft(wrappedPool, reviews[0].id, workflow.user_id, {
      expectedReviewRevision: 1,
      candidate: draftCandidate,
      editIntents: {
        [draftCandidate.segments[0].id]: { kind: 'relabel_from_window', windowId: reviews[0].windowId },
      },
    });
    expect(savedReview).toMatchObject({ status: 'editing', reviewRevision: 2 });
    expect(savedReview.editIntents).toEqual({
      [draftCandidate.segments[0].id]: { kind: 'relabel_from_window', windowId: reviews[0].windowId },
    });
    expect(savedReview.candidate).not.toHaveProperty('unexpectedField');
    expect(savedReview.candidate.segments[0]).not.toHaveProperty('unexpectedField');
    await expect(
      saveChapterLabelReviewDraft(wrappedPool, reviews[0].id, workflow.user_id, {
        expectedReviewRevision: 1,
        candidate,
      }),
    ).rejects.toBeInstanceOf(AnalysisReviewConflictError);

    const lateRepair = vi.fn(async () => candidate);
    await expect(
      processChapterLabelingJob(
        wrappedPool,
        testConfig(),
        childJobRow,
        {
          createAIProvider: () => ({
            providerId: 'mock',
            displayName: 'Late pinned repair test',
            labelChapterSegments: vi.fn(),
            repairChapterLabels: lateRepair,
          }),
        },
        undefined,
        childRevision,
      ),
    ).rejects.toMatchObject({ code: 'analysis_review_changed' });
    expect(lateRepair).not.toHaveBeenCalled();

    const promotedReview = await approveAnalysisReview(wrappedPool, testConfig(), queue, reviews[0].id, 2);
    expect(promotedReview).toMatchObject({ status: 'promoted', promotedArtifactId: expect.any(String) });
    expect(
      (wrappedPool.query as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([sql, params]) =>
        String(sql).includes('insert into user_corrections') && Array.isArray(params)
          ? params.includes('emotion') && params.includes('relabel_from_window')
          : false,
      ),
    ).toBe(true);
    expect(
      (wrappedPool.query as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([sql]) =>
        String(sql).includes('insert into label_mutation_operations'),
      ),
    ).toBe(true);
    expect(
      (wrappedPool.query as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([sql]) =>
        String(sql).includes('insert into label_reanalysis_plans'),
      ),
    ).toBe(true);
    expect(links.find((link) => link.provider_job_id === parentJob.id)?.progress).toMatchObject({
      manualReview: { status: 'promoted', reviewArtifactId: reviews[0].id },
    });
    expect(repairLink.progress).toMatchObject({
      manualReview: { status: 'superseded', reviewArtifactId: reviews[0].id },
    });
    expect(workflow).toMatchObject({ status: 'running', stage: 'labeling_chapters' });
    expect(insertedJobs).toHaveLength(2);
    expect(insertedJobs[1]).toMatchObject({ job_type: 'chapter_segment_labeling', chapter_id: 'chapter_2' });
    expectProviderAttemptEnqueued(queue, String(insertedJobs[1].id), 2);
    await expect(
      approveAnalysisReview(wrappedPool, testConfig(), queue, reviews[0].id, promotedReview.reviewRevision),
    ).resolves.toMatchObject({
      status: 'promoted',
      reviewRevision: promotedReview.reviewRevision,
      promotedArtifactId: promotedReview.promotedArtifactId,
    });
    expect(queue.add).toHaveBeenCalledTimes(2);
    await expect(approveAnalysisReview(wrappedPool, testConfig(), queue, reviews[0].id, 2)).rejects.toBeInstanceOf(
      AnalysisReviewConflictError,
    );
  });
});
