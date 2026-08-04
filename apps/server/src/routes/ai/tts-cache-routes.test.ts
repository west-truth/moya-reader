import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import pg from 'pg';
import { segmentTextIntegrityHash } from '@noveldesk/text-core/identity/ai';
import { ttsInputTextIntegrityHash } from '@noveldesk/text-core/identity/tts';
import { appWithAIRoutes, expectProviderAttemptEnqueued } from './ai-route-test-harness.js';
import { buildHostedNeutralVoiceSampleRequest } from '../../../../../src/providers/hosted-tts-playback';

describe('AI TTS cache routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('cancels queued provider jobs without exposing queue removal errors', async () => {
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_cancel',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash',
      status: 'queued',
      stage: 'queued',
      progress: { budgetEstimate: { inputCharacters: 42 } },
      error_code: null,
      error_message: null,
      created_at: '2026-07-05T00:00:00.000Z',
      updated_at: '2026-07-05T00:00:00.000Z',
      started_at: null,
      finished_at: null,
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (
          sql.includes('from provider_jobs') &&
          (sql.includes('where id = $1') || sql.includes('where job.id = $1'))
        ) {
          return { rows: String(params?.[0]) === jobRow.id ? [jobRow] : [] };
        }
        if (sql.includes('update provider_jobs') && sql.includes("set status = 'cancelled'")) {
          expect(sql).toContain('update provider_job_attempts attempt');
          expect(sql).toContain('current_attempt_id is not distinct from $6');
          expect(params?.[5]).toMatch(/^provider_attempt_/);
          jobRow.status = 'cancelled';
          jobRow.stage = 'cancelled';
          jobRow.progress = JSON.parse(String(params?.[2]));
          jobRow.error_code = 'provider_job_cancelled';
          jobRow.error_message = params?.[3];
          jobRow.finished_at = '2026-07-05T00:02:00.000Z';
          jobRow.updated_at = '2026-07-05T00:02:00.000Z';
          return { rowCount: 1, rows: [jobRow] };
        }
        if (sql.includes('update provider_jobs') && sql.includes('set progress = $3')) {
          jobRow.progress = JSON.parse(String(params?.[2]));
          return { rowCount: 1, rows: [jobRow] };
        }
        if (sql.includes('select distinct wj.workflow_id')) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const remove = vi.fn(async () => {
      throw new Error('redis://worker:secret-token@queue.internal:6379 connection refused');
    });
    const providerQueue = {
      getJob: vi.fn(async () => ({ remove })),
    } as unknown as Queue;
    const app = await appWithAIRoutes(pool, providerQueue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/provider-jobs/provider_job_cancel/cancel',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().job).toMatchObject({
      id: 'provider_job_cancel',
      status: 'cancelled',
      stage: 'cancelled',
      errorCode: 'provider_job_cancelled',
      progress: {
        cancelled: true,
        queueRemoval: { attempted: true, removed: false, error: 'queue_remove_failed' },
      },
    });
    expect(response.body).not.toContain('secret-token');
    expect(JSON.stringify(jobRow.progress)).not.toContain('secret-token');
    expect(providerQueue.getJob).toHaveBeenCalledWith(expect.stringMatching(/^provider_attempt_/));
    expect(remove).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('returns a terminal conflict when provider job cancellation loses an update race', async () => {
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_terminal_race',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'chapter_segment_labeling',
      provider_id: 'mock',
      model_id: 'mock-segment-labeler-v1',
      input_hash: 'input_hash',
      status: 'running',
      stage: 'labeling_segments',
      progress: {},
      error_code: null,
      error_message: null,
      created_at: '2026-07-05T00:00:00.000Z',
      updated_at: '2026-07-05T00:00:00.000Z',
      started_at: '2026-07-05T00:00:30.000Z',
      finished_at: null,
    };
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (
          sql.includes('from provider_jobs') &&
          (sql.includes('where id = $1') || sql.includes('where job.id = $1'))
        ) {
          return { rows: String(params?.[0]) === jobRow.id ? [jobRow] : [] };
        }
        if (sql.includes('update provider_jobs') && sql.includes("status = 'cancelled'")) {
          jobRow.status = 'succeeded';
          jobRow.stage = 'ready';
          jobRow.finished_at = '2026-07-05T00:01:00.000Z';
          return { rowCount: 0, rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const providerQueue = {
      getJob: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    } as unknown as Queue;
    const app = await appWithAIRoutes(pool, providerQueue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/provider-jobs/provider_job_terminal_race/cancel',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().job).toMatchObject({ id: 'provider_job_terminal_race', status: 'succeeded' });
    expect(providerQueue.getJob).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects unconfigured TTS cache providers before creating failed jobs', async () => {
    vi.stubEnv('TTS_PROVIDER_ENABLED', 'elevenlabs');
    vi.stubEnv('TTS_ELEVENLABS_MODEL_ID', 'eleven-model-a');
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from provider_secrets')) return { rows: [] };
        throw new Error('only provider secret status lookup should be reached for unconfigured TTS provider');
      }),
    } as unknown as pg.Pool;
    const providerQueue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const app = await appWithAIRoutes(pool, providerQueue);

    const response = await app.inject({
      method: 'POST',
      url: '/api/chapters/chapter_1/tts-cache/resolve',
      payload: {
        providerId: 'elevenlabs',
        voiceProfileId: 'voice_eleven_1',
        speakerId: 'char_1',
        segmentIds: ['seg_1'],
        inputTextHash: 'text_hash_only',
        providerOptions: { speed: 1, tone: 'calm' },
        audioCharacters: 12,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'TTS provider secret is not configured on this server yet' });
    expect(response.body).not.toContain('안녕');
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('from provider_secrets'), ['user_test']);
    expect(providerQueue.add).not.toHaveBeenCalled();
    await app.close();
  });

  it('enqueues implemented TTS cache miss jobs without accepting raw text', async () => {
    vi.stubEnv('TTS_PROVIDER_ENABLED', 'local-endpoint');
    vi.stubEnv('TTS_LOCAL_ENDPOINT_MODEL_ID', 'local-tts-a');
    vi.stubEnv('TTS_LOCAL_ENDPOINT_URL', 'http://127.0.0.1:9010/synthesize');
    const segmentText = 'Spoken line.';
    const inputTextHash = ttsInputTextIntegrityHash(segmentText);
    const jobs = new Map<string, Record<string, unknown>>();
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('select c.book_id')) {
          expect(params).toEqual(['chapter_1', 'user_test']);
          return { rows: [{ book_id: 'book_1' }] };
        }
        if (sql.includes('from voice_profiles')) {
          expect(params).toEqual(['voice_local_1', 'book_1']);
          return {
            rows: [
              {
                id: 'voice_local_1',
                book_id: 'book_1',
                character_id: 'char_1',
                role: 'character',
                provider_id: 'local-endpoint',
                provider_voice_id: 'local-voice-1',
                provider_model: 'local-tts-a',
                label: 'Local voice',
                language: 'ko-KR',
                tone: 'profile-calm',
                speed: 1,
                pitch: null,
                emotion_policy: 'segment',
                provider_options: { voice: 'local-voice-1' },
                is_user_selected: true,
                created_at: '2026-07-05T00:00:00.000Z',
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('voice_casting_states')) return { rows: [] };
        if (sql.includes('from provider_settings')) {
          return {
            rows: [
              {
                scope: 'tts_synthesis',
                default_provider_id: 'local-endpoint',
                enabled_provider_ids: ['system', 'local-endpoint'],
                model_overrides: { 'local-endpoint': 'local-tts-settings' },
                provider_options: { 'local-endpoint': { responseFormat: 'mp3', tone: 'saved-calm' } },
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('select workflow.id') && sql.includes('from book_ai_workflows workflow')) {
          return { rows: [] };
        }
        if (sql.includes('from chapters c') && sql.includes('where c.id = $1')) {
          return {
            rows: [
              {
                id: 'chapter_1',
                book_id: 'book_1',
                chapter_index: 1,
                title: 'Chapter 1',
                text_hash: 'chapter_hash_1',
                raw_start_offset: 0,
                raw_end_offset: segmentText.length,
                character_count: segmentText.length,
                paragraph_count: 1,
                created_at: '2026-07-05T00:00:00.000Z',
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('from labeled_segments s') && sql.includes('join paragraph_search ps')) {
          return {
            rows: [
              {
                id: 'seg_1',
                paragraph_id: 'paragraph_1',
                segment_index: 0,
                start_offset: 0,
                end_offset: segmentText.length,
                segment_text_hash: segmentTextIntegrityHash(segmentText),
                speaker_id: 'char_1',
                emotion: 'neutral',
                text: segmentText,
              },
            ],
          };
        }
        if (
          sql.includes('select paragraph_id, chapter_id, paragraph_index, text') &&
          sql.includes('from paragraph_search')
        ) {
          return {
            rows: [
              {
                paragraph_id: 'paragraph_1',
                chapter_id: 'chapter_1',
                paragraph_index: 0,
                text: segmentText,
              },
            ],
          };
        }
        if (sql.includes('from tts_audio_cache')) {
          return { rows: [] };
        }
        if (sql.includes('from provider_jobs') && sql.includes("job_type = 'tts_synthesis'")) {
          return { rows: [] };
        }
        if (sql.includes('insert into provider_jobs')) {
          const row = {
            id: params?.[0],
            book_id: params?.[2],
            chapter_id: params?.[3],
            job_type: 'tts_synthesis',
            provider_id: params?.[4],
            model_id: params?.[5],
            input_hash: params?.[6],
            status: 'queued',
            stage: 'queued',
            progress: JSON.parse(String(params?.[7])),
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
        if (sql.includes('insert into tts_render_plans_v2')) {
          expect(params?.[6]).toBe('queued');
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('insert into tts_render_items_v2')) {
          expect(params?.[5]).toBe('queued');
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const providerQueue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const app = await appWithAIRoutes(pool, providerQueue);

    const request = {
      method: 'POST' as const,
      url: '/api/chapters/chapter_1/tts-cache/resolve',
      payload: {
        providerId: 'local-endpoint',
        voiceProfileId: 'voice_local_1',
        speakerId: 'char_1',
        segmentIds: ['seg_1'],
        inputTextHash,
        providerOptions: { speed: 1, tone: 'calm' },
        audioCharacters: 12,
        rawText: 'must-not-be-used',
      },
    };
    const response = await app.inject(request);

    expect(response.statusCode, response.body).toBe(202);
    expect(response.body).not.toContain('must-not-be-used');
    const body = response.json();
    expect(body.cacheHit).toBe(false);
    expect(body.job).toMatchObject({
      type: 'tts_synthesis',
      providerId: 'local-endpoint',
      modelId: 'local-tts-a',
      status: 'queued',
    });
    expect(body.job.progress.ttsCache).toMatchObject({
      voiceProfileId: 'voice_local_1',
      speakerId: 'char_1',
      segmentIds: ['seg_1'],
      inputTextHash,
      renderSpecHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      renderSpec: expect.objectContaining({
        novelId: 'book_1',
        chapterId: 'chapter_1',
        speakerId: 'char_1',
        voiceProfileId: 'voice_local_1',
        providerId: 'local-endpoint',
        providerModel: 'local-tts-a',
        providerVoiceId: 'local-voice-1',
        voiceProfileRevision: '2026-07-06T00:00:00.000Z',
        inputTextHash,
        providerOptionsHash: body.job.progress.ttsCache.optionsHash,
        format: 'mp3',
        speed: 1,
        tone: 'calm',
        emotionPolicy: 'segment',
        segmentAnchors: [{ segmentId: 'seg_1' }],
      }),
    });
    expect(body.job.progress.ttsCache.providerOptions).toBeUndefined();
    expect(body.job.progress.budgetEstimate.renderSpecHash).toBe(body.job.progress.ttsCache.renderSpecHash);
    expect(body.job.progress.budgetEstimate).toMatchObject({
      audioCharacters: 12,
      inputCharacters: 12,
      segmentCount: 1,
      maxInputCharacters: 20000,
      maxInputSegments: 32,
    });
    expect(JSON.stringify(body.job.progress)).not.toContain('must-not-be-used');
    expectProviderAttemptEnqueued(providerQueue, body.job.id);

    const sample = buildHostedNeutralVoiceSampleRequest({
      novelId: 'book_1',
      chapterId: 'chapter_1',
      voiceProfile: {
        id: 'voice_local_1',
        novelId: 'book_1',
        characterId: 'char_1',
        role: 'character',
        providerId: 'local-endpoint',
        providerVoiceId: 'local-voice-1',
        providerModel: 'local-tts-a',
        label: 'Local voice',
        language: 'ko-KR',
        speed: 1,
        tone: 'profile-calm',
        providerOptions: { voice: 'local-voice-1' },
        isUserSelected: true,
      },
    });
    expect(sample).toBeDefined();
    const sampleResponse = await app.inject({
      method: 'POST',
      url: '/api/chapters/chapter_1/tts-cache/resolve',
      payload: sample!.request,
    });
    expect(sampleResponse.statusCode, sampleResponse.body).toBe(202);
    expect(sampleResponse.json().job.progress.ttsCache).toMatchObject({
      sampleTextId: 'neutral-ko-v1',
      cachePurpose: 'voice_sample',
      segmentIds: ['voice-sample:neutral-ko-v1'],
    });
    expect(sampleResponse.body).not.toContain(sample!.text);
    await app.close();

    const limitedQueue = { add: vi.fn() } as unknown as Queue;
    const limitedApp = await appWithAIRoutes(pool, limitedQueue, {
      limit: 'attempts_per_utc_day',
      retryAfterSeconds: 3600,
    });
    const limitedResponse = await limitedApp.inject(request);

    expect(limitedResponse.statusCode).toBe(429);
    expect(limitedResponse.headers['retry-after']).toBe('3600');
    expect(limitedResponse.json()).toEqual({
      error: 'provider_job_admission_rejected',
      code: 'provider_job_admission_rejected',
      limit: 'attempts_per_utc_day',
      retryAfterSeconds: 3600,
    });
    expect(limitedResponse.body).not.toContain('must-not-be-used');
    expect(limitedQueue.add).not.toHaveBeenCalled();
    await limitedApp.close();
  });

  it('rejects stale voice casting before accepting a cache hit or mutating TTS state', async () => {
    vi.stubEnv('TTS_PROVIDER_ENABLED', 'local-endpoint');
    vi.stubEnv('TTS_LOCAL_ENDPOINT_MODEL_ID', 'local-tts-a');
    vi.stubEnv('TTS_LOCAL_ENDPOINT_URL', 'http://127.0.0.1:9010/synthesize');
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from provider_settings')) return { rows: [] };
        if (sql.includes('select c.book_id')) return { rows: [{ book_id: 'book_1' }] };
        if (sql.includes('select profile.id, profile.provider_id')) {
          expect(params).toEqual(['user_test', 'book_1', ['voice_current']]);
          return { rows: [{ id: 'voice_current', provider_id: 'local-endpoint' }] };
        }
        if (sql.includes('from voice_profiles')) {
          return {
            rows: [
              {
                id: 'voice_stale',
                book_id: 'book_1',
                character_id: 'client_speaker_must_not_control_casting',
                role: 'character',
                provider_id: 'local-endpoint',
                provider_voice_id: 'local-voice-stale',
                provider_model: 'local-tts-a',
                label: 'Stale voice',
                language: 'ko-KR',
                tone: null,
                speed: 1,
                pitch: null,
                emotion_policy: 'segment',
                provider_options: {},
                is_user_selected: true,
                created_at: '2026-07-05T00:00:00.000Z',
                updated_at: '2026-07-06T00:00:00.000Z',
              },
            ],
          };
        }
        if (sql.includes('voice_casting_states')) {
          expect(params).toEqual(['user_test', 'book_1']);
          return {
            rows: [
              {
                active_content_revision_id: 'content_1',
                state_payload: {
                  contentRevisionId: 'content_1',
                  status: 'active',
                  assignments: [
                    {
                      id: 'assignment_current',
                      bookId: 'book_1',
                      contentRevisionId: 'content_1',
                      speakerEntityId: 'speaker_from_provenance',
                      voiceProfileId: 'voice_current',
                      effectiveFromOrder: 0,
                      status: 'active',
                      userPinned: true,
                    },
                  ],
                },
              },
            ],
          };
        }
        if (sql.includes('from accepted_speaker_provenance')) {
          expect(params).toEqual(['user_test', 'book_1', 'content_1', 'chapter_1', ['seg_1']]);
          return {
            rows: [
              {
                id: 'accepted_1',
                segment_id: 'seg_1',
                narrative_order: 7,
                speaker_entity_id: 'speaker_from_provenance',
              },
            ],
          };
        }
        if (sql.includes('tts_audio_cache') || /\b(insert|update|delete)\b/i.test(sql)) {
          throw new Error('stale voice casting must be rejected before cache access or mutation');
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/chapters/chapter_1/tts-cache/resolve',
      payload: {
        providerId: 'local-endpoint',
        voiceProfileId: 'voice_stale',
        speakerId: 'speaker_from_client',
        segmentIds: ['seg_1'],
        inputTextHash: 'text_hash_only',
        providerOptions: {},
        audioCharacters: 12,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'voice_casting_stale', code: 'voice_casting_stale' });
    expect(
      (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([sql]) =>
        String(sql).includes('tts_audio_cache'),
      ),
    ).toBe(false);
    await app.close();
  });

  it('rejects TTS cache requests that exceed provider synthesis budgets before storage access', async () => {
    vi.stubEnv('TTS_PROVIDER_ENABLED', 'local-endpoint');
    vi.stubEnv('TTS_LOCAL_ENDPOINT_MODEL_ID', 'local-tts-a');
    vi.stubEnv('TTS_LOCAL_ENDPOINT_URL', 'http://127.0.0.1:9010/synthesize');
    vi.stubEnv('TTS_LOCAL_ENDPOINT_MAX_INPUT_CHARACTERS', '5');
    vi.stubEnv('TTS_LOCAL_ENDPOINT_MAX_SEGMENTS', '1');
    const pool = {
      query: vi.fn(async () => {
        throw new Error('database should not be reached for over-budget TTS cache resolve');
      }),
    } as unknown as pg.Pool;
    const providerQueue = {
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
    } as unknown as Queue;
    const app = await appWithAIRoutes(pool, providerQueue);

    const segmentResponse = await app.inject({
      method: 'POST',
      url: '/api/chapters/chapter_1/tts-cache/resolve',
      payload: {
        providerId: 'local-endpoint',
        voiceProfileId: 'voice_local_1',
        speakerId: 'char_1',
        segmentIds: ['seg_1', 'seg_2'],
        inputTextHash: 'text_hash_only',
        providerOptions: {},
        audioCharacters: 4,
      },
    });
    expect(segmentResponse.statusCode).toBe(413);
    expect(segmentResponse.json()).toEqual({
      error: 'TTS synthesis request exceeds provider segment budget',
      segmentCount: 2,
      maxInputSegments: 1,
    });

    const characterResponse = await app.inject({
      method: 'POST',
      url: '/api/chapters/chapter_1/tts-cache/resolve',
      payload: {
        providerId: 'local-endpoint',
        voiceProfileId: 'voice_local_1',
        speakerId: 'char_1',
        segmentIds: ['seg_1'],
        inputTextHash: 'text_hash_only',
        providerOptions: {},
        audioCharacters: 12,
      },
    });
    expect(characterResponse.statusCode).toBe(413);
    expect(characterResponse.json()).toEqual({
      error: 'TTS synthesis request exceeds provider character budget',
      audioCharacters: 12,
      maxInputCharacters: 5,
    });
    expect(pool.query).not.toHaveBeenCalled();
    expect(providerQueue.add).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects malformed TTS cache resolve requests before storage access', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('database should not be reached for malformed TTS cache resolve');
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({
      method: 'POST',
      url: '/api/chapters/chapter_1/tts-cache/resolve',
      payload: {
        providerId: 'openai-tts',
        voiceProfileId: 'voice_openai_1',
        speakerId: 'char_1',
        segmentIds: ['seg_1'],
        inputTextHash: 'text_hash_only',
        providerOptions: 'not-an-object',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'providerOptions must be an object' });
    expect(pool.query).not.toHaveBeenCalled();

    const secretResponse = await app.inject({
      method: 'POST',
      url: '/api/chapters/chapter_1/tts-cache/resolve',
      payload: {
        providerId: 'openai-tts',
        voiceProfileId: 'voice_openai_1',
        speakerId: 'char_1',
        segmentIds: ['seg_1'],
        inputTextHash: 'text_hash_only',
        providerOptions: { Authorization: 'Bearer must-not-store' },
      },
    });
    expect(secretResponse.statusCode).toBe(400);
    expect(secretResponse.json()).toEqual({ error: 'providerOptions must not contain secret-like keys or values' });
    expect(pool.query).not.toHaveBeenCalled();

    const invalidSpecResponse = await app.inject({
      method: 'POST',
      url: '/api/chapters/chapter_1/tts-cache/resolve',
      payload: {
        providerId: 'openai-tts',
        voiceProfileId: 'voice_openai_1',
        speakerId: 'char_1',
        segmentIds: ['seg_1'],
        inputTextHash: 'text_hash_only',
        providerOptions: {},
        renderSpec: { segmentAnchors: [] },
      },
    });
    expect(invalidSpecResponse.statusCode).toBe(400);
    expect(invalidSpecResponse.json().error).toBe('TTS render spec segmentAnchors must not be empty');
    expect(pool.query).not.toHaveBeenCalled();
    await app.close();
  });
});
