import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { appWithAIRoutes } from './ai-route-test-harness.js';

describe('AI provider integration routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('lists server provider catalog without exposing secret values', async () => {
    vi.stubEnv('AI_PROVIDER_ENABLED', 'mock,openai,gemini-vertex');
    vi.stubEnv('AI_OPENAI_LABELING_MODEL_ID', 'gpt-labeler-test');
    vi.stubEnv('OPENAI_API_KEY', 'sk-secret-test');
    const pool = {
      query: vi.fn(async () => {
        throw new Error('database should not be reached for provider catalog');
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const response = await app.inject({ method: 'GET', url: '/api/providers' });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('sk-secret-test');
    const body = response.json();
    expect(body).toMatchObject({
      aiProviders: expect.arrayContaining([
        expect.objectContaining({
          providerId: 'openai',
          enabled: true,
          implemented: true,
          secretConfigured: true,
          models: [expect.objectContaining({ modelId: 'gpt-labeler-test' })],
          capabilities: expect.objectContaining({
            supportedRequestProfiles: expect.arrayContaining([
              expect.objectContaining({
                profileId: 'chapter-labeling-v1',
                promptVersion: 'chapter-labeler-v1',
                schemaVersion: 'chapter-labeling-result-v1',
              }),
              expect.objectContaining({
                profileId: 'chapter-labeling-v1-strict-tts',
                promptVersion: 'chapter-labeler-v1-strict-tts-windowed',
                schemaVersion: 'chapter-labeling-result-v1',
              }),
            ]),
          }),
        }),
        expect.objectContaining({
          providerId: 'gemini-vertex',
          enabled: true,
          implemented: true,
        }),
      ]),
      ttsProviders: expect.arrayContaining([
        expect.objectContaining({ providerId: 'system', enabled: true, implemented: true }),
        expect.objectContaining({ providerId: 'elevenlabs', implemented: true }),
        expect.objectContaining({ providerId: 'gemini-tts', implemented: true }),
        expect.objectContaining({ providerId: 'gemini-vertex-tts', implemented: true }),
        expect.objectContaining({ providerId: 'google-cloud-tts', implemented: true }),
      ]),
    });
    expect(body.ttsProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'openai-tts',
          capabilities: expect.objectContaining({
            supportedRenderOptions: expect.arrayContaining([
              expect.objectContaining({ optionKey: 'format', valueType: 'select' }),
              expect.objectContaining({ optionKey: 'speed', min: 0.25, max: 4 }),
              expect.objectContaining({ optionKey: 'tone' }),
              expect.objectContaining({ optionKey: 'emotion' }),
            ]),
            supportedProviderOptions: expect.arrayContaining([
              expect.objectContaining({ optionKey: 'voice', placements: expect.arrayContaining(['voice_profile']) }),
              expect.objectContaining({ optionKey: 'responseFormat', valueType: 'select' }),
              expect.objectContaining({ optionKey: 'instructions' }),
            ]),
            allowsCustomProviderOptions: false,
          }),
        }),
        expect.objectContaining({
          providerId: 'elevenlabs',
          models: [
            expect.objectContaining({
              maxInputCharacters: 5000,
              maxInputSegments: 12,
            }),
          ],
          capabilities: expect.objectContaining({
            supportedProviderOptions: expect.arrayContaining([
              expect.objectContaining({ optionKey: 'stability', min: 0, max: 1 }),
              expect.objectContaining({ optionKey: 'similarityBoost', min: 0, max: 1 }),
              expect.objectContaining({ optionKey: 'useSpeakerBoost', valueType: 'boolean' }),
            ]),
          }),
        }),
        expect.objectContaining({
          providerId: 'local-endpoint',
          capabilities: expect.objectContaining({
            supportedProviderOptions: expect.arrayContaining([expect.objectContaining({ optionKey: 'voice' })]),
            allowsCustomProviderOptions: true,
          }),
        }),
      ]),
    );
    await app.close();
  });

  it('stores provider settings without accepting provider secrets', async () => {
    vi.stubEnv('AI_PROVIDER_ENABLED', 'mock,openai');
    vi.stubEnv('AI_OPENAI_LABELING_MODEL_ID', 'gpt-env-labeler');
    vi.stubEnv('OPENAI_API_KEY', 'sk-secret-test');
    vi.stubEnv('TTS_PROVIDER_ENABLED', 'local-endpoint');
    vi.stubEnv('TTS_LOCAL_ENDPOINT_MODEL_ID', 'local-tts-env');
    vi.stubEnv('TTS_LOCAL_ENDPOINT_URL', 'http://127.0.0.1:9010/synthesize');
    const providerSettingsRows = new Map<string, Record<string, unknown>>();
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from provider_settings')) {
          return { rows: [...providerSettingsRows.values()] };
        }
        if (sql.includes('insert into provider_settings')) {
          const row = {
            scope: params?.[2],
            default_provider_id: params?.[3],
            enabled_provider_ids: JSON.parse(String(params?.[4])),
            model_overrides: JSON.parse(String(params?.[5])),
            provider_options: JSON.parse(String(params?.[6])),
            updated_at: '2026-07-06T00:00:00.000Z',
          };
          providerSettingsRows.set(String(row.scope), row);
          return { rows: [row] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const saveResponse = await app.inject({
      method: 'PUT',
      url: '/api/provider-settings/llm_labeling',
      payload: {
        defaultProviderId: 'openai',
        enabledProviderIds: ['mock', 'openai', 'gemini-vertex'],
        modelByProvider: { openai: 'gpt-saved-labeler' },
        providerOptionsByProvider: { openai: { temperature: 0.1, maxOutputTokens: 2048 } },
      },
    });
    expect(saveResponse.statusCode).toBe(200);
    expect(saveResponse.body).not.toContain('sk-secret-test');
    expect(saveResponse.json().settings).toMatchObject({
      scope: 'llm_labeling',
      defaultProviderId: 'openai',
      enabledProviderIds: ['mock', 'openai', 'gemini-vertex'],
      modelByProvider: expect.objectContaining({ openai: 'gpt-saved-labeler' }),
    });

    const secretResponse = await app.inject({
      method: 'PUT',
      url: '/api/provider-settings/llm_labeling',
      payload: {
        defaultProviderId: 'openai',
        providerOptionsByProvider: { openai: { apiKey: 'must-not-store' } },
      },
    });
    expect(secretResponse.statusCode).toBe(400);
    expect(secretResponse.body).not.toContain('must-not-store');

    const headerSecretResponse = await app.inject({
      method: 'PUT',
      url: '/api/provider-settings/tts_synthesis',
      payload: {
        defaultProviderId: 'local-endpoint',
        providerOptionsByProvider: {
          'local-endpoint': { headers: { Authorization: 'Bearer must-not-store-header' } },
        },
      },
    });
    expect(headerSecretResponse.statusCode).toBe(400);
    expect(headerSecretResponse.body).not.toContain('must-not-store-header');

    const valueSecretResponse = await app.inject({
      method: 'PUT',
      url: '/api/provider-settings/llm_labeling',
      payload: {
        modelByProvider: { openai: 'sk-proj-must-not-store-model-secret' },
      },
    });
    expect(valueSecretResponse.statusCode).toBe(400);
    expect(valueSecretResponse.body).not.toContain('sk-proj-must-not-store-model-secret');

    const partialResponse = await app.inject({
      method: 'PUT',
      url: '/api/provider-settings/llm_labeling',
      payload: {
        modelByProvider: { mock: 'mock-partial-labeler' },
      },
    });
    expect(partialResponse.statusCode).toBe(200);
    expect(partialResponse.json().settings).toMatchObject({
      defaultProviderId: 'openai',
      enabledProviderIds: ['mock', 'openai', 'gemini-vertex'],
      modelByProvider: expect.objectContaining({
        openai: 'gpt-saved-labeler',
        mock: 'mock-partial-labeler',
      }),
      providerOptionsByProvider: { openai: { temperature: 0.1, maxOutputTokens: 2048 } },
    });

    const replaceOptionsResponse = await app.inject({
      method: 'PUT',
      url: '/api/provider-settings/llm_labeling',
      payload: {
        providerOptionsByProvider: { openai: {} },
      },
    });
    expect(replaceOptionsResponse.statusCode).toBe(200);
    expect(replaceOptionsResponse.json().settings.providerOptionsByProvider.openai).toEqual({});

    const getResponse = await app.inject({ method: 'GET', url: '/api/provider-settings' });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.body).not.toContain('sk-secret-test');
    expect(getResponse.json().settings.llmLabeling.defaultProviderId).toBe('openai');
    await app.close();
  });

  it('stores hosted provider secrets separately from provider settings', async () => {
    vi.stubEnv('PROVIDER_SECRET_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.stubEnv('AI_PROVIDER_ENABLED', 'mock,openai');
    vi.stubEnv('AI_OPENAI_LABELING_MODEL_ID', 'gpt-labeler');
    const secretRows = new Map<string, Record<string, unknown>>();
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('from provider_secrets')) {
          return { rows: [...secretRows.values()] };
        }
        if (sql.includes('insert into provider_secrets')) {
          const row = {
            scope: params?.[2],
            provider_id: params?.[3],
            secret_name: params?.[4],
            ciphertext: params?.[5],
            iv: params?.[6],
            auth_tag: params?.[7],
            key_version: params?.[8],
            fingerprint: params?.[9],
            last4: params?.[10],
            updated_at: '2026-07-06T00:00:00.000Z',
          };
          secretRows.set(`${row.scope}:${row.provider_id}:${row.secret_name}`, row);
          return { rows: [row] };
        }
        if (sql.includes('delete from provider_secrets')) {
          secretRows.delete(`${params?.[1]}:${params?.[2]}:${params?.[3]}`);
          return { rows: [] };
        }
        if (sql.includes('from provider_settings')) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const app = await appWithAIRoutes(pool);

    const saveResponse = await app.inject({
      method: 'PUT',
      url: '/api/provider-secrets/llm_labeling/openai/api_key',
      payload: { secretValue: 'sk-proj-route-secret-9999' },
    });

    expect(saveResponse.statusCode).toBe(200);
    expect(saveResponse.body).not.toContain('sk-proj-route-secret-9999');
    expect(saveResponse.json().status).toMatchObject({
      providerId: 'openai',
      configured: true,
      source: 'user_encrypted',
      last4: '9999',
    });
    expect(JSON.stringify([...secretRows.values()])).not.toContain('sk-proj-route-secret-9999');

    const settingsResponse = await app.inject({ method: 'GET', url: '/api/provider-settings' });
    expect(settingsResponse.statusCode).toBe(200);
    expect(settingsResponse.body).not.toContain('sk-proj-route-secret-9999');
    expect(settingsResponse.json().catalog.aiProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'openai',
          secretConfigured: true,
          secretStatus: expect.objectContaining({ source: 'user_encrypted', last4: '9999' }),
        }),
      ]),
    );
    await app.close();
  });
});
