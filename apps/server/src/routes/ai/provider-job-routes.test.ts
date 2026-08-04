import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import pg from 'pg';
import { appWithAIRoutes, expectProviderAttemptEnqueued } from './ai-route-test-harness.js';

describe('AI provider job routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('enqueues and reads a hosted provider analysis job', async () => {
    const jobs = new Map<string, Record<string, unknown>>();
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from chapters c')) {
          expect(params).toEqual(['chapter_1', 'book_1', 'user_test']);
          return {
            rows: [
              {
                id: 'chapter_1',
                text_hash: 'chapter_hash',
                updated_at: '2026-07-05T00:00:00.000Z',
                paragraph_count: 2,
                character_count: 42,
              },
            ],
          };
        }
        if (sql.includes('from provider_settings')) {
          return {
            rows: [
              {
                scope: 'llm_labeling',
                default_provider_id: 'mock',
                enabled_provider_ids: ['mock'],
                model_overrides: { mock: 'mock-saved-labeler-v2' },
                provider_options: { mock: { temperature: 0.2, requestProfileId: 'chapter-labeling-v1-strict-tts' } },
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('from provider_jobs') && sql.includes('where book_id')) {
          return { rows: [] };
        }
        if (sql.includes('insert into provider_jobs')) {
          const row = {
            id: params?.[0],
            book_id: params?.[2],
            chapter_id: params?.[3],
            job_type: params?.[4],
            provider_id: params?.[5],
            model_id: params?.[6],
            input_hash: params?.[7],
            status: 'queued',
            stage: 'queued',
            progress: JSON.parse(String(params?.[8])),
            error_code: null,
            error_message: null,
            created_at: '2026-07-05T00:00:00.000Z',
            updated_at: '2026-07-05T00:00:00.000Z',
            started_at: null,
            finished_at: null,
          };
          jobs.set(String(row.id), row);
          return { rows: [row] };
        }
        if (
          sql.includes('from provider_jobs') &&
          (sql.includes('where id = $1') || sql.includes('where job.id = $1'))
        ) {
          return { rows: [jobs.get(String(params?.[0]))].filter(Boolean) };
        }
        if (sql.includes('update library_books set analysis_status')) {
          expect(params).toEqual(['queued', 'book_1', 'user_test']);
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const providerQueue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const app = await appWithAIRoutes(pool, providerQueue);

    const enqueueResponse = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-jobs',
      payload: { chapterId: 'chapter_1' },
    });
    expect(enqueueResponse.statusCode).toBe(202);
    const job = enqueueResponse.json().job;
    expect(job).toMatchObject({
      novelId: 'book_1',
      chapterId: 'chapter_1',
      type: 'chapter_segment_labeling',
      providerId: 'mock',
      status: 'queued',
      progress: {
        budgetEstimate: expect.objectContaining({
          inputCharacters: 42,
          modelId: 'mock-saved-labeler-v2',
          providerId: 'mock',
          providerOptionsHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          requestProfileId: 'chapter-labeling-v1-strict-tts',
        }),
      },
    });
    expect(job.progress.providerOptions).toBeUndefined();
    expectProviderAttemptEnqueued(providerQueue, job.id);

    const statusResponse = await app.inject({ method: 'GET', url: `/api/provider-jobs/${job.id}` });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json().job).toMatchObject({ id: job.id, status: 'queued' });
    expect(statusResponse.json().job.progress.providerOptions).toBeUndefined();

    await app.close();
  });

  it('returns a safe 429 response when direct provider-job admission is limited', async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from chapters c')) {
          return {
            rows: [
              {
                id: 'chapter_1',
                text_hash: 'chapter_hash',
                updated_at: '2026-07-05T00:00:00.000Z',
                paragraph_count: 1,
                character_count: 12,
              },
            ],
          };
        }
        if (sql.includes('from provider_settings')) return { rows: [] };
        if (sql.includes('from provider_jobs') && sql.includes('where book_id')) return { rows: [] };
        if (sql.includes('insert into provider_jobs')) {
          return {
            rows: [
              {
                id: params?.[0],
                book_id: params?.[2],
                chapter_id: params?.[3],
                job_type: params?.[4],
                provider_id: params?.[5],
                model_id: params?.[6],
                input_hash: params?.[7],
                status: 'queued',
                stage: 'queued',
                progress: JSON.parse(String(params?.[8])),
                error_code: null,
                error_message: null,
                created_at: '2026-07-05T00:00:00.000Z',
                updated_at: '2026-07-05T00:00:00.000Z',
                started_at: null,
                finished_at: null,
              },
            ],
          };
        }
        if (sql.includes('update library_books set analysis_status')) return { rowCount: 1, rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const providerQueue = {
      add: vi.fn(),
    } as unknown as Queue;
    const app = await appWithAIRoutes(pool, providerQueue, {
      limit: 'attempts_per_minute',
      retryAfterSeconds: 37,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-jobs',
      payload: { chapterId: 'chapter_1' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('37');
    expect(response.json()).toEqual({
      error: 'provider_job_admission_rejected',
      code: 'provider_job_admission_rejected',
      limit: 'attempts_per_minute',
      retryAfterSeconds: 37,
    });
    expect(response.body).not.toContain('providerOptions');
    expect(providerQueue.add).not.toHaveBeenCalled();
    await app.close();
  });

  it('enqueues chapter label repair jobs with stored segment fingerprints', async () => {
    vi.stubEnv('AI_PROVIDER_ENABLED', 'mock');
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from chapters c')) {
          expect(params).toEqual(['chapter_1', 'book_1', 'user_test']);
          return {
            rows: [
              {
                id: 'chapter_1',
                text_hash: 'chapter_hash',
                updated_at: '2026-07-05T00:00:00.000Z',
                paragraph_count: 1,
                character_count: 8,
              },
            ],
          };
        }
        if (sql.includes('from provider_settings')) {
          return {
            rows: [
              {
                scope: 'llm_labeling',
                default_provider_id: 'mock',
                enabled_provider_ids: ['mock'],
                model_overrides: {},
                provider_options: { mock: { requestProfileId: 'chapter-labeling-v1-strict-tts' } },
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('from labeled_segments') && sql.includes('order by segment_index asc')) {
          expect(params).toEqual(['book_1', 'chapter_1']);
          return {
            rows: [
              {
                id: 'segment_1',
                paragraph_id: 'paragraph_1',
                segment_index: 0,
                start_offset: 0,
                end_offset: 8,
                segment_text_hash: 'stale_hash',
                segment_type: 'quoted_dialogue',
                speaker_id: 'unknown',
                is_user_corrected: false,
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('from provider_jobs') && sql.includes('where book_id')) {
          return { rows: [] };
        }
        if (sql.includes('insert into provider_jobs')) {
          const row = {
            id: params?.[0],
            book_id: params?.[2],
            chapter_id: params?.[3],
            job_type: params?.[4],
            provider_id: params?.[5],
            model_id: params?.[6],
            input_hash: params?.[7],
            status: 'queued',
            stage: 'queued',
            progress: JSON.parse(String(params?.[8])),
            error_code: null,
            error_message: null,
            created_at: '2026-07-05T00:00:00.000Z',
            updated_at: '2026-07-05T00:00:00.000Z',
            started_at: null,
            finished_at: null,
          };
          return { rows: [row] };
        }
        if (sql.includes('update library_books set analysis_status')) {
          expect(params).toEqual(['queued', 'book_1', 'user_test']);
          return { rowCount: 1, rows: [] };
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
      url: '/api/books/book_1/analysis-jobs',
      payload: { chapterId: 'chapter_1', jobType: 'chapter_label_repair' },
    });

    expect(response.statusCode).toBe(202);
    const job = response.json().job;
    expect(job).toMatchObject({
      novelId: 'book_1',
      chapterId: 'chapter_1',
      type: 'chapter_label_repair',
      providerId: 'mock',
      status: 'queued',
      progress: {
        budgetEstimate: expect.objectContaining({
          inputCharacters: 8,
          modelId: 'mock-segment-labeler-v1',
          providerId: 'mock',
          providerOptionsHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          requestProfileId: 'chapter-label-repair-v2-patch',
          segmentCount: 1,
        }),
      },
    });
    expect(job.progress.providerOptions).toBeUndefined();
    expectProviderAttemptEnqueued(providerQueue, job.id);
    await app.close();
  });

  it('enqueues character bundle analysis jobs from selected chapter ids without storing raw text in progress', async () => {
    vi.stubEnv('AI_PROVIDER_ENABLED', 'mock');
    const jobs = new Map<string, Record<string, unknown>>();
    const payload = {
      jobType: 'character_bundle_analysis',
      chapterIds: ['chapter_1', 'chapter_2'],
      sourceContext: {
        bundleId: 'bundle_1',
        summary: 'Previous bundle context.',
      },
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from provider_settings')) {
          return {
            rows: [
              {
                scope: 'llm_labeling',
                default_provider_id: 'mock',
                enabled_provider_ids: ['mock'],
                model_overrides: {},
                provider_options: { mock: { bundleRequestProfileId: 'character-bundle-analysis-v1' } },
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('select normalized_text_hash')) {
          return {
            rows: [
              {
                normalized_text_hash: 'book_hash',
                total_chapters: 2,
                total_characters: 120,
                total_paragraphs: 6,
                updated_at: '2026-07-06T00:00:00.000Z',
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
                updated_at: '2026-07-06T00:00:00.000Z',
                paragraph_count: 3,
                character_count: 50,
              },
              {
                id: 'chapter_2',
                text_hash: 'chapter_hash_2',
                updated_at: '2026-07-06T00:10:00.000Z',
                paragraph_count: 3,
                character_count: 70,
              },
            ],
          };
        }
        if (sql.includes('from characters')) return { rows: [] };
        if (sql.includes('from character_relations')) return { rows: [] };
        if (sql.includes('from user_corrections')) return { rows: [] };
        if (sql.includes('from provider_jobs')) {
          return { rows: [...jobs.values()].filter((row) => row.input_hash === params?.[5]) };
        }
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
            stage: 'queued',
            progress: JSON.parse(String(params?.[8])),
            error_code: null,
            error_message: null,
            created_at: '2026-07-06T00:00:00.000Z',
            updated_at: '2026-07-06T00:00:00.000Z',
            started_at: null,
            finished_at: null,
          };
          jobs.set(String(row.id), row);
          return { rows: [row] };
        }
        if (sql.includes('update library_books set analysis_status')) {
          expect(params).toEqual(['queued', 'book_1', 'user_test']);
          return { rowCount: 1, rows: [] };
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
      url: '/api/books/book_1/analysis-jobs',
      payload,
    });

    expect(response.statusCode).toBe(202);
    const job = response.json().job;
    expect(job).toMatchObject({
      novelId: 'book_1',
      type: 'character_bundle_analysis',
      providerId: 'mock',
      status: 'queued',
      progress: {
        budgetEstimate: expect.objectContaining({
          inputCharacters: 120,
          modelId: 'mock-segment-labeler-v1',
          providerId: 'mock',
          providerOptionsHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          requestProfileId: 'character-bundle-analysis-v1',
          bundleId: 'bundle_1',
          chapterCount: 2,
          paragraphCount: 6,
          graphCharacterCount: 0,
          graphRelationCount: 0,
          correctionCount: 0,
        }),
        sourceContext: {
          bundleId: 'bundle_1',
          chapterIds: ['chapter_1', 'chapter_2'],
          summary: 'Previous bundle context.',
        },
      },
    });
    expect(job.progress.providerOptions).toBeUndefined();
    expect(job.chapterId).toBeUndefined();
    expect(JSON.stringify(job.progress)).not.toContain('강현우');
    expectProviderAttemptEnqueued(providerQueue, job.id);

    const repeatedResponse = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-jobs',
      payload,
    });
    expect(repeatedResponse.statusCode).toBe(202);
    expect(repeatedResponse.json().job).toMatchObject({
      id: job.id,
      inputHash: job.inputHash,
      type: 'character_bundle_analysis',
    });
    const insertedJobs = (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([sql]) =>
      String(sql).includes('insert into provider_jobs'),
    );
    expect(insertedJobs).toHaveLength(1);
    await app.close();
  });

  it('enqueues character graph merge jobs without a chapter target', async () => {
    vi.stubEnv('AI_PROVIDER_ENABLED', 'mock');
    const jobs = new Map<string, Record<string, unknown>>();
    let bookUpdatedAt = '2026-07-05T00:00:00.000Z';
    const graphMergePayload = {
      jobType: 'character_graph_merge',
      discoveredGraph: {
        novelId: 'book_1',
        characters: [
          {
            id: 'candidate_alex',
            canonicalName: 'Alex',
            aliases: ['Al'],
            color: '#3b82f6',
            confidence: 0.72,
            isUserConfirmed: false,
          },
          {
            id: 'candidate_rin',
            canonicalName: 'Rin',
            aliases: ['R'],
            color: '#ef476f',
            confidence: 0.68,
            isUserConfirmed: false,
          },
        ],
        relations: [
          {
            sourceCharacterId: 'candidate_alex',
            targetCharacterId: 'candidate_rin',
            relationLabel: 'mentor',
            termsUsedBySource: ['Rin'],
            termsUsedByTarget: ['Alex'],
            confidence: 0.66,
            evidence: ['chapter 1'],
          },
        ],
      },
      sourceContext: {
        bundleId: 'bundle_1',
        chapterIds: ['chapter_1'],
        summary: 'Initial character graph import.',
      },
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from provider_settings')) {
          return {
            rows: [
              {
                scope: 'llm_labeling',
                default_provider_id: 'mock',
                enabled_provider_ids: ['mock'],
                model_overrides: {},
                provider_options: { mock: { graphRequestProfileId: 'character-graph-merge-v1' } },
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('select normalized_text_hash')) {
          expect(params).toEqual(['book_1', 'user_test']);
          return {
            rows: [
              {
                normalized_text_hash: 'book_hash',
                total_chapters: 12,
                total_characters: 2048,
                total_paragraphs: 300,
                updated_at: bookUpdatedAt,
              },
            ],
          };
        }
        if (sql.includes('from characters')) {
          return {
            rows: [
              {
                id: 'char_alex',
                canonical_name: 'Alex',
                aliases: ['Al'],
                color: '#3b82f6',
                description: 'Confirmed protagonist.',
                confidence: 0.95,
                is_user_confirmed: true,
                updated_at: '2026-07-05T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('from character_relations')) {
          return { rows: [] };
        }
        if (sql.includes('from user_corrections')) {
          return {
            rows: [
              {
                id: 'correction_1',
                book_id: 'book_1',
                chapter_id: null,
                paragraph_id: null,
                segment_id: null,
                correction_type: 'speaker',
                before_json: { speakerId: 'candidate_alex' },
                after_json: { speakerId: 'char_alex' },
                apply_scope: 'global',
                created_at: '2026-07-06T00:01:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('from provider_jobs') && sql.includes('where book_id')) {
          expect(params?.[1]).toBeNull();
          return {
            rows: [...jobs.values()].filter(
              (job) =>
                job.book_id === params?.[0] &&
                job.chapter_id === params?.[1] &&
                job.job_type === params?.[2] &&
                job.provider_id === params?.[3] &&
                job.model_id === params?.[4] &&
                job.input_hash === params?.[5] &&
                params?.[6] === 'user_test',
            ),
          };
        }
        if (sql.includes('insert into provider_jobs')) {
          expect(params?.[3]).toBeNull();
          const row = {
            id: params?.[0],
            book_id: params?.[2],
            chapter_id: params?.[3],
            job_type: params?.[4],
            provider_id: params?.[5],
            model_id: params?.[6],
            input_hash: params?.[7],
            status: 'queued',
            stage: 'queued',
            progress: JSON.parse(String(params?.[8])),
            error_code: null,
            error_message: null,
            created_at: '2026-07-05T00:00:00.000Z',
            updated_at: '2026-07-05T00:00:00.000Z',
            started_at: null,
            finished_at: null,
          };
          jobs.set(String(row.id), row);
          return { rows: [row] };
        }
        if (sql.includes('update library_books set analysis_status')) {
          expect(params).toEqual(['queued', 'book_1', 'user_test']);
          bookUpdatedAt = '2026-07-05T00:00:01.000Z';
          return { rowCount: 1, rows: [] };
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
      url: '/api/books/book_1/analysis-jobs',
      payload: graphMergePayload,
    });

    expect(response.statusCode).toBe(202);
    const job = response.json().job;
    expect(job).toMatchObject({
      novelId: 'book_1',
      type: 'character_graph_merge',
      providerId: 'mock',
      status: 'queued',
      progress: {
        budgetEstimate: expect.objectContaining({
          inputCharacters: 2048,
          modelId: 'mock-segment-labeler-v1',
          providerId: 'mock',
          providerOptionsHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          requestProfileId: 'character-graph-merge-v1',
          graphCharacterCount: 1,
          graphRelationCount: 0,
          discoveredCharacterCount: 2,
          discoveredRelationCount: 1,
          correctionCount: 1,
        }),
        graphFingerprint: {
          characterCount: 1,
          relationCount: 0,
          graphHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
        correctionFingerprint: {
          correctionCount: 1,
          correctionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
        discoveredGraph: {
          novelId: 'book_1',
          characters: expect.arrayContaining([
            expect.objectContaining({ id: 'candidate_alex', canonicalName: 'Alex' }),
          ]),
        },
        sourceContext: { bundleId: 'bundle_1' },
      },
    });
    expect(job.progress.providerOptions).toBeUndefined();
    expect(job.chapterId).toBeUndefined();
    expectProviderAttemptEnqueued(providerQueue, job.id);

    const repeatedResponse = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-jobs',
      payload: graphMergePayload,
    });
    expect(repeatedResponse.statusCode).toBe(202);
    expect(repeatedResponse.json().job).toMatchObject({
      id: job.id,
      inputHash: job.inputHash,
      type: 'character_graph_merge',
    });
    const insertedJobs = (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([sql]) =>
      String(sql).includes('insert into provider_jobs'),
    );
    expect(insertedJobs).toHaveLength(1);
    await app.close();
  });

  it('rejects explicit analysis providers disabled by saved provider settings', async () => {
    vi.stubEnv('AI_PROVIDER_ENABLED', 'mock,openai');
    vi.stubEnv('AI_OPENAI_LABELING_MODEL_ID', 'gpt-labeler-test');
    vi.stubEnv('OPENAI_API_KEY', 'sk-secret-test');
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from provider_settings')) {
          return {
            rows: [
              {
                scope: 'llm_labeling',
                default_provider_id: 'mock',
                enabled_provider_ids: ['mock'],
                model_overrides: { openai: 'gpt-saved-labeler' },
                provider_options: {},
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        throw new Error(`unexpected query after saved provider settings rejection: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-jobs',
      payload: { chapterId: 'chapter_1', providerId: 'openai' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'provider is disabled by saved provider settings' });
    await app.close();
  });

  it('rejects unsupported analysis request profiles before loading chapter text', async () => {
    vi.stubEnv('AI_PROVIDER_ENABLED', 'mock');
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from provider_settings')) {
          return {
            rows: [
              {
                scope: 'llm_labeling',
                default_provider_id: 'mock',
                enabled_provider_ids: ['mock'],
                model_overrides: {},
                provider_options: { mock: { requestProfileId: 'missing-profile' } },
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        throw new Error(`chapter text should not be loaded for unsupported request profile: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-jobs',
      payload: { chapterId: 'chapter_1' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Unsupported chapter labeling request profile: missing-profile' });
    await app.close();
  });

  it('rejects BYO provider jobs when provider secrets are missing', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from provider_secrets')) return { rows: [] };
        throw new Error('only provider secret status lookup should be reached for missing provider secret');
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-jobs',
      payload: { chapterId: 'chapter_1', providerId: 'openai', modelId: 'gpt-labeler' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'provider secret is not configured on this server yet' });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('from provider_secrets'), ['user_test']);
    await app.close();
  });

  it('rejects enabled provider jobs when server secrets are missing', async () => {
    vi.stubEnv('AI_PROVIDER_ENABLED', 'mock,openai');
    vi.stubEnv('AI_OPENAI_LABELING_MODEL_ID', 'gpt-labeler-test');
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from provider_secrets')) return { rows: [] };
        throw new Error('only provider secret status lookup should be reached for missing provider secret');
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-jobs',
      payload: { chapterId: 'chapter_1', providerId: 'openai' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'provider secret is not configured on this server yet' });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('from provider_secrets'), ['user_test']);
    await app.close();
  });

  it('rejects unknown provider ids instead of falling back to mock', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('database should not be reached for an invalid provider');
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/books/book_1/analysis-jobs',
      payload: { chapterId: 'chapter_1', providerId: 'unknown-provider' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'providerId is invalid' });
    await app.close();
  });
});
