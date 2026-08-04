import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import { loadServerAISettings } from './server-ai-config.js';
import { hasSecretLikeKey, saveProviderSettings } from './server-provider-settings.js';

function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir: '.tmp-test',
    maxChunkBytes: 1024,
    maxUploadBytes: 1024 * 1024,
    staleUploadMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    s3: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
    },
  };
}

function providerSettingsPool(): pg.Pool {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('from provider_settings')) {
        const scope = params?.[1];
        return {
          rows: [...rows.values()].filter((row) => !scope || row.scope === scope),
        };
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
        rows.set(String(row.scope), row);
        return { rows: [row] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  } as unknown as pg.Pool;
}

describe('server provider settings', () => {
  it('preserves BYO LLM providers even when they are not enabled by env allowlist', async () => {
    const env = {
      AI_PROVIDER_ENABLED: 'mock',
      AI_PROVIDER_DEFAULT: 'mock',
    };
    const settings = await saveProviderSettings(
      providerSettingsPool(),
      testConfig(),
      {
        scope: 'llm_labeling',
        defaultProviderId: 'openai',
        enabledProviderIds: ['mock', 'openai'],
        modelByProvider: { openai: 'gpt-4.1-mini' },
      },
      env,
      loadServerAISettings(env),
    );

    expect(settings).toMatchObject({
      scope: 'llm_labeling',
      defaultProviderId: 'openai',
      enabledProviderIds: ['mock', 'openai'],
      modelByProvider: expect.objectContaining({ openai: 'gpt-4.1-mini' }),
    });
  });

  it('preserves BYO hosted TTS providers even when TTS_PROVIDER_ENABLED is empty', async () => {
    const env = {};
    const settings = await saveProviderSettings(
      providerSettingsPool(),
      testConfig(),
      {
        scope: 'tts_synthesis',
        defaultProviderId: 'openai-tts',
        enabledProviderIds: ['system', 'openai-tts'],
        modelByProvider: { 'openai-tts': 'gpt-4o-mini-tts' },
      },
      env,
      loadServerAISettings(env),
    );

    expect(settings).toMatchObject({
      scope: 'tts_synthesis',
      defaultProviderId: 'openai-tts',
      enabledProviderIds: ['system', 'openai-tts'],
      modelByProvider: expect.objectContaining({ 'openai-tts': 'gpt-4o-mini-tts' }),
    });
  });

  it('treats endpoint URL options as secret-like provider settings', () => {
    expect(hasSecretLikeKey({ endpointUrl: 'http://127.0.0.1:5000/synthesize?token=secret' })).toBe(true);
    expect(hasSecretLikeKey({ endpoint_url: 'http://127.0.0.1:5000/synthesize' })).toBe(true);
    expect(hasSecretLikeKey({ sampleRate: 24000 })).toBe(false);
  });
});
