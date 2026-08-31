import 'fake-indexeddb/auto';
import Fastify from 'fastify';
import { afterAll, describe, expect, test, vi } from 'vitest';
import type { ServerConfig } from '../config.js';
import { migrateDatabase } from './migrate.js';
import { registerBookCatalogRoutes } from '../routes/books/catalog-routes.js';
import { registerBookContentRoutes } from '../routes/books/content-routes.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../services/id-v2-migration/postgres-integration-harness.js';
import { RemoteApiClient } from '../../../../src/services/remote/remote-api-client';
import { RemoteReaderRepository } from '../../../../src/repositories/remote-reader-repository';
import {
  ExternalSourceLocalStateStore,
  externalSourceSubscriptionId,
  resetExternalSourceLocalStateForTests,
} from '../../../../src/external-sources/local-state';
import { reconcilePendingExternalSourceLinks } from '../../../../src/external-sources/link-import-reconciliation';
import type { ExternalSourceLink } from '../../../../src/external-sources/contracts';

const harness = await startPostgresIntegrationHarness();
const describeWithPostgres = harness ? describe : describe.skip;

describeWithPostgres('hosted source book trash and re-add lifecycle', () => {
  afterAll(async () => harness?.stop());
  test.each(['single', 'empty-trash'])(
    '%s preserves restore and removes only purged book links',
    async (purgeMode) => {
      await resetExternalSourceLocalStateForTests();
      await withPostgresSchema(harness!, 'source_lifecycle', async (pool) => {
        await migrateDatabase(pool);
        await pool.query(
          "insert into users (id, email, display_name) values ('user_test', 'test@example.com', 'Test'), ('other', 'other@example.com', 'Other')",
        );
        const seedBook = async () => {
          await pool.query(
            "insert into book_objects (id, raw_text_hash, storage_key, file_name, content_type, size_bytes) values ('object', 'same-bytes', 'fixture-source', 'fixture.cbz', 'application/zip', 100)",
          );
          await pool.query(`insert into library_books (id, user_id, object_id, title, source_file_name, source_encoding, format, normalized_text_hash, total_chapters, total_characters, total_paragraphs)
          values ('book', 'user_test', 'object', 'Fixture', 'fixture.cbz', 'utf-8', 'image_archive', 'same-text', 1, 0, 0)`);
          await pool.query(`insert into chapters (id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset, character_count, paragraph_count, document_section_id)
          values ('page', 'book', 1, '1화', 'same-page', 0, 0, 0, 0, 'chapter-1')`);
        };
        await seedBook();
        await pool.query(`insert into library_books (id, user_id, title, source_file_name, source_encoding, normalized_text_hash, total_chapters, total_characters, total_paragraphs)
        values ('other-book', 'other', 'Private', 'other.txt', 'utf-8', 'other-text', 0, 0, 0)`);
        const app = Fastify();
        const config = { defaultUserId: 'user_test' } as ServerConfig;
        await registerBookCatalogRoutes(app, pool, config);
        await registerBookContentRoutes(app, pool, config);
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, init?: RequestInit) => {
            const headers: Record<string, string> = {};
            new Headers(init?.headers).forEach((value, key) => {
              headers[key] = value;
            });
            const response = await app.inject({
              method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
              url,
              payload: init?.body as string | undefined,
              headers,
            });
            return new Response(response.body, {
              status: response.statusCode,
              headers: { 'content-type': 'application/json' },
            });
          }),
        );
        const client = new RemoteApiClient('/api');
        const repository = new RemoteReaderRepository(client);
        const state = new ExternalSourceLocalStateStore();
        const link: ExternalSourceLink = {
          id: 'link',
          source: { connectorId: 'source', accountConnectionId: 'account', remoteId: 'chapter-1' },
          localBookId: 'book',
          collectionRemoteId: 'series',
          importedSourceContentHash: 'same-page',
          linkedAt: new Date().toISOString(),
        };
        const subscription = {
          id: externalSourceSubscriptionId('source', 'account', 'series'),
          connectorId: 'source',
          accountConnectionId: 'account',
          collectionRemoteId: 'series',
          navigationRef: 'series',
          title: 'Fixture',
          knownReleaseIds: ['chapter-1'],
          newReleaseIds: [],
          availableReleaseCount: 1,
          lastCheckedAt: link.linkedAt,
          createdAt: link.linkedAt,
          updatedAt: link.linkedAt,
          schemaVersion: 1 as const,
        };
        const reconcile = async () => {
          const links = await state.listLinks();
          return reconcilePendingExternalSourceLinks(
            state,
            links,
            await repository.listNovels({ includeTrash: true }),
            Date.now(),
            { catalogIncludesTrash: true },
          );
        };
        try {
          await state.saveLink(link);
          await state.saveSubscription(subscription);
          expect((await repository.listNovels()).map((book) => book.id)).toEqual(['book']);
          await client.deleteBook('book');
          expect(await repository.listNovels()).toEqual([]);
          expect(
            (await repository.listNovels({ includeTrash: true })).map((book) => [book.id, Boolean(book.deletedAt)]),
          ).toEqual([['book', true]]);
          expect(await reconcile()).toEqual([link]);
          await client.restoreBook('book');
          expect((await repository.getNovel('book'))?.id).toBe('book');
          expect(await reconcile()).toEqual([link]);
          await client.deleteBook('book');
          // A failed revision check cannot erase either the server book or its local source link.
          await expect(client.purgeBook('book', 9999)).rejects.toMatchObject({ status: 409 });
          expect(await reconcile()).toEqual([link]);
          if (purgeMode === 'single') await client.purgeBook('book');
          else expect((await client.emptyTrash()).purged).toBe(1);
          expect(await client.listTrashBooks()).toEqual({ books: [] });
          expect(await reconcile()).toEqual([]);
          expect(await new ExternalSourceLocalStateStore().listSubscriptions()).toEqual([]);
          expect((await pool.query('select book_id from chapters')).rows).toEqual([]);
          expect((await pool.query("select id from library_books where user_id = 'other'")).rows).toHaveLength(1);
          // Re-create the identical source identities; this is DB/catalog validation, not a live Suwayomi download.
          await seedBook();
          await state.saveLink(link);
          await state.saveSubscription(subscription);
          expect(await reconcile()).toEqual([link]);
          expect((await repository.getNovel('book'))?.id).toBe('book');
        } finally {
          vi.unstubAllGlobals();
          await app.close();
        }
      });
    },
    60_000,
  );
});
