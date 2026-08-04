import { segmentTextIntegrityHash } from '@noveldesk/text-core/identity/ai';
import { textIntegrityHash } from '@noveldesk/text-core/hash';
import { ttsInputTextIntegrityHash, ttsProviderOptionsIntegrityHash } from '@noveldesk/text-core/identity/tts';
import type { VoiceProfile } from '@noveldesk/contracts';
import type { CharacterGraph, ChapterLabelingResult } from '../../../../../src/providers/ai';
import { planBookAIWorkflow, type BookAIWorkflowPlan } from '../../../../../src/providers/book-ai-workflow-plan';
import { resolveCharacterBundleAnalysisRequestProfile } from '../../../../../src/providers/character-bundle-request-profile';
import { resolveChapterLabelingRequestProfile } from '../../../../../src/providers/chapter-labeling-request-profile';
import { validateChapterLabelingResult } from '../../../../../src/providers/chapter-labeling-validator';
import { ttsRenderSpecHash, type TTSRenderSpec } from '../../../../../src/providers/tts-render-spec';
import pg from 'pg';
import { afterAll, describe, expect, test } from 'vitest';
import { migrateDatabase } from '../../db/migrate.js';
import {
  persistChapterLabelingResult,
  persistCharacterBundleAnalysisResult,
} from '../provider-jobs/result-persistence.js';
import { claimProviderJob, updateProviderJobProgress } from '../provider-jobs/job-lifecycle.js';
import type { ProviderJobRow } from '../provider-jobs/contracts.js';
import { prepareAdmittedProviderAttempt } from '../provider-job-admission/index.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../id-v2-migration/postgres-integration-harness.js';
import { stageAndPromoteCharacterGraph } from './artifact-promotion-service.js';
import { pinChapterLabelingInput } from './analysis-input-builder.js';
import { loadAnalysisInputRevisionForJob } from './analysis-input-repository.js';
import { insertProviderJob, linkWorkflowJob } from './child-job-repository.js';
import { loadWorkflow } from './workflow-repository.js';
import { startBookAIWorkflow } from './workflow-start-service.js';
import { testConfig } from './book-ai-workflow-test-harness.js';
import { pinAndLinkTTSInputRevision } from './tts-workflow-service.js';
import { withBookAITransaction } from './transaction.js';

const harness = await startPostgresIntegrationHarness();
const describeWithPostgres = harness ? describe : describe.skip;
const noLimits = { maxActiveAttempts: 0, maxAttemptsPerMinute: 0, maxAttemptsPerUtcDay: 0 };

async function seedAnalysisBook(pool: pg.Pool, paragraphTexts: readonly string[]): Promise<BookAIWorkflowPlan> {
  await pool.query(`insert into users (id, email, display_name) values ('user_test', 'test@example.com', 'Test')`);
  await pool.query(`
    insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes)
    values ('object_1', 'raw_1', 'book.txt', 'book.txt', 'text/plain', 100)
  `);
  await pool.query(
    `
      insert into library_books (
        id, user_id, object_id, title, source_file_name, source_encoding,
        normalized_text_hash, total_chapters, total_characters, total_paragraphs
      ) values ('book_1', 'user_test', 'object_1', 'Book', 'book.txt', 'utf-8', 'normalized_1', 1, $1, $2)
    `,
    [paragraphTexts.reduce((sum, text) => sum + text.length, 0), paragraphTexts.length],
  );
  const chapterHash = 'chapter_hash_1';
  await pool.query(
    `
      insert into chapters (
        id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset,
        character_count, paragraph_count
      ) values ('chapter_1', 'book_1', 1, 'Chapter 1', $1, 0, $2, $2, $3)
    `,
    [chapterHash, paragraphTexts.reduce((sum, text) => sum + text.length, 0), paragraphTexts.length],
  );
  for (const [index, text] of paragraphTexts.entries()) {
    const paragraphId = `paragraph_${index + 1}`;
    const textHash = textIntegrityHash(text);
    await pool.query(
      `
        insert into paragraph_search (
          id, paragraph_id, book_id, chapter_id, page_index, paragraph_index,
          text, text_lower, paragraph
        ) values ($1, $2, 'book_1', 'chapter_1', 0, $3, $4, lower($4), $5)
      `,
      [
        `search_${index + 1}`,
        paragraphId,
        index,
        text,
        JSON.stringify({
          id: paragraphId,
          novelId: 'book_1',
          chapterId: 'chapter_1',
          index,
          text,
          startOffsetInChapter: 0,
          endOffsetInChapter: text.length,
          textHash,
        }),
      ],
    );
  }
  return planBookAIWorkflow({
    novelId: 'book_1',
    chapters: [
      {
        id: 'chapter_1',
        index: 1,
        title: 'Chapter 1',
        characterCount: paragraphTexts.reduce((sum, text) => sum + text.length, 0),
        paragraphCount: paragraphTexts.length,
        textHash: chapterHash,
      },
    ],
    paragraphs: paragraphTexts.map((text, index) => ({
      id: `paragraph_${index + 1}`,
      chapterId: 'chapter_1',
      index,
      text,
      textHash: textIntegrityHash(text),
    })),
    options: { maxLabelingParagraphs: 1, targetLabelingCharacters: 1 },
  });
}

async function claimAttempt(pool: pg.Pool, jobId: string): Promise<ProviderJobRow> {
  const attempt = await prepareAdmittedProviderAttempt(pool, jobId, noLimits);
  if (!attempt) throw new Error(`Provider job was not admitted: ${jobId}`);
  const job = await claimProviderJob(pool, jobId, 'user_test', attempt);
  if (!job) throw new Error(`Provider job was not claimed: ${jobId}`);
  return job;
}

async function workflowJobId(pool: pg.Pool, workflowId: string): Promise<string> {
  const result = await pool.query<{ provider_job_id: string }>(
    `select provider_job_id from book_ai_workflow_jobs where workflow_id = $1 order by sequence limit 1`,
    [workflowId],
  );
  if (!result.rows[0]) throw new Error(`Workflow has no child provider job: ${workflowId}`);
  return result.rows[0].provider_job_id;
}

describeWithPostgres('immutable analysis revisions and promotion', () => {
  afterAll(async () => {
    await harness?.stop();
  });

  test('serializes concurrent workflow start and keeps retry promotion idempotent', async () => {
    await withPostgresSchema(harness!, 'analysis_idempotency', async (pool) => {
      await migrateDatabase(pool);
      const plan = await seedAnalysisBook(pool, ['Opening line.']);
      const legacyPlan = {
        ...plan,
        stages: [
          { id: 'character_graph_bootstrap' as const, itemIds: plan.bundleWindows.map((window) => window.id) },
          {
            id: 'chapter_labeling' as const,
            dependsOn: 'character_graph_bootstrap' as const,
            itemIds: plan.labelingWindows.map((window) => window.id),
          },
          {
            id: 'tts_ready_preparation' as const,
            dependsOn: 'chapter_labeling' as const,
            itemIds: plan.ttsReady.chapterIds,
          },
        ],
      };
      const config = testConfig();
      const requestProfile = resolveCharacterBundleAnalysisRequestProfile({});
      const starts = await Promise.all([
        startBookAIWorkflow(pool, config, undefined, {
          bookId: 'book_1',
          providerId: 'mock',
          modelId: 'model_same',
          plan: legacyPlan,
          providerOptions: {},
          requestProfile,
        }),
        startBookAIWorkflow(pool, config, undefined, {
          bookId: 'book_1',
          providerId: 'mock',
          modelId: 'model_same',
          plan: legacyPlan,
          providerOptions: {},
          requestProfile,
        }),
      ]);
      expect(new Set(starts.map((item) => item.workflowId)).size).toBe(1);
      const upgradedStart = await startBookAIWorkflow(pool, config, undefined, {
        bookId: 'book_1',
        providerId: 'mock',
        modelId: 'model_same',
        plan,
        providerOptions: {},
        requestProfile,
      });
      expect(upgradedStart).toMatchObject({ workflowId: starts[0].workflowId, reused: true });
      expect((await pool.query(`select count(*)::integer as count from book_ai_workflows`)).rows[0].count).toBe(1);
      expect((await pool.query(`select count(*)::integer as count from analysis_input_revisions`)).rows[0].count).toBe(
        1,
      );

      const jobId = await workflowJobId(pool, starts[0].workflowId);
      const revision = await loadAnalysisInputRevisionForJob(pool, jobId);
      expect(revision).toBeDefined();
      const result = {
        novelId: 'book_1',
        bundleId: plan.bundleWindows[0].bundleId,
        sourceChapterIds: ['chapter_1'],
        discoveredGraph: { novelId: 'book_1', characters: [], relations: [] },
        bundleSummaryForNext: 'Opening context',
      };
      const firstAttempt = await claimAttempt(pool, jobId);
      await persistCharacterBundleAnalysisResult(pool, firstAttempt, result, requestProfile, {}, revision);
      await pool.query(
        `
          update provider_jobs
          set status = 'queued', stage = 'queued', started_at = null, finished_at = null
          where id = $1 and status = 'succeeded'
        `,
        [jobId],
      );
      const secondAttempt = await claimAttempt(pool, jobId);
      await persistCharacterBundleAnalysisResult(pool, secondAttempt, result, requestProfile, {}, revision);

      expect(
        (
          await pool.query(
            `select count(*)::integer as count from analysis_staging_artifacts where provider_job_id = $1`,
            [jobId],
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await pool.query(`select count(*)::integer as count from analysis_runs where input_revision_id = $1`, [
            revision!.id,
          ])
        ).rows[0].count,
      ).toBe(1);
      const job = await pool.query(`select status, attempt_count from provider_jobs where id = $1`, [jobId]);
      expect(job.rows[0]).toMatchObject({ status: 'succeeded', attempt_count: 2 });
    });
  }, 30_000);

  test('prevents a concurrent workflow from overwriting a promoted graph revision', async () => {
    await withPostgresSchema(harness!, 'analysis_concurrent_graph', async (pool) => {
      await migrateDatabase(pool);
      const plan = await seedAnalysisBook(pool, ['Graph source.']);
      const config = testConfig();
      const requestProfile = resolveCharacterBundleAnalysisRequestProfile({});
      const [first, second] = await Promise.all([
        startBookAIWorkflow(pool, config, undefined, {
          bookId: 'book_1',
          providerId: 'mock',
          modelId: 'model_a',
          plan,
          providerOptions: {},
          requestProfile,
        }),
        startBookAIWorkflow(pool, config, undefined, {
          bookId: 'book_1',
          providerId: 'mock',
          modelId: 'model_b',
          plan,
          providerOptions: {},
          requestProfile,
        }),
      ]);
      const firstJobId = await workflowJobId(pool, first.workflowId);
      const secondJobId = await workflowJobId(pool, second.workflowId);
      const [firstRevision, secondRevision] = await Promise.all([
        loadAnalysisInputRevisionForJob(pool, firstJobId),
        loadAnalysisInputRevisionForJob(pool, secondJobId),
      ]);
      const [firstJob, secondJob] = await Promise.all([
        claimAttempt(pool, firstJobId),
        claimAttempt(pool, secondJobId),
      ]);
      const graphA: CharacterGraph = {
        novelId: 'book_1',
        characters: [
          {
            id: 'character_a',
            novelId: 'book_1',
            canonicalName: 'A',
            aliases: [],
            color: '#111111',
            confidence: 1,
            isUserConfirmed: false,
          },
        ],
        relations: [],
      };
      const graphB: CharacterGraph = {
        novelId: 'book_1',
        characters: [
          {
            id: 'character_b',
            novelId: 'book_1',
            canonicalName: 'B',
            aliases: [],
            color: '#222222',
            confidence: 1,
            isUserConfirmed: false,
          },
        ],
        relations: [],
      };
      await stageAndPromoteCharacterGraph(
        {
          pool,
          job: firstJob,
          revision: firstRevision!,
          requestProfile,
          metadata: {},
          analysisStatus: 'building_graph',
        },
        graphA,
      );
      await expect(
        stageAndPromoteCharacterGraph(
          {
            pool,
            job: secondJob,
            revision: secondRevision!,
            requestProfile,
            metadata: {},
            analysisStatus: 'building_graph',
          },
          graphB,
        ),
      ).rejects.toMatchObject({ code: 'analysis_graph_revision_stale' });
      const characters = await pool.query(`select id from characters order by id`);
      expect(characters.rows).toEqual([{ id: 'character_a' }]);
      const stale = await pool.query(
        `select status from analysis_staging_artifacts where provider_job_id = $1 and artifact_type = 'character_graph'`,
        [secondJobId],
      );
      expect(stale.rows[0]).toEqual({ status: 'stale' });
    });
  }, 30_000);

  test('pins prior window Episode Context and aggregates the final window', async () => {
    await withPostgresSchema(harness!, 'analysis_episode_context', async (pool) => {
      await migrateDatabase(pool);
      const plan = await seedAnalysisBook(pool, ['First scene.', 'Second scene.']);
      const config = testConfig();
      const bundleProfile = resolveCharacterBundleAnalysisRequestProfile({});
      const started = await startBookAIWorkflow(pool, config, undefined, {
        bookId: 'book_1',
        providerId: 'mock',
        modelId: 'model_context',
        plan,
        providerOptions: {},
        requestProfile: bundleProfile,
      });
      const loaded = await loadWorkflow(pool, config, started.workflowId);
      if (!loaded) throw new Error('Workflow was not loaded');
      const profile = resolveChapterLabelingRequestProfile({});
      const revisions = [];
      for (const [index, window] of plan.labelingWindows.entries()) {
        const inputHash = `label_input_${index}`;
        const progress = {
          providerOptions: {},
          sourceContext: { workflowId: loaded.row.id, workflowStage: 'chapter_labeling' },
        };
        const inserted = await insertProviderJob(pool, {
          userId: 'user_test',
          bookId: 'book_1',
          chapterId: 'chapter_1',
          jobType: 'chapter_segment_labeling',
          providerId: 'mock',
          modelId: 'model_context',
          inputHash,
          progress,
        });
        const job: ProviderJobRow = {
          id: inserted.id,
          user_id: 'user_test',
          book_id: 'book_1',
          chapter_id: 'chapter_1',
          job_type: 'chapter_segment_labeling',
          provider_id: 'mock',
          model_id: 'model_context',
          input_hash: inputHash,
          status: inserted.status,
          progress,
        };
        const revision = await pinChapterLabelingInput(pool, {
          workflow: loaded.row,
          job,
          plan,
          window,
          providerOptions: {},
          requestProfile: profile,
        });
        revisions.push(revision);
        await linkWorkflowJob(pool, {
          workflowId: loaded.row.id,
          providerJobId: job.id,
          stage: 'chapter_labeling',
          planItemId: window.id,
          sequence: window.sequence,
        });
        const claimed = await claimAttempt(pool, job.id);
        if (revision.sourceSnapshot.kind !== 'chapter_labeling') {
          throw new Error('Pinned labeling source has the wrong kind');
        }
        const labelingSource = revision.sourceSnapshot;
        const paragraph = labelingSource.paragraphs[0];
        if (!paragraph) throw new Error('Pinned labeling paragraph is missing');
        const result: ChapterLabelingResult = {
          characters: [],
          segments: [
            {
              id: `segment_${index}`,
              novelId: 'book_1',
              chapterId: 'chapter_1',
              paragraphId: paragraph.id,
              segmentIndex: 0,
              startOffset: 0,
              endOffset: paragraph.text.length,
              segmentTextHash: segmentTextIntegrityHash(paragraph.text),
              type: 'narration',
              speakerId: 'narrator',
              candidateSpeakers: ['narrator'],
              listenerIds: [],
              emotion: 'neutral',
              confidence: 1,
              isUserCorrected: false,
            },
          ],
          episodeContextSummary: {
            chapterId: 'chapter_1',
            scene: `scene ${index + 1}`,
            activeCharacterIds: [],
            unresolved: index === 0 ? ['question'] : [],
            summaryForNextChapter: `summary ${index + 1}`,
          },
        };
        const validation = validateChapterLabelingResult({
          novelId: 'book_1',
          chapter: labelingSource.chapter,
          paragraphs: [paragraph],
          knownCharacters: [],
          characterGraph: revision.graphSnapshot,
          previousEpisodeContext: revision.episodeContextSnapshot,
          userCorrections: [...revision.correctionsSnapshot],
          result,
        });
        expect(validation.ok).toBe(true);
        await persistChapterLabelingResult(
          pool,
          claimed,
          labelingSource.chapter,
          result,
          validation,
          profile,
          {},
          revision,
        );
      }
      expect(revisions[1].episodeContextSnapshot).toMatchObject({ summary: 'summary 1', unresolved: ['question'] });
      const contexts = await pool.query(
        `select window_sequence, is_chapter_aggregate, context from analysis_episode_contexts order by window_sequence`,
      );
      expect(contexts.rows).toHaveLength(2);
      expect(contexts.rows[1]).toMatchObject({ window_sequence: 1, is_chapter_aggregate: true });
      const chapterContext = await pool.query(`select summary from chapter_contexts where chapter_id = 'chapter_1'`);
      expect(chapterContext.rows).toEqual([{ summary: 'summary 2' }]);
    });
  }, 30_000);

  test('pins TTS provenance and links synthesis as an explicit workflow child', async () => {
    await withPostgresSchema(harness!, 'analysis_tts_child', async (pool) => {
      await migrateDatabase(pool);
      const text = 'Spoken line.';
      const plan = await seedAnalysisBook(pool, [text]);
      const config = testConfig();
      const started = await startBookAIWorkflow(pool, config, undefined, {
        bookId: 'book_1',
        providerId: 'mock',
        modelId: 'model_tts_owner',
        plan,
        providerOptions: {},
        requestProfile: resolveCharacterBundleAnalysisRequestProfile({}),
      });
      const loaded = await loadWorkflow(pool, config, started.workflowId);
      if (!loaded) throw new Error('TTS owner workflow was not loaded');

      const labelingProgress = {
        providerOptions: {},
        sourceContext: { workflowId: loaded.row.id, workflowStage: 'chapter_labeling' },
      };
      const labeling = await insertProviderJob(pool, {
        userId: 'user_test',
        bookId: 'book_1',
        chapterId: 'chapter_1',
        jobType: 'chapter_segment_labeling',
        providerId: 'mock',
        modelId: 'model_tts_owner',
        inputHash: 'label_input_tts_owner',
        progress: labelingProgress,
      });
      const labelingJob: ProviderJobRow = {
        id: labeling.id,
        user_id: 'user_test',
        book_id: 'book_1',
        chapter_id: 'chapter_1',
        job_type: 'chapter_segment_labeling',
        provider_id: 'mock',
        model_id: 'model_tts_owner',
        input_hash: 'label_input_tts_owner',
        status: labeling.status,
        progress: labelingProgress,
      };
      await pinChapterLabelingInput(pool, {
        workflow: loaded.row,
        job: labelingJob,
        plan,
        window: plan.labelingWindows[0],
        providerOptions: {},
        requestProfile: resolveChapterLabelingRequestProfile({}),
      });
      await linkWorkflowJob(pool, {
        workflowId: loaded.row.id,
        providerJobId: labelingJob.id,
        stage: 'chapter_labeling',
        planItemId: plan.labelingWindows[0].id,
        sequence: 0,
      });
      const claimedLabelingJob = await claimAttempt(pool, labelingJob.id);
      await updateProviderJobProgress(pool, claimedLabelingJob, {
        status: 'succeeded',
        stage: 'ready',
        finishedAt: true,
      });

      const segmentHash = segmentTextIntegrityHash(text);
      await pool.query(
        `
          insert into labeled_segments (
            id, book_id, chapter_id, paragraph_id, segment_index, start_offset, end_offset,
            segment_text_hash, segment_type, speaker_id, emotion, confidence
          ) values ('segment_tts', 'book_1', 'chapter_1', 'paragraph_1', 0, 0, $1, $2, 'narration', 'narrator', 'neutral', 1)
        `,
        [text.length, segmentHash],
      );
      const ttsJobRow = await insertProviderJob(pool, {
        userId: 'user_test',
        bookId: 'book_1',
        chapterId: 'chapter_1',
        jobType: 'tts_synthesis',
        providerId: 'mock-tts',
        modelId: 'tts-model',
        inputHash: 'tts_input_hash',
        progress: {},
      });
      const ttsJob: ProviderJobRow = {
        id: ttsJobRow.id,
        user_id: 'user_test',
        book_id: 'book_1',
        chapter_id: 'chapter_1',
        job_type: 'tts_synthesis',
        provider_id: 'mock-tts',
        model_id: 'tts-model',
        input_hash: 'tts_input_hash',
        status: ttsJobRow.status,
        progress: {},
      };
      const voiceProfile: VoiceProfile = {
        id: 'voice_tts',
        novelId: 'book_1',
        role: 'narrator',
        providerId: 'mock-tts',
        providerVoiceId: 'voice-1',
        providerModel: 'tts-model',
        label: 'Narrator',
        speed: 1,
        isUserSelected: true,
        updatedAt: '2026-07-10T00:00:00.000Z',
      };
      const renderSpec: TTSRenderSpec = {
        novelId: 'book_1',
        chapterId: 'chapter_1',
        speakerId: 'narrator',
        voiceProfileId: voiceProfile.id,
        providerId: voiceProfile.providerId,
        providerModel: voiceProfile.providerModel,
        providerVoiceId: voiceProfile.providerVoiceId,
        voiceProfileRevision: voiceProfile.updatedAt,
        segmentAnchors: [
          {
            segmentId: 'segment_tts',
            paragraphId: 'paragraph_1',
            startOffset: 0,
            endOffset: text.length,
            segmentTextHash: segmentHash,
          },
        ],
        inputTextHash: ttsInputTextIntegrityHash(text),
        providerOptionsHash: ttsProviderOptionsIntegrityHash({}),
        format: 'mp3',
        speed: 1,
      };
      const revision = await withBookAITransaction(pool, (client) =>
        pinAndLinkTTSInputRevision(client, {
          job: ttsJob,
          cacheKey: 'cache_tts',
          renderSpec,
          renderSpecHash: ttsRenderSpecHash(renderSpec),
          voiceProfile,
          providerOptions: {},
        }),
      );

      expect(revision.workflowId).toBe(loaded.row.id);
      expect(revision.sourceSnapshot).toMatchObject({ kind: 'tts_synthesis', segmentIds: ['segment_tts'], text });
      const link = await pool.query(
        `select workflow_id, provider_job_id, stage, plan_item_id from book_ai_workflow_jobs where provider_job_id = $1`,
        [ttsJob.id],
      );
      expect(link.rows).toEqual([
        {
          workflow_id: loaded.row.id,
          provider_job_id: ttsJob.id,
          stage: 'tts_synthesis',
          plan_item_id: 'cache_tts',
        },
      ]);
    });
  }, 30_000);
});
