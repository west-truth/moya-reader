import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../../../../src/repositories/reader-defaults';
import { appWithBooks } from './books-route-test-harness.js';

const updatedAt = '2026-09-04T00:00:00.000Z';
const integrationSettings = {
  schemaVersion: 1,
  updatedAt,
  extensionEnablement: { schemaVersion: 1, enabledByExtensionId: { 'moya.extension.metadata': true } },
  webNovelMetadata: {
    schemaVersion: 1,
    includeAdult: false,
    automaticLookup: true,
    automaticApply: 'missing_fields',
  },
  externalSources: { schemaVersion: 1, connections: [], links: [], subscriptions: [] },
} as const;

describe('self-host integration settings routes', () => {
  it('serves the reserved integration document without leaking it through reader settings', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("settings -> '_moyaIntegrations'"))
        return { rows: [{ integration_settings: integrationSettings }] };
      if (sql.includes('select settings from reader_settings')) {
        return { rows: [{ settings: { ...defaultSettings, _moyaIntegrations: integrationSettings } }] };
      }
      return { rows: [] };
    });
    const app = await appWithBooks({ query } as unknown as pg.Pool);

    const integrations = await app.inject({ method: 'GET', url: '/api/integration-settings' });
    expect(integrations.statusCode).toBe(200);
    expect(integrations.json()).toEqual({ settings: integrationSettings });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("->> 'updatedAt' is distinct from $2"), [
      'user_test',
      null,
    ]);

    const reader = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(reader.statusCode).toBe(200);
    expect(reader.json().settings).not.toHaveProperty('_moyaIntegrations');
    await app.close();
  });

  it('rejects secrets and preserves the reserved document in ordinary settings upserts', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const app = await appWithBooks({ query } as unknown as pg.Pool);
    const withSecret = {
      ...integrationSettings,
      externalSources: {
        ...integrationSettings.externalSources,
        connections: [
          {
            schemaVersion: 1,
            connectorId: 'moya.external.suwayomi.sources',
            accountConnectionId: 'account-1',
            endpoint: 'https://reader:password@suwayomi.example.test',
            authMode: 'basic_auth',
            label: 'Suwayomi',
            updatedAt,
          },
        ],
      },
    };
    const rejected = await app.inject({ method: 'PUT', url: '/api/integration-settings', payload: withSecret });
    expect(rejected.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'PUT',
      url: '/api/integration-settings',
      payload: integrationSettings,
    });
    expect(accepted.statusCode).toBe(200);
    expect(query.mock.calls.at(-1)?.[0]).toContain("jsonb_set(reader_settings.settings, '{_moyaIntegrations}'");

    await app.inject({ method: 'PUT', url: '/api/settings', payload: defaultSettings });
    const readerSettingsUpsert = query.mock.calls.find(([sql]) =>
      String(sql).includes("jsonb_build_object('_moyaIntegrations'"),
    );
    expect(readerSettingsUpsert).toBeDefined();
    await app.close();
  });
});
