import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { processProviderJob } from './provider-job-service.js';
import { hashSync } from '@noveldesk/text-core/legacy-hash';
import { integrityHash } from '@noveldesk/text-core/hash';
import { ttsRenderSpecHash, type TTSRenderSpec } from '../../../../src/providers/tts-render-spec';
import { ttsProviderOptionsIntegrityHash } from '@noveldesk/text-core/identity/tts';
import { testConfig } from './provider-jobs/provider-job-test-harness.js';
import {
  TTS_NEUTRAL_SAMPLE_KO_V1,
  ttsVoiceSampleSegmentId,
  ttsVoiceSampleText,
} from '../../../../src/providers/tts-voice-samples';

describe('provider job TTS', () => {
  it('synthesizes TTS jobs from server segment text and stores audio cache metadata', async () => {
    const inputText = '"Hello."';
    const inputTextHash = hashSync(inputText);
    const segmentTextHash = hashSync(inputText);
    const renderSpec: TTSRenderSpec = {
      novelId: 'book_1',
      chapterId: 'chapter_1',
      speakerId: 'char_1',
      voiceProfileId: 'voice_1',
      providerId: 'local-endpoint',
      providerModel: 'local-model',
      providerVoiceId: 'voice-local-1',
      voiceProfileRevision: '2026-07-05T00:00:00.000Z',
      segmentAnchors: [
        {
          segmentId: 'seg_1',
          paragraphId: 'paragraph_1',
          startOffset: 0,
          endOffset: inputText.length,
          segmentTextHash,
        },
      ],
      inputTextHash,
      providerOptionsHash: 'opts_1',
      format: 'mp3',
      speed: 1.25,
      tone: 'focused',
      emotion: 'tense',
      emotionPolicy: 'segment',
    };
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_tts_1',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'tts_synthesis',
      provider_id: 'local-endpoint',
      model_id: 'local-model',
      input_hash: 'input_hash',
      status: 'queued',
      stage: 'queued',
      progress: {
        ttsCache: {
          cacheKey: 'tts_cache_1',
          voiceProfileId: 'voice_1',
          speakerId: 'char_1',
          segmentIds: ['seg_1'],
          inputTextHash,
          optionsHash: 'opts_1',
          renderSpecHash: ttsRenderSpecHash(renderSpec),
          renderSpec,
          providerOptions: { style: 'calm' },
        },
      },
    };
    const cacheRows: Record<string, unknown>[] = [];
    const writes: Array<{ key: string; body: Buffer; contentType: string }> = [];
    const provider = {
      providerId: 'local-endpoint',
      displayName: 'Local TTS Endpoint',
      supportsStreaming: false,
      supportsAudioCache: true,
      supportsPerCharacterVoice: true,
      synthesize: vi.fn(async () => ({
        audio: Uint8Array.from([0x49, 0x44, 0x33, 0x04]).buffer,
        contentType: 'audio/mpeg',
        durationMs: 321,
        providerMetadata: { ok: true },
      })),
    };

    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) {
        return { rows: [jobRow] };
      }
      if (sql.trim() === 'begin' || sql.trim() === 'commit' || sql.trim() === 'rollback') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.trim().startsWith('update provider_jobs')) {
        const values = params ?? [];
        if (values.includes('running')) jobRow.status = 'running';
        if (values.includes('succeeded')) jobRow.status = 'succeeded';
        if (values.includes('failed')) jobRow.status = 'failed';
        const stage = values.find((value) =>
          ['loading_tts_input', 'synthesizing_tts', 'writing_tts_cache', 'ready', 'failed'].includes(String(value)),
        );
        if (stage) jobRow.stage = stage;
        const progressIndex = values.findIndex((value) => typeof value === 'string' && String(value).startsWith('{'));
        if (progressIndex >= 0) jobRow.progress = JSON.parse(String(values[progressIndex]));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from tts_audio_cache') && sql.includes('select id')) {
        return { rows: [] };
      }
      if (sql.includes('from voice_profiles')) {
        return {
          rows: [
            {
              id: 'voice_1',
              book_id: 'book_1',
              character_id: 'char_1',
              role: 'character',
              provider_id: 'local-endpoint',
              provider_voice_id: 'voice-local-1',
              provider_model: 'local-model',
              label: 'Character voice',
              language: 'ko-KR',
              tone: 'calm',
              speed: 1.05,
              pitch: null,
              emotion_policy: null,
              provider_options: { voice: 'local' },
              is_user_selected: true,
              created_at: '2026-07-05T00:00:00.000Z',
              updated_at: '2026-07-05T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('from labeled_segments s')) {
        return {
          rows: [
            {
              id: 'seg_1',
              paragraph_id: 'paragraph_1',
              segment_index: 0,
              start_offset: 0,
              end_offset: inputText.length,
              segment_text_hash: segmentTextHash,
              speaker_id: 'char_1',
              emotion: 'neutral',
              text: inputText,
            },
          ],
        };
      }
      if (sql.includes('insert into tts_audio_cache')) {
        cacheRows.push({
          id: params?.[0],
          book_id: params?.[1],
          chapter_id: params?.[2],
          cache_key: params?.[3],
          provider_id: params?.[4],
          provider_model: params?.[5],
          voice_profile_id: params?.[6],
          speaker_id: params?.[7],
          segment_ids: JSON.parse(String(params?.[8])),
          segment_text_hashes: JSON.parse(String(params?.[9])),
          input_text_hash: params?.[10],
          options_hash: params?.[11],
          render_spec_hash: params?.[12],
          audio_object_key: params?.[13],
          content_type: params?.[14],
          byte_size: params?.[15],
          audio_hash: params?.[16],
          duration_ms: params?.[17],
        });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = {
      query: handleQuery,
      release: vi.fn(),
    };
    const pool = {
      query: handleQuery,
      connect: vi.fn(async () => client),
    } as unknown as pg.Pool;

    await processProviderJob(pool, testConfig(), 'provider_job_tts_1', {
      createTTSProvider: () => provider,
      s3Client: {} as never,
      putTtsAudioObject: vi.fn(async (_client, _config, key, body, contentType) => {
        writes.push({ key, body, contentType });
      }),
    });

    expect(jobRow.status).toBe('succeeded');
    expect(jobRow.stage).toBe('ready');
    expect(provider.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: inputText,
        emotion: 'tense',
        tone: 'focused',
        speed: 1.25,
        format: 'mp3',
        providerOptions: { style: 'calm' },
      }),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      key: 'tts/book_1/chapter_1/tts_cache_1.mp3',
      contentType: 'audio/mpeg',
    });
    expect([...writes[0].body]).toEqual([0x49, 0x44, 0x33, 0x04]);
    expect(cacheRows).toHaveLength(1);
    expect(cacheRows[0]).toMatchObject({
      cache_key: 'tts_cache_1',
      provider_id: 'local-endpoint',
      voice_profile_id: 'voice_1',
      segment_ids: ['seg_1'],
      segment_text_hashes: { seg_1: integrityHash(inputText) },
      input_text_hash: integrityHash(inputText),
      render_spec_hash: ttsRenderSpecHash(renderSpec),
      content_type: 'audio/mpeg',
      byte_size: 4,
      audio_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      duration_ms: 321,
    });
  });

  it('synthesizes a registered neutral sample without accepting or loading raw segment text', async () => {
    const inputText = ttsVoiceSampleText(TTS_NEUTRAL_SAMPLE_KO_V1)!;
    const segmentId = ttsVoiceSampleSegmentId(TTS_NEUTRAL_SAMPLE_KO_V1);
    const inputTextHash = integrityHash(inputText);
    const renderSpec: TTSRenderSpec = {
      novelId: 'book_1',
      chapterId: 'chapter_1',
      speakerId: 'char_1',
      voiceProfileId: 'voice_sample_1',
      providerId: 'local-endpoint',
      providerModel: 'local-model',
      providerVoiceId: 'voice-local-1',
      segmentAnchors: [{ segmentId }],
      inputTextHash,
      providerOptionsHash: ttsProviderOptionsIntegrityHash({}),
      format: 'mp3',
      speed: 1,
    };
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_tts_sample',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'tts_synthesis',
      provider_id: 'local-endpoint',
      model_id: 'local-model',
      input_hash: 'sample_input_hash',
      status: 'queued',
      stage: 'queued',
      progress: {
        ttsCache: {
          cacheKey: 'tts_sample_cache_1',
          voiceProfileId: 'voice_sample_1',
          speakerId: 'char_1',
          segmentIds: [segmentId],
          inputTextHash,
          optionsHash: ttsProviderOptionsIntegrityHash({}),
          renderSpecHash: ttsRenderSpecHash(renderSpec),
          renderSpec,
          sampleTextId: TTS_NEUTRAL_SAMPLE_KO_V1,
          cachePurpose: 'voice_sample',
          providerOptions: {},
        },
      },
    };
    const provider = {
      providerId: 'local-endpoint',
      displayName: 'Local TTS Endpoint',
      supportsStreaming: false,
      supportsAudioCache: true,
      supportsPerCharacterVoice: true,
      synthesize: vi.fn(async () => ({
        audio: Uint8Array.from([0x49, 0x44, 0x33, 0x04]).buffer,
        contentType: 'audio/mpeg',
      })),
    };
    const insertedCacheParams: unknown[][] = [];
    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) return { rows: [jobRow] };
      if (sql.trim() === 'begin' || sql.trim() === 'commit' || sql.trim() === 'rollback') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.trim().startsWith('update provider_jobs')) {
        const values = params ?? [];
        if (values.includes('running')) jobRow.status = 'running';
        if (values.includes('succeeded')) jobRow.status = 'succeeded';
        const stage = values.find((value) =>
          ['loading_tts_input', 'synthesizing_tts', 'writing_tts_cache', 'ready'].includes(String(value)),
        );
        if (stage) jobRow.stage = stage;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from tts_audio_cache') && sql.includes('select id')) return { rows: [] };
      if (sql.includes('from voice_profiles')) {
        return {
          rows: [
            {
              id: 'voice_sample_1',
              book_id: 'book_1',
              character_id: 'char_1',
              role: 'character',
              provider_id: 'local-endpoint',
              provider_voice_id: 'voice-local-1',
              provider_model: 'local-model',
              label: 'Sample voice',
              language: 'ko-KR',
              tone: null,
              speed: 1,
              pitch: null,
              emotion_policy: null,
              provider_options: {},
              is_user_selected: true,
              created_at: '2026-07-05T00:00:00.000Z',
              updated_at: '2026-07-05T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('from labeled_segments s')) throw new Error('sample must not query labeled segment text');
      if (sql.includes('insert into tts_audio_cache')) {
        insertedCacheParams.push(params ?? []);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = { query: handleQuery, release: vi.fn() };
    const pool = { query: handleQuery, connect: vi.fn(async () => client) } as unknown as pg.Pool;

    await processProviderJob(pool, testConfig(), 'provider_job_tts_sample', {
      createTTSProvider: () => provider,
      s3Client: {} as never,
      putTtsAudioObject: vi.fn(async () => undefined),
    });

    expect(provider.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: inputText }));
    expect(insertedCacheParams).toHaveLength(1);
    expect(insertedCacheParams[0][21]).toBe('voice_sample');
    expect(insertedCacheParams[0][22]).toBe(TTS_NEUTRAL_SAMPLE_KO_V1);
    expect(jobRow.status).toBe('succeeded');
  });

  it('fails TTS jobs before provider calls when persisted provider options contain secrets', async () => {
    const inputText = '"Hello."';
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_tts_secret',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'tts_synthesis',
      provider_id: 'local-endpoint',
      model_id: 'local-model',
      input_hash: 'input_hash',
      status: 'queued',
      stage: 'queued',
      progress: {
        ttsCache: {
          cacheKey: 'tts_cache_secret',
          voiceProfileId: 'voice_secret',
          speakerId: 'char_1',
          segmentIds: ['seg_1'],
          inputTextHash: hashSync(inputText),
          optionsHash: 'opts_secret',
          providerOptions: { style: 'calm' },
        },
      },
    };
    const provider = {
      providerId: 'local-endpoint',
      displayName: 'Local TTS Endpoint',
      supportsStreaming: false,
      supportsAudioCache: true,
      supportsPerCharacterVoice: true,
      synthesize: vi.fn(),
    };

    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) {
        return { rows: [jobRow] };
      }
      if (sql.trim() === 'begin' || sql.trim() === 'commit' || sql.trim() === 'rollback') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.trim().startsWith('update provider_jobs')) {
        const values = params ?? [];
        if (values.includes('running')) jobRow.status = 'running';
        if (values.includes('failed')) jobRow.status = 'failed';
        const stage = values.find((value) => ['loading_tts_input', 'failed'].includes(String(value)));
        if (stage) jobRow.stage = stage;
        const progress = values.find((value) => typeof value === 'string' && String(value).startsWith('{'));
        if (progress) jobRow.progress = JSON.parse(String(progress));
        if (values.includes('provider_error_missing_config')) jobRow.error_code = 'provider_error_missing_config';
        const safeMessage = values.find(
          (value) => typeof value === 'string' && String(value).startsWith('Provider configuration is incomplete'),
        );
        if (safeMessage) jobRow.error_message = safeMessage;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from tts_audio_cache') && sql.includes('select id')) {
        return { rows: [] };
      }
      if (sql.includes('from voice_profiles')) {
        return {
          rows: [
            {
              id: 'voice_secret',
              book_id: 'book_1',
              character_id: 'char_1',
              role: 'character',
              provider_id: 'local-endpoint',
              provider_voice_id: 'voice-local-secret',
              provider_model: 'local-model',
              label: 'Secret voice',
              language: 'ko-KR',
              tone: 'calm',
              speed: 1,
              pitch: null,
              emotion_policy: null,
              provider_options: { apiKey: 'sk-proj-must-not-leak' },
              is_user_selected: true,
              created_at: '2026-07-05T00:00:00.000Z',
              updated_at: '2026-07-05T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('from labeled_segments s')) {
        return {
          rows: [
            {
              id: 'seg_1',
              paragraph_id: 'paragraph_1',
              segment_index: 0,
              start_offset: 0,
              end_offset: inputText.length,
              speaker_id: 'char_1',
              emotion: 'neutral',
              text: inputText,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = {
      query: handleQuery,
    } as unknown as pg.Pool;

    await expect(
      processProviderJob(pool, testConfig(), 'provider_job_tts_secret', {
        createTTSProvider: () => provider,
      }),
    ).rejects.toThrow('TTS provider options must not contain secret-like keys or values');

    expect(jobRow.status).toBe('failed');
    expect(jobRow.stage).toBe('failed');
    expect(jobRow.error_code).toBe('provider_error_missing_config');
    expect(jobRow.error_message).toBe(
      'Provider configuration is incomplete. Check enabled provider, model, voice, endpoint, and server-side credentials.',
    );
    expect(jobRow.progress).toMatchObject({
      failed: true,
      errorCategory: 'missing_config',
      retryable: false,
    });
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('fails TTS jobs before provider calls when reconstructed text exceeds the synthesis budget', async () => {
    const inputText = '"This line is longer than the queued budget."';
    const jobRow: Record<string, unknown> = {
      id: 'provider_job_tts_budget',
      user_id: 'user_test',
      book_id: 'book_1',
      chapter_id: 'chapter_1',
      job_type: 'tts_synthesis',
      provider_id: 'local-endpoint',
      model_id: 'local-model',
      input_hash: 'input_hash',
      status: 'queued',
      stage: 'queued',
      progress: {
        budgetEstimate: {
          providerId: 'local-endpoint',
          modelId: 'local-model',
          audioCharacters: 1,
          maxInputCharacters: 5,
          maxInputSegments: 1,
        },
        ttsCache: {
          cacheKey: 'tts_cache_budget',
          voiceProfileId: 'voice_budget',
          speakerId: 'char_1',
          segmentIds: ['seg_1'],
          inputTextHash: hashSync(inputText),
          optionsHash: 'opts_budget',
          providerOptions: { style: 'calm' },
        },
      },
    };
    const provider = {
      providerId: 'local-endpoint',
      displayName: 'Local TTS Endpoint',
      supportsStreaming: false,
      supportsAudioCache: true,
      supportsPerCharacterVoice: true,
      synthesize: vi.fn(),
    };

    const handleQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('select id, user_id, book_id, chapter_id')) {
        return { rows: [jobRow] };
      }
      if (sql.trim().startsWith('update provider_jobs')) {
        const values = params ?? [];
        if (values.includes('running')) jobRow.status = 'running';
        if (values.includes('failed')) jobRow.status = 'failed';
        const stage = values.find((value) => ['loading_tts_input', 'failed'].includes(String(value)));
        if (stage) jobRow.stage = stage;
        const progressIndex = values.findIndex((value) => typeof value === 'string' && String(value).startsWith('{'));
        if (progressIndex >= 0) jobRow.progress = JSON.parse(String(values[progressIndex]));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from tts_audio_cache') && sql.includes('select id')) {
        return { rows: [] };
      }
      if (sql.includes('from voice_profiles')) {
        return {
          rows: [
            {
              id: 'voice_budget',
              book_id: 'book_1',
              character_id: 'char_1',
              role: 'character',
              provider_id: 'local-endpoint',
              provider_voice_id: 'voice-local-budget',
              provider_model: 'local-model',
              label: 'Budget voice',
              language: 'ko-KR',
              tone: 'calm',
              speed: 1,
              pitch: null,
              emotion_policy: null,
              provider_options: { voice: 'local-budget' },
              is_user_selected: true,
              created_at: '2026-07-05T00:00:00.000Z',
              updated_at: '2026-07-05T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('from labeled_segments s')) {
        return {
          rows: [
            {
              id: 'seg_1',
              paragraph_id: 'paragraph_1',
              segment_index: 0,
              start_offset: 0,
              end_offset: inputText.length,
              segment_text_hash: 'segment_hash_budget',
              speaker_id: 'char_1',
              emotion: 'neutral',
              text: inputText,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = {
      query: handleQuery,
    } as unknown as pg.Pool;

    await expect(
      processProviderJob(pool, testConfig(), 'provider_job_tts_budget', {
        createTTSProvider: () => provider,
      }),
    ).rejects.toThrow(/TTS synthesis character budget exceeded/);

    expect(jobRow.status).toBe('failed');
    expect(jobRow.stage).toBe('failed');
    expect(provider.synthesize).not.toHaveBeenCalled();
  });
});
