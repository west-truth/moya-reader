import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import {
  advanceBookAIWorkflow,
  advanceBookAIWorkflowsForProviderJob,
  refreshBookAIWorkflowTTSCacheReadiness,
  refreshBookAIWorkflowTTSCacheReadinessForProviderJob,
} from '../book-ai-workflow-service.js';
import { testConfig, workflowRow, bootstrapLink, mergeLink, labelingLink } from './book-ai-workflow-test-harness.js';

describe('book AI workflow service', () => {
  it('marks workflow ready only after persisted labels and character voice profiles pass TTS readiness', async () => {
    const workflowUpdates: Record<string, unknown>[] = [];
    const bookUpdates: Record<string, unknown>[] = [];
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
      mergeLink(),
      labelingLink({ id: 'window_1', providerJobId: 'provider_job_label_1', windowId: 'window_1', sequence: 0 }),
      labelingLink({ id: 'window_2', providerJobId: 'provider_job_label_2', windowId: 'window_2', sequence: 1 }),
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflowRow()] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('from labeled_segments') && sql.includes('count(*) as segment_count')) {
          expect(params).toEqual(['book_1', ['chapter_1', 'chapter_2'], ['p1', 'p2']]);
          return {
            rows: [
              {
                segment_count: 8,
                labeled_chapter_count: 2,
                labeled_planned_paragraph_count: 2,
                unknown_segment_count: 0,
                low_confidence_segment_count: 0,
                character_speaker_count: 2,
              },
            ],
          };
        }
        if (sql.includes('having not exists')) return { rows: [] };
        if (sql.includes('from voice_profiles') && sql.includes('group by role')) {
          expect(params).toEqual(['book_1']);
          return {
            rows: [
              { role: 'narrator', profile_count: 1 },
              { role: 'system', profile_count: 1 },
            ],
          };
        }
        if (sql.includes('from unnest($2::text[])')) {
          expect(params).toEqual(['book_1', ['p1', 'p2']]);
          return { rows: [] };
        }
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({
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
        status: 'succeeded',
        stage: 'ready_for_tts',
        finished: true,
        progress: expect.objectContaining({
          readyForTtsChapterIds: ['chapter_1', 'chapter_2'],
          ttsReadiness: expect.objectContaining({
            ok: true,
            metrics: expect.objectContaining({
              segmentCount: 8,
              labeledChapterCount: 2,
              plannedParagraphCount: 2,
              labeledPlannedParagraphCount: 2,
              missingPlannedParagraphCount: 0,
              characterSpeakerCount: 2,
              missingCharacterVoiceProfileCount: 0,
            }),
          }),
        }),
      }),
    ]);
    expect(bookUpdates).toEqual([{ status: 'ready', bookId: 'book_1', userId: 'user_test' }]);
  });

  it('advances a linked workflow into TTS readiness after the final labeling provider job finishes', async () => {
    const workflowUpdates: Record<string, unknown>[] = [];
    const bookUpdates: Record<string, unknown>[] = [];
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
      mergeLink(),
      labelingLink({ id: 'window_1', providerJobId: 'provider_job_label_1', windowId: 'window_1', sequence: 0 }),
      labelingLink({ id: 'window_2', providerJobId: 'provider_job_label_2', windowId: 'window_2', sequence: 1 }),
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('select distinct wj.workflow_id')) {
          expect(params).toEqual(['provider_job_label_2', 'user_test']);
          return { rows: [{ workflow_id: 'workflow_1' }] };
        }
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflowRow()] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('from labeled_segments') && sql.includes('count(*) as segment_count')) {
          expect(params).toEqual(['book_1', ['chapter_1', 'chapter_2'], ['p1', 'p2']]);
          return {
            rows: [
              {
                segment_count: 10,
                labeled_chapter_count: 2,
                labeled_planned_paragraph_count: 2,
                unknown_segment_count: 1,
                low_confidence_segment_count: 0,
                character_speaker_count: 2,
              },
            ],
          };
        }
        if (sql.includes('having not exists')) return { rows: [] };
        if (sql.includes('from voice_profiles') && sql.includes('group by role')) {
          return { rows: [{ role: 'narrator', profile_count: 1 }] };
        }
        if (sql.includes('from unnest($2::text[])')) return { rows: [] };
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({
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

    await advanceBookAIWorkflowsForProviderJob(pool, testConfig(), undefined, 'provider_job_label_2');

    expect(workflowUpdates).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        stage: 'ready_for_tts',
        finished: true,
        progress: expect.objectContaining({
          readyForTtsChapterIds: ['chapter_1', 'chapter_2'],
          ttsReadiness: expect.objectContaining({
            ok: true,
            metrics: expect.objectContaining({
              segmentCount: 10,
              unknownSegmentRatio: 0.1,
              missingCharacterVoiceProfileCount: 0,
            }),
          }),
        }),
      }),
    ]);
    expect(bookUpdates).toEqual([{ status: 'ready', bookId: 'book_1', userId: 'user_test' }]);
  });

  it('records partial hosted TTS cache readiness without promoting the workflow stage', async () => {
    const workflowUpdates: Record<string, unknown>[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) {
          return {
            rows: [
              {
                ...workflowRow(),
                status: 'succeeded',
                stage: 'ready_for_tts',
                progress: { ttsReadiness: { ok: true } },
              },
            ],
          };
        }
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: [] };
        if (sql.includes('cacheable_segment_count')) {
          expect(params).toEqual(['book_1', ['chapter_1', 'chapter_2']]);
          expect(sql).toContain('cs.voice_profile_id = ps.voice_profile_id');
          expect(sql).toContain('cs.provider_id = ps.provider_id');
          expect(sql).toContain('ps.provider_model is null or cs.provider_model = ps.provider_model');
          expect(sql).toContain('cs.speaker_id = ps.speaker_id');
          expect(sql).toContain('cs.segment_text_hash = ps.segment_text_hash');
          expect(sql).toContain("nullif(trim(cs.render_spec_hash), '') is not null");
          expect(sql).toContain('cs.cache_updated_at >= ps.voice_profile_updated_at');
          expect(sql).toContain('coalesce(c.byte_size, 0) > 0');
          expect(sql).toContain("c.lifecycle_state = 'active'");
          expect(sql).toContain("c.integrity_state = 'verified'");
          expect(sql).toContain('c.stale_at is null');
          return { rows: [{ cacheable_segment_count: 3, cached_segment_count: 2 }] };
        }
        if (sql.includes('cache_item_count')) {
          expect(params).toEqual(['book_1', ['chapter_1', 'chapter_2']]);
          expect(sql).toContain('matched_cache_items');
          expect(sql).toContain('c.updated_at >= ps.voice_profile_updated_at');
          expect(sql).toContain('c.speaker_id = ps.speaker_id');
          expect(sql).toContain(
            "coalesce(c.segment_text_hashes, '{}'::jsonb) ->> segment.segment_id = ps.segment_text_hash",
          );
          expect(sql).toContain("nullif(trim(c.render_spec_hash), '') is not null");
          expect(sql).toContain("c.lifecycle_state = 'active'");
          expect(sql).toContain("c.integrity_state = 'verified'");
          expect(sql).toContain('c.stale_at is null');
          return { rows: [{ cache_item_count: 2, cached_byte_size: 2048 }] };
        }
        if (sql.includes('select ps.id as segment_id')) {
          expect(params).toEqual(['book_1', ['chapter_1', 'chapter_2']]);
          expect(sql).toContain('cs.voice_profile_id = ps.voice_profile_id');
          expect(sql).toContain('cs.provider_id = ps.provider_id');
          expect(sql).toContain('cs.segment_text_hash = ps.segment_text_hash');
          expect(sql).toContain("nullif(trim(cs.render_spec_hash), '') is not null");
          expect(sql).toContain('cs.cache_updated_at >= ps.voice_profile_updated_at');
          expect(sql).toContain("c.lifecycle_state = 'active'");
          expect(sql).toContain("c.integrity_state = 'verified'");
          expect(sql).toContain('c.stale_at is null');
          return { rows: [{ segment_id: 'seg_3' }] };
        }
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({
            status: params?.[2],
            stage: params?.[3],
            progress: JSON.parse(String(params?.[4])),
            errorCode: params?.[5],
            errorMessage: params?.[6],
            finished: params?.[7],
          });
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    const report = await refreshBookAIWorkflowTTSCacheReadiness(pool, testConfig(), 'workflow_1');

    expect(report).toMatchObject({
      ok: false,
      errorCode: 'tts_cache_readiness_missing_audio_cache',
      missingCachedSegmentIds: ['seg_3'],
      metrics: {
        plannedChapterCount: 2,
        cacheableSegmentCount: 3,
        cachedSegmentCount: 2,
        missingCachedSegmentCount: 1,
        cacheItemCount: 2,
        cachedByteSize: 2048,
      },
    });
    expect(workflowUpdates).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        stage: 'ready_for_tts',
        finished: false,
        progress: expect.objectContaining({
          audioCacheReadyAt: null,
          ttsReadiness: { ok: true },
          ttsCacheReadiness: expect.objectContaining({
            ok: false,
            errorCode: 'tts_cache_readiness_missing_audio_cache',
          }),
        }),
      }),
    ]);
  });

  it('promotes a ready workflow when all hosted TTS cacheable segments are cached', async () => {
    const workflowUpdates: Record<string, unknown>[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) {
          return {
            rows: [
              {
                ...workflowRow(),
                status: 'succeeded',
                stage: 'ready_for_tts',
                progress: { ttsReadiness: { ok: true } },
              },
            ],
          };
        }
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: [] };
        if (sql.includes('cacheable_segment_count')) {
          expect(sql).toContain('cs.voice_profile_id = ps.voice_profile_id');
          expect(sql).toContain('cs.provider_id = ps.provider_id');
          expect(sql).toContain('cs.segment_text_hash = ps.segment_text_hash');
          expect(sql).toContain("nullif(trim(cs.render_spec_hash), '') is not null");
          expect(sql).toContain('cs.cache_updated_at >= ps.voice_profile_updated_at');
          return { rows: [{ cacheable_segment_count: 4, cached_segment_count: 4 }] };
        }
        if (sql.includes('cache_item_count')) return { rows: [{ cache_item_count: 3, cached_byte_size: 4096 }] };
        if (sql.includes('select ps.id as segment_id')) return { rows: [] };
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({
            status: params?.[2],
            stage: params?.[3],
            progress: JSON.parse(String(params?.[4])),
            errorCode: params?.[5],
            errorMessage: params?.[6],
            finished: params?.[7],
          });
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    const report = await refreshBookAIWorkflowTTSCacheReadiness(pool, testConfig(), 'workflow_1');

    expect(report).toMatchObject({
      ok: true,
      metrics: {
        plannedChapterCount: 2,
        cacheableSegmentCount: 4,
        cachedSegmentCount: 4,
        missingCachedSegmentCount: 0,
        cacheItemCount: 3,
        cachedByteSize: 4096,
        cacheReadyRatio: 1,
      },
    });
    expect(workflowUpdates).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        stage: 'audio_cache_ready',
        finished: false,
        progress: expect.objectContaining({
          ttsReadiness: { ok: true },
          ttsCacheReadiness: expect.objectContaining({ ok: true }),
        }),
      }),
    ]);
    expect((workflowUpdates[0].progress as Record<string, unknown>).audioCacheReadyAt).toEqual(expect.any(String));
  });

  it('refreshes ready workflow TTS cache readiness after a TTS synthesis provider job succeeds', async () => {
    const workflowUpdates: Record<string, unknown>[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from provider_jobs') && sql.includes('where id = $1 and user_id = $2')) {
          expect(params).toEqual(['provider_job_tts_1', 'user_test']);
          return { rows: [{ book_id: 'book_1', job_type: 'tts_synthesis', status: 'succeeded' }] };
        }
        if (sql.includes('from book_ai_workflows') && sql.includes('where book_id = $1')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return { rows: [{ id: 'workflow_1' }] };
        }
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) {
          expect(params).toEqual(['workflow_1', 'user_test']);
          return {
            rows: [
              {
                ...workflowRow(),
                status: 'succeeded',
                stage: 'ready_for_tts',
                progress: { ttsReadiness: { ok: true } },
              },
            ],
          };
        }
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: [] };
        if (sql.includes('cacheable_segment_count'))
          return { rows: [{ cacheable_segment_count: 2, cached_segment_count: 2 }] };
        if (sql.includes('cache_item_count')) return { rows: [{ cache_item_count: 2, cached_byte_size: 2048 }] };
        if (sql.includes('select ps.id as segment_id')) return { rows: [] };
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({
            status: params?.[2],
            stage: params?.[3],
            progress: JSON.parse(String(params?.[4])),
          });
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;

    await expect(
      refreshBookAIWorkflowTTSCacheReadinessForProviderJob(pool, testConfig(), 'provider_job_tts_1'),
    ).resolves.toBe(1);

    expect(workflowUpdates).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        stage: 'audio_cache_ready',
        progress: expect.objectContaining({
          ttsCacheReadiness: expect.objectContaining({ ok: true }),
        }),
      }),
    ]);
  });

  it('moves workflow into review when TTS readiness is missing character voice profiles', async () => {
    const workflowUpdates: Record<string, unknown>[] = [];
    const bookUpdates: Record<string, unknown>[] = [];
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
      mergeLink(),
      labelingLink({ id: 'window_1', providerJobId: 'provider_job_label_1', windowId: 'window_1', sequence: 0 }),
      labelingLink({ id: 'window_2', providerJobId: 'provider_job_label_2', windowId: 'window_2', sequence: 1 }),
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflowRow()] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('from labeled_segments') && sql.includes('count(*) as segment_count')) {
          return {
            rows: [
              {
                segment_count: 8,
                labeled_chapter_count: 2,
                labeled_planned_paragraph_count: 2,
                unknown_segment_count: 1,
                low_confidence_segment_count: 0,
                character_speaker_count: 2,
              },
            ],
          };
        }
        if (sql.includes('having not exists')) return { rows: [{ speaker_id: 'char_b' }] };
        if (sql.includes('from voice_profiles') && sql.includes('group by role'))
          return { rows: [{ role: 'narrator', profile_count: 1 }] };
        if (sql.includes('from unnest($2::text[])')) return { rows: [] };
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({
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
        errorCode: 'tts_readiness_missing_voice_profiles',
        errorMessage: 'One or more character speakers do not have assigned voice profiles.',
        finished: false,
        progress: expect.objectContaining({
          failedStage: 'tts_ready_verification',
          ttsReadiness: expect.objectContaining({
            ok: false,
            missingCharacterVoiceSpeakerIds: ['char_b'],
            metrics: expect.objectContaining({
              missingCharacterVoiceProfileCount: 1,
              unknownSegmentRatio: 0.125,
            }),
          }),
          workflowReviewTargets: [
            expect.objectContaining({
              kind: 'missing_voice_profiles',
              speakerIds: ['char_b'],
              recommendedAction: 'assign_voice_profiles',
            }),
          ],
        }),
      }),
    ]);
    expect(bookUpdates).toEqual([{ status: 'needs_review', bookId: 'book_1', userId: 'user_test' }]);
  });

  it('moves workflow into review when planned paragraph labels are missing', async () => {
    const workflowUpdates: Record<string, unknown>[] = [];
    const bookUpdates: Record<string, unknown>[] = [];
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
      mergeLink(),
      labelingLink({ id: 'window_1', providerJobId: 'provider_job_label_1', windowId: 'window_1', sequence: 0 }),
      labelingLink({ id: 'window_2', providerJobId: 'provider_job_label_2', windowId: 'window_2', sequence: 1 }),
    ];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from book_ai_workflows') && sql.includes('where id = $1')) return { rows: [workflowRow()] };
        if (sql.includes('from book_ai_workflow_jobs wj')) return { rows: links };
        if (sql.includes('from labeled_segments') && sql.includes('count(*) as segment_count')) {
          return {
            rows: [
              {
                segment_count: 8,
                labeled_chapter_count: 2,
                labeled_planned_paragraph_count: 1,
                unknown_segment_count: 0,
                low_confidence_segment_count: 0,
                character_speaker_count: 1,
              },
            ],
          };
        }
        if (sql.includes('having not exists')) return { rows: [] };
        if (sql.includes('from voice_profiles') && sql.includes('group by role'))
          return { rows: [{ role: 'narrator', profile_count: 1 }] };
        if (sql.includes('from unnest($2::text[])')) return { rows: [{ paragraph_id: 'p2' }] };
        if (sql.includes('update book_ai_workflows')) {
          workflowUpdates.push({
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
        errorCode: 'tts_readiness_missing_paragraphs',
        progress: expect.objectContaining({
          failedStage: 'tts_ready_verification',
          ttsReadiness: expect.objectContaining({
            ok: false,
            missingPlannedParagraphIds: ['p2'],
            metrics: expect.objectContaining({
              plannedParagraphCount: 2,
              labeledPlannedParagraphCount: 1,
              missingPlannedParagraphCount: 1,
            }),
          }),
          workflowReviewTargets: [
            expect.objectContaining({
              kind: 'missing_paragraph_labels',
              labelingWindowIds: ['window_2'],
              paragraphIds: ['p2'],
              recommendedAction: 'retry_labeling_windows',
              repairMode: 'auto_repair_on_validation_failure',
            }),
          ],
        }),
      }),
    ]);
    expect(bookUpdates).toEqual([{ status: 'needs_review', bookId: 'book_1', userId: 'user_test' }]);
  });
});
