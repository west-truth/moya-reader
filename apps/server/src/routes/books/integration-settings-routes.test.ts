import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../../../../src/repositories/reader-defaults';
import { appWithBooks } from './books-route-test-harness.js';

const updatedAt = '2026-09-04T00:00:00.000Z';
const integrationSettings = {
  schemaVersion: 1,
  revision: 4,
  updatedAt,
  legacyImportCompleted: true,
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
    expect(query).toHaveBeenCalledWith(expect.stringContaining("->> 'revision', '0'"), ['user_test', null]);

    const reader = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(reader.statusCode).toBe(200);
    expect(reader.json().settings).not.toHaveProperty('_moyaIntegrations');
    await app.close();
  });

  it('rejects secrets and preserves the reserved document in ordinary settings upserts', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => ({
      rows: sql.includes('returning settings') ? [{ integration_settings: integrationSettings }] : [],
    }));
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
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/integration-settings',
      payload: { settings: withSecret, expectedRevision: 4 },
    });
    expect(rejected.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'PUT',
      url: '/api/integration-settings',
      payload: { settings: integrationSettings, expectedRevision: 4 },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().settings.revision).toBe(5);
    expect(query.mock.calls.at(-1)?.[0]).toContain("jsonb_set(reader_settings.settings, '{_moyaIntegrations}'");

    await app.inject({ method: 'PUT', url: '/api/settings', payload: defaultSettings });
    const readerSettingsUpsert = query.mock.calls.find(([sql]) =>
      String(sql).includes("jsonb_build_object('_moyaIntegrations'"),
    );
    expect(readerSettingsUpsert).toBeDefined();
    await app.close();
  });

  it('rejects a stale write and returns the current server document', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ integration_settings: integrationSettings }] });
    const app = await appWithBooks({ query } as unknown as pg.Pool);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/integration-settings',
      payload: { settings: integrationSettings, expectedRevision: 3 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'integration settings changed', settings: integrationSettings });
    expect(query.mock.calls[0]?.[0]).toContain("->> 'revision', '0'");
    await app.close();
  });
});
