import Fastify from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';
import type { ServerConfig } from '../../config.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../../services/id-v2-migration/postgres-integration-harness.js';
import { registerReaderStateRoutes } from './reader-state-routes.js';

const harness = await startPostgresIntegrationHarness();
const describeWithPostgres = harness ? describe : describe.skip;

describeWithPostgres('self-host integration revision CAS with real PostgreSQL', () => {
  afterAll(async () => harness?.stop());

  test('creates revision 1, updates to revision 2 and rejects a stale revision 1 write', async () => {
    await withPostgresSchema(harness!, 'integration_settings_cas', async (pool) => {
      await pool.query('create table users (id text primary key)');
      await pool.query(`create table reader_settings (
        user_id text primary key references users(id) on delete cascade,
        settings jsonb not null,
        updated_at timestamptz not null default now()
      )`);
      await pool.query("insert into users (id) values ('user_test')");

      const app = Fastify();
      await registerReaderStateRoutes(app, pool, { defaultUserId: 'user_test' } as ServerConfig);
      const initial = {
        schemaVersion: 1,
        revision: 0,
        updatedAt: '2026-09-04T00:00:00.000Z',
        legacyImportCompleted: false,
        extensionEnablement: { schemaVersion: 1, enabledByExtensionId: {} },
        webNovelMetadata: {
          schemaVersion: 1,
          includeAdult: false,
          automaticLookup: false,
          automaticApply: 'off',
        },
        externalSources: { schemaVersion: 1, connections: [], links: [], subscriptions: [] },
      } as const;

      try {
        const created = await app.inject({
          method: 'PUT',
          url: '/api/integration-settings',
          payload: { settings: initial, expectedRevision: 0 },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json().settings.revision).toBe(1);

        const revisionOne = created.json().settings;
        const updated = await app.inject({
          method: 'PUT',
          url: '/api/integration-settings',
          payload: {
            settings: {
              ...revisionOne,
              webNovelMetadata: { ...revisionOne.webNovelMetadata, automaticLookup: true },
            },
            expectedRevision: 1,
          },
        });
        expect(updated.statusCode).toBe(200);
        expect(updated.json().settings.revision).toBe(2);

        const stale = await app.inject({
          method: 'PUT',
          url: '/api/integration-settings',
          payload: { settings: revisionOne, expectedRevision: 1 },
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json().settings.revision).toBe(2);
      } finally {
        await app.close();
      }
    });
  });
});
