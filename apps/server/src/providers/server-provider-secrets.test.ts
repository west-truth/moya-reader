import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import {
  applyProviderSecretStatusesToCatalog,
  buildProviderSecretStatuses,
  resolveProviderSecrets,
  saveProviderSecret,
} from './server-provider-secrets.js';
import { listServerProviderCatalog } from './server-provider-catalog.js';
import { loadServerAISettings } from './server-ai-config.js';

function testConfig(dataDir: string): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir,
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

describe('server provider secrets', () => {
  it('stores encrypted provider secrets and resolves only at provider boundary', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noveldesk-provider-secrets-'));
    const rows: Record<string, unknown>[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
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
          rows.splice(0, rows.length, row);
          return { rows: [row] };
        }
        if (sql.includes('from provider_secrets') && sql.includes('provider_id')) return { rows };
        if (sql.includes('from provider_secrets')) return { rows };
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as pg.Pool;
    const config = testConfig(dataDir);

    const status = await saveProviderSecret(pool, config, {
      scope: 'llm_labeling',
      providerId: 'openai',
      secretValue: 'sk-proj-test-secret-1234',
    });

    expect(status).toMatchObject({
      providerId: 'openai',
      secretName: 'api_key',
      configured: true,
      source: 'user_encrypted',
      last4: '1234',
    });
    expect(JSON.stringify(rows)).not.toContain('sk-proj-test-secret-1234');
    await expect(resolveProviderSecrets(pool, config, 'llm_labeling', 'openai')).resolves.toEqual({
      apiKey: 'sk-proj-test-secret-1234',
    });
  });

  it('overlays user encrypted secret status over env catalog readiness', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noveldesk-provider-secrets-'));
    const rows: Record<string, unknown>[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
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
          rows.push(row);
          return { rows: [row] };
        }
        if (sql.includes('from provider_secrets')) return { rows };
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as pg.Pool;
    const config = testConfig(dataDir);
    const env = {
      AI_PROVIDER_ENABLED: 'mock',
      AI_OPENAI_LABELING_MODEL_ID: 'gpt-labeler',
    };
    const catalog = listServerProviderCatalog(env, loadServerAISettings(env));
    expect(catalog.aiProviders.find((provider) => provider.providerId === 'openai')?.enabled).toBe(false);
    expect(catalog.aiProviders.find((provider) => provider.providerId === 'openai')?.secretConfigured).toBe(false);

    await saveProviderSecret(
      pool,
      config,
      {
        scope: 'llm_labeling',
        providerId: 'openai',
        secretValue: 'sk-proj-user-secret',
      },
      env,
    );
    const statuses = await buildProviderSecretStatuses(pool, config, catalog, env);
    const overlay = applyProviderSecretStatusesToCatalog(catalog, statuses);

    expect(overlay.aiProviders.find((provider) => provider.providerId === 'openai')).toMatchObject({
      enabled: true,
      secretConfigured: true,
      secretPolicy: 'server_encrypted_store',
      secretStatus: expect.objectContaining({ source: 'user_encrypted' }),
    });
  });

  it('does not expose path or endpoint URL hints in secret status responses', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noveldesk-provider-secrets-'));
    const rows: Record<string, unknown>[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
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
          rows.push(row);
          return { rows: [row] };
        }
        if (sql.includes('from provider_secrets')) return { rows };
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as pg.Pool;
    const config = testConfig(dataDir);

    const credentialStatus = await saveProviderSecret(pool, config, {
      scope: 'llm_labeling',
      providerId: 'gemini-vertex',
      secretValue: 'C:/Users/example/vertex-service-account.json',
    });
    const endpointStatus = await saveProviderSecret(pool, config, {
      scope: 'tts_synthesis',
      providerId: 'local-endpoint',
      secretValue: 'http://127.0.0.1:9000/synthesize',
    });

    expect(credentialStatus).toMatchObject({
      configured: true,
      secretName: 'credential_path',
      last4: undefined,
      fingerprint: undefined,
    });
    expect(endpointStatus).toMatchObject({
      configured: true,
      secretName: 'endpoint_url',
      last4: undefined,
      fingerprint: undefined,
    });
  });
});
