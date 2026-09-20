import Fastify from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';
import type { ServerConfig } from '../../config.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../../services/id-v2-migration/postgres-integration-harness.js';
import { registerReaderStateRoutes } from './reader-state-routes.js';

const harness = await startPostgresIntegrationHarness();
(harness ? describe : describe.skip)('discovery settings with isolated PostgreSQL', () => {
  afterAll(async () => harness?.stop());
  test('isolates users, arbitrates concurrent writes, and survives ordinary reader/integration settings saves', async () => {
    await withPostgresSchema(harness!, 'discovery_settings', async (pool) => {
      await pool.query('create table users (id text primary key)');
      await pool.query("insert into users values ('a'), ('b')");
      await pool.query(
        'create table reader_settings (user_id text primary key references users(id), settings jsonb not null, updated_at timestamptz not null default now())',
      );
      await pool.query(
        'create table sync_events (id text primary key, user_id text, device_id text, type text, book_id text, entity_id text, payload jsonb, revision jsonb, created_at timestamptz)',
      );
      const a = Fastify(),
        b = Fastify();
      await registerReaderStateRoutes(a, pool, { defaultUserId: 'a' } as ServerConfig);
      await registerReaderStateRoutes(b, pool, { defaultUserId: 'b' } as ServerConfig);
      const config = {
        version: 1,
        tabs: [
          {
            id: 'one',
            title: '공유',
            hidden: false,
            density: 'compact',
            pinnedSourceId: 'source',
            sections: [
              {
                id: 'section',
                title: '',
                sourceId: 'source',
                mode: 'latest',
                filters: [{ position: 0, value: '판타지' }],
              },
            ],
          },
        ],
      };
      const write = (expectedRevision: number) =>
        a.inject({ method: 'PUT', url: '/api/discovery-settings', payload: { config, expectedRevision } });
      try {
        expect((await a.inject('/api/discovery-settings')).json()).toEqual({});
        expect((await write(1)).statusCode).toBe(409); // No row must not accept an arbitrary revision.
        const first = await Promise.all([write(0), write(0)]);
        expect(first.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        const edits = await Promise.all([write(1), write(1)]);
        expect(edits.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        expect((await b.inject('/api/discovery-settings')).json()).toEqual({});
        expect((await a.inject('/api/discovery-settings')).json().settings).toMatchObject({ config, revision: 2 });
        expect((await a.inject('/api/settings')).json().settings).not.toHaveProperty('_moyaDiscovery');
        expect((await a.inject({ method: 'PUT', url: '/api/settings', payload: { ttsSpeed: 1.5 } })).statusCode).toBe(
          200,
        );
        const downloadPolicy = { autoNext: true, nextCount: 3, retentionEnabled: true, keepRead: 10 };
        expect((await a.inject({ method: 'PUT', url: '/api/settings', payload: { downloadPolicy } })).statusCode).toBe(
          200,
        );
        expect((await a.inject('/api/settings')).json().settings.downloadPolicy).toEqual(downloadPolicy);
        expect((await b.inject('/api/settings')).json().settings.downloadPolicy).toBeUndefined();
        expect(
          (
            await a.inject({
              method: 'PUT',
              url: '/api/settings',
              payload: { downloadPolicy: { ...downloadPolicy, keepRead: 0 } },
            })
          ).statusCode,
        ).toBe(400);
        // Older clients saving ordinary settings must not erase the shared download policy.
        await a.inject({ method: 'PUT', url: '/api/settings', payload: { ttsSpeed: 1.5 } });
        expect((await a.inject('/api/settings')).json().settings.downloadPolicy).toEqual(downloadPolicy);
        const integrations = {
          schemaVersion: 1,
          revision: 0,
          updatedAt: '2026-09-20T00:00:00.000Z',
          legacyImportCompleted: true,
          extensionEnablement: { schemaVersion: 1, enabledByExtensionId: {} },
          webNovelMetadata: { schemaVersion: 1, includeAdult: false, automaticLookup: false, automaticApply: 'off' },
          externalSources: { schemaVersion: 1, connections: [], links: [], subscriptions: [] },
        };
        expect(
          (
            await a.inject({
              method: 'PUT',
              url: '/api/integration-settings',
              payload: { settings: integrations, expectedRevision: 0 },
            })
          ).statusCode,
        ).toBe(200);
        expect((await a.inject('/api/discovery-settings')).json().settings).toMatchObject({ config, revision: 2 });
        expect((await write(2)).statusCode).toBe(200);
        const raw = (await pool.query("select settings from reader_settings where user_id = 'a'")).rows[0].settings;
        expect(raw).toMatchObject({
          ttsSpeed: 1.5,
          _moyaIntegrations: { revision: 1 },
          _moyaDiscovery: { revision: 3 },
        });
        const invalid = await a.inject({
          method: 'PUT',
          url: '/api/discovery-settings',
          payload: { config: { version: 1, tabs: [null] }, expectedRevision: 3 },
        });
        expect(invalid.statusCode).toBe(400);
      } finally {
        await a.close();
        await b.close();
      }
    });
  });
});
