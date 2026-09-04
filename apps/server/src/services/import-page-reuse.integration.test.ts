import { afterAll, describe, expect, test } from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import { integrityHash } from '@noveldesk/text-core/hash';
import { registerBookCatalogRoutes } from '../routes/books/catalog-routes.js';
import { registerBookContentRoutes } from '../routes/books/content-routes.js';
import { registerReaderStateRoutes } from '../routes/books/reader-state-routes.js';
import { drainObjectDeleteOutbox } from './object-delete-outbox.js';
import { exportHostedBackup, restoreHostedBackup } from './hosted-backup-service.js';
import { registerEpubResourceRoutes } from '../routes/books/epub-resource-routes.js';
import { readComicSourceManifest, packageComicSource } from '@noveldesk/fixed-document-core/comic-source';
import { startPostgresIntegrationHarness, withPostgresSchema } from './id-v2-migration/postgres-integration-harness.js';
import {
  fixturePng,
  fixtureSeries,
  withImportPageFixture,
  type ImportPageFixture,
} from './testing/import-page-fixture.js';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => harness?.stop());
const benchmark = process.env.MOYA_IMPORT_BENCHMARK;

async function pages(pool: pg.Pool) {
  return (
    await pool.query<{ id: string; storage_key: string; content_hash: string }>(
      "select id, storage_key, content_hash from book_assets where book_id = 'book_fixture' and kind = 'document_page' and status = 'active' order by page_index",
    )
  ).rows;
}

async function assertActiveObjects(pool: pg.Pool, fixture: ImportPageFixture) {
  const assets = (await pool.query('select storage_key, content_hash from book_assets')).rows;
  for (const asset of assets) {
    const object = fixture.objects.get(asset.storage_key);
    expect(object, asset.storage_key).toBeDefined();
    expect(integrityHash(object!.bytes)).toBe(asset.content_hash);
  }
  const sources = (await pool.query('select storage_key from book_objects')).rows;
  for (const source of sources) expect(fixture.objects.has(source.storage_key)).toBe(true);
}

describe.skipIf(!harness || Boolean(benchmark))('append page reuse with real PostgreSQL and S3 transport', () => {
  test('rebuilds paragraph search rows during a hosted replace restore', async () => {
    await withPostgresSchema(harness!, 'hosted_search_restore', async (pool) => {
      await withImportPageFixture(pool, async (fixture) => {
        await fixture.import(
          await fixtureSeries([
            { number: 1, pages: [fixturePng(1), fixturePng(2)] },
            { number: 2, pages: [fixturePng(3)] },
          ]),
        );
        const before = (
          await pool.query<{ count: number }>(
            `select count(*)::int as count
             from paragraph_search
             where book_id = 'book_fixture'`,
          )
        ).rows[0]!.count;
        const paragraphId = (
          await pool.query<{ paragraph_id: string }>(
            `select paragraph_id from paragraph_search
             where book_id = 'book_fixture'
             order by page_index, paragraph_index
             limit 1`,
          )
        ).rows[0]!.paragraph_id;
        expect(before).toBeGreaterThan(0);

        const backup = await exportHostedBackup(pool, fixture.config);
        const backupBytes = new Uint8Array(
          await new Response(backup.readable as ReadableStream<Uint8Array<ArrayBuffer>>).arrayBuffer(),
        );
        await backup.completion;
        await restoreHostedBackup(pool, fixture.config, backupBytes, { defaultConflictResolution: 'replace' });

        const after = (
          await pool.query<{ count: number }>(
            `select count(*)::int as count
             from paragraph_search
             where book_id = 'book_fixture'`,
          )
        ).rows[0]!.count;
        expect(after).toBe(before);

        const app = Fastify();
        await registerBookContentRoutes(app, pool, fixture.config);
        try {
          const response = await app.inject(`/api/paragraphs/${encodeURIComponent(paragraphId)}`);
          expect(response.statusCode, response.body).toBe(200);
        } finally {
          await app.close();
        }
      });
    });
  }, 30_000);

  test('rolls back a hosted replace restore when paragraph search rebuilding fails', async () => {
    await withPostgresSchema(harness!, 'hosted_search_restore_failure', async (pool) => {
      await withImportPageFixture(pool, async (fixture) => {
        await fixture.import(await fixtureSeries([{ number: 1, pages: [fixturePng(1), fixturePng(2)] }]));
        const beforeBook = (
          await pool.query(
            `select id, active_content_revision_id, object_id, title, total_chapters, total_paragraphs
             from library_books where id = 'book_fixture'`,
          )
        ).rows;
        const beforeSearch = (
          await pool.query(
            `select id, paragraph_id, chapter_id, page_index, paragraph_index, text, text_lower, paragraph
             from paragraph_search where book_id = 'book_fixture'
             order by page_index, paragraph_index`,
          )
        ).rows;
        const backup = await exportHostedBackup(pool, fixture.config);
        const backupBytes = new Uint8Array(
          await new Response(backup.readable as ReadableStream<Uint8Array<ArrayBuffer>>).arrayBuffer(),
        );
        await backup.completion;
        await pool.query(`
          create function fail_restored_paragraph_search() returns trigger language plpgsql as $$
          begin raise exception 'fixture paragraph search failure'; end; $$;
          create trigger fail_restored_paragraph_search before insert on paragraph_search
          for each statement execute function fail_restored_paragraph_search()
        `);

        await expect(
          restoreHostedBackup(pool, fixture.config, backupBytes, { defaultConflictResolution: 'replace' }),
        ).rejects.toThrow('fixture paragraph search failure');
        await pool.query('drop trigger fail_restored_paragraph_search on paragraph_search');

        expect(
          (
            await pool.query(
              `select id, active_content_revision_id, object_id, title, total_chapters, total_paragraphs
               from library_books where id = 'book_fixture'`,
            )
          ).rows,
        ).toEqual(beforeBook);
        expect(
          (
            await pool.query(
              `select id, paragraph_id, chapter_id, page_index, paragraph_index, text, text_lower, paragraph
               from paragraph_search where book_id = 'book_fixture'
               order by page_index, paragraph_index`,
            )
          ).rows,
        ).toEqual(beforeSearch);
      });
    });
  }, 30_000);

  test('crosses 100 chapters and 6,000 pages, then reads only the manifest and writes one new page', async () => {
    await withPostgresSchema(harness!, 'comic_large_work', async (pool) => {
      await withImportPageFixture(pool, async (fixture) => {
        const chapters = Array.from({ length: 100 }, (_, index) => ({
          number: index + 1,
          pages: Array.from({ length: 60 }, (_, page) => fixturePng(index * 60 + page + 1, 1)),
        }));
        // Each individual archive stays below the unchanged 5,000-page decoding limit.
        await fixture.import(await fixtureSeries(chapters.slice(0, 83)));
        const firstPage = (await pages(pool))[0]!;
        await fixture.import(await fixtureSeries(chapters.slice(83), 'book_fixture'), true);
        expect(await pages(pool)).toHaveLength(6000);
        expect(fixture.profiles.at(-1)).toMatchObject({ reusedPages: 4980, writtenPages: 1020 });
        fixture.gets.length = 0;
        fixture.puts.length = 0;
        await fixture.import(
          await fixtureSeries([{ number: 101, pages: [fixturePng(6001, 1)] }], 'book_fixture'),
          true,
        );
        expect(fixture.gets).toHaveLength(1);
        expect(fixture.gets[0]!.bytes).toBeLessThan(8 * 1024 * 1024);
        expect(fixture.profiles.at(-1)).toMatchObject({ reusedPages: 6000, writtenPages: 1 });
        const finalPages = await pages(pool);
        expect(finalPages).toHaveLength(6001);
        expect(finalPages[0]).toEqual(firstPage);
        const sourceKey = (
          await pool.query(
            'select storage_key from book_objects where id = (select object_id from library_books where id = $1)',
            ['book_fixture'],
          )
        ).rows[0].storage_key;
        const manifest = await readComicSourceManifest(
          new Blob([new Uint8Array(fixture.objects.get(sourceKey)!.bytes)]),
        );
        expect(manifest?.chapters).toHaveLength(101);
        const app = Fastify();
        await registerEpubResourceRoutes(app, pool, fixture.config);
        try {
          for (const page of [finalPages[0]!, finalPages.at(-1)!]) {
            const response = await app.inject(`/api/books/book_fixture/resources/${encodeURIComponent(page.id)}`);
            expect(response.statusCode, response.body).toBe(200);
            expect(integrityHash(response.rawPayload)).toBe(page.content_hash);
          }
        } finally {
          await app.close();
        }
      });
    });
  }, 180_000);
  test('keeps part originals through subsequent append, source download, backup copy and portable reimport', async () => {
    await withPostgresSchema(harness!, 'comic_parts', async (pool) => {
      await withImportPageFixture(pool, async (fixture) => {
        await fixture.import(await fixtureSeries([{ number: 2, pages: [fixturePng(2)] }]));
        const originalKey = (await pool.query('select storage_key from book_objects')).rows[0].storage_key;
        // Historical ZIP imports may have a generic MIME; the owned part must remain readable after conversion.
        await pool.query("update book_objects set content_type = 'application/zip'");
        await pool.query("update library_books set source_file_name = 'legacy.zip'");
        fixture.objects.get(originalKey)!.type = 'application/zip';
        await fixture.import(await fixtureSeries([{ number: 1, pages: [fixturePng(1)] }], 'book_fixture'), true);
        await drainObjectDeleteOutbox(pool, fixture.config, 1000);
        expect(fixture.objects.has(originalKey)).toBe(false);
        fixture.gets.length = 0;
        fixture.puts.length = 0;
        await fixture.import(await fixtureSeries([{ number: 3, pages: [fixturePng(3)] }], 'book_fixture'), true);
        expect(fixture.gets).toHaveLength(1);
        expect(fixture.gets[0]!.bytes).toBeLessThan(20_000);
        expect(fixture.profiles.at(-1)).toMatchObject({ reusedPages: 2, writtenPages: 1 });
        await drainObjectDeleteOutbox(pool, fixture.config, 1000);
        await assertActiveObjects(pool, fixture);
        const app = Fastify();
        await registerBookCatalogRoutes(app, pool, fixture.config);
        await registerEpubResourceRoutes(app, pool, fixture.config);
        try {
          const response = await app.inject('/api/books/book_fixture/source');
          expect(response.statusCode, response.body).toBe(200);
          const source = new Blob([new Uint8Array(response.rawPayload)]);
          const manifest = await readComicSourceManifest(source);
          expect(manifest?.sourceParts).toHaveLength(3);
          const packageBlob = await packageComicSource(source, async (part) => {
            const resource = await app.inject(
              `/api/books/book_fixture/resources/${encodeURIComponent(part.contentHash)}`,
            );
            expect(resource.statusCode, resource.body).toBe(200);
            expect(resource.headers['x-asset-kind']).toBe('source_part');
            return new Blob([new Uint8Array(resource.rawPayload)]);
          });
          const backup = await exportHostedBackup(pool, fixture.config);
          const backupBytes = new Uint8Array(
            await new Response(backup.readable as ReadableStream<Uint8Array<ArrayBuffer>>).arrayBuffer(),
          );
          await backup.completion;
          await restoreHostedBackup(pool, fixture.config, backupBytes, { defaultConflictResolution: 'copy' });
          const copied = (await pool.query("select id from library_books where id <> 'book_fixture'")).rows[0].id;
          await fixture.import(await fixtureSeries([{ number: 4, pages: [fixturePng(4)] }], copied), true, copied);
          expect(
            (await pool.query('select total_chapters from library_books where id = $1', [copied])).rows[0]
              .total_chapters,
          ).toBe(4);
          expect(
            (await pool.query("select total_chapters from library_books where id = 'book_fixture'")).rows[0]
              .total_chapters,
          ).toBe(3);
          await fixture.import(Buffer.from(await packageBlob.arrayBuffer()), false, 'portable_copy');
          expect(
            (
              await pool.query(
                "select count(*)::int as count from book_assets where book_id = 'portable_copy' and kind = 'source_part'",
              )
            ).rows[0].count,
          ).toBe(3);
          await drainObjectDeleteOutbox(pool, fixture.config, 1000);
          await assertActiveObjects(pool, fixture);
        } finally {
          await app.close();
        }
      });
    });
  }, 30_000);
  test('keeps an owned legacy part when another import replaces and collects the shared source during append', async () => {
    await withPostgresSchema(harness!, 'comic_part_source_race', async (pool) => {
      await withImportPageFixture(pool, async (fixture) => {
        const base = await fixtureSeries([{ number: 1, pages: [fixturePng(1)] }]);
        await fixture.import(base);
        const sourceSql =
          "select o.storage_key, b.active_content_revision_id from book_objects o join library_books b on b.object_id = o.id where b.id = 'book_fixture'";
        const original = (await pool.query(sourceSql)).rows[0];
        let interleaved = false;
        fixture.onPut = async (key) => {
          if (!key.includes('/sources/')) return;
          fixture.onPut = undefined;
          interleaved = true;
          await fixture.import(base, false, 'duplicate_book');
          const shared = (await pool.query(sourceSql)).rows[0];
          expect(shared.active_content_revision_id).toBe(original.active_content_revision_id);
          expect(shared.storage_key).not.toBe(original.storage_key);
          expect((await drainObjectDeleteOutbox(pool, fixture.config, 1000)).failed).toBe(0);
          expect(fixture.objects.has(original.storage_key)).toBe(false);
        };
        const append = await fixture.import(
          await fixtureSeries([{ number: 2, pages: [fixturePng(2)] }], 'book_fixture'),
          true,
        );
        expect(interleaved).toBe(true);
        expect((await pool.query('select status from import_jobs where id = $1', [append.jobId])).rows[0].status).toBe(
          'done',
        );
        const part = (
          await pool.query(
            "select storage_key from book_assets where book_id = 'book_fixture' and kind = 'source_part' and content_hash = $1 and status = 'active'",
            [integrityHash(base)],
          )
        ).rows[0];
        expect(part.storage_key).not.toBe(original.storage_key);
        await drainObjectDeleteOutbox(pool, fixture.config, 1000);
        await assertActiveObjects(pool, fixture);
        await fixture.import(await fixtureSeries([{ number: 3, pages: [fixturePng(3)] }], 'book_fixture'), true);
        await drainObjectDeleteOutbox(pool, fixture.config, 1000);
        await assertActiveObjects(pool, fixture);
        expect(
          (await pool.query("select total_chapters from library_books where id = 'book_fixture'")).rows[0]
            .total_chapters,
        ).toBe(3);
      });
    });
  }, 30_000);
  test('preserves covers, exact reads, chapter anchors and page bytes through append, GC, restore and purge', async () => {
    await withPostgresSchema(harness!, 'page_lifecycle', async (pool) => {
      await withImportPageFixture(pool, async (fixture) => {
        fixture.useExecutionLease = true;
        const original = await fixtureSeries(
          Array.from({ length: 6 }, (_, i) => ({
            number: i + 1,
            pages: [fixturePng(i * 2 + 1), fixturePng(i * 2 + 2)],
          })),
        );
        await fixture.import(original);
        await pool.query("update library_books set title = 'Edited title', author = 'Edited author', favorite = true");
        await pool.query("update book_assets set provenance = 'approved_enrichment' where kind = 'cover'");
        const bookSql =
          'select title, author, favorite, metadata_revision, cover_asset_id, cover_seed from library_books';
        const beforeBook = (await pool.query(bookSql)).rows;
        const beforePages = await pages(pool);
        const beforeChapters = (await pool.query('select id from chapters order by chapter_index')).rows;
        const app = Fastify();
        await registerBookCatalogRoutes(app, pool, fixture.config);
        await registerBookContentRoutes(app, pool, fixture.config);
        await registerReaderStateRoutes(app, pool, fixture.config);
        try {
          for (const section of [2, 6]) {
            const response = await app.inject({
              method: 'PATCH',
              url: '/api/books/book_fixture/reading-position',
              payload: {
                chapterId: beforeChapters[section * 2 - 2]!.id,
                documentSectionId: `chapter:${section}`,
                chapterProgress: 0.4,
                scrollTop: 10,
                deviceId: 'phone',
                updatedAt: `2026-08-31T00:0${section}:00Z`,
              },
            });
            expect(response.statusCode, response.body).toBe(200);
          }
          const beforePosition = (await pool.query('select * from reading_positions')).rows;
          const delta = await fixtureSeries([{ number: 7, pages: [fixturePng(13), fixturePng(14)] }], 'book_fixture');
          const result = await fixture.import(delta, true);
          expect(fixture.profiles.at(-1)).toMatchObject({
            jobId: result.jobId,
            outcome: 'committed',
            reusedPages: 12,
            writtenPages: 2,
          });
          expect((await pages(pool)).slice(0, 12).map((p) => p.storage_key)).toEqual(
            beforePages.map((p) => p.storage_key),
          );
          expect((await pool.query('select id from chapters order by chapter_index')).rows.slice(0, 12)).toEqual(
            beforeChapters,
          );
          expect((await pool.query(bookSql)).rows).toEqual(beforeBook);
          expect((await pool.query('select * from reading_positions')).rows).toEqual(beforePosition);
          const chapterResponse = await app.inject('/api/books/book_fixture/chapters');
          expect(chapterResponse.statusCode).toBe(200);
          const chapters = chapterResponse.json().chapters as Array<{ document_section_read_at: string | null }>;
          expect(chapters.filter((_, i) => i % 2 === 0).map((c) => Boolean(c.document_section_read_at))).toEqual([
            false,
            true,
            false,
            false,
            false,
            true,
            false,
          ]);
          expect(
            (
              await pool.query('select storage_key from object_delete_outbox where storage_key = any($1::text[])', [
                beforePages.map((p) => p.storage_key),
              ])
            ).rows,
          ).toEqual([]);
          expect((await drainObjectDeleteOutbox(pool, fixture.config, 1000)).failed).toBe(0);
          await assertActiveObjects(pool, fixture);
          const manifest = await app.inject('/api/books/book_fixture/manifest');
          expect(manifest.statusCode, manifest.body).toBe(200);
          expect((await app.inject({ method: 'DELETE', url: '/api/books/book_fixture' })).statusCode).toBe(200);
          await drainObjectDeleteOutbox(pool, fixture.config, 1000);
          await assertActiveObjects(pool, fixture);
          expect((await app.inject({ method: 'POST', url: '/api/trash/books/book_fixture/restore' })).statusCode).toBe(
            200,
          );
          await assertActiveObjects(pool, fixture);
          expect((await app.inject({ method: 'DELETE', url: '/api/books/book_fixture' })).statusCode).toBe(200);
          expect((await app.inject({ method: 'DELETE', url: '/api/trash/books/book_fixture' })).statusCode).toBe(200);
          expect((await drainObjectDeleteOutbox(pool, fixture.config, 1000)).failed).toBe(0);
          expect(fixture.objects.size).toBe(0);
          expect((await pool.query('select id from library_books')).rows).toEqual([]);
          await fixture.import(original);
          expect(fixture.profiles.at(-1)).toMatchObject({ reusedPages: 0, writtenPages: 12, outcome: 'committed' });
          await assertActiveObjects(pool, fixture);
        } finally {
          await app.close();
        }
      });
    });
  }, 30_000);

  test('repairs a missing object, writes changed pages only, and leaves duplicate delta as a no-op', async () => {
    await withPostgresSchema(harness!, 'page_repair', async (pool) => {
      await withImportPageFixture(pool, async (fixture) => {
        const firstPages = [fixturePng(1), fixturePng(2)];
        await fixture.import(await fixtureSeries([{ number: 1, pages: firstPages }]));
        const originalPages = await pages(pool);
        fixture.objects.delete(originalPages[0]!.storage_key);
        const delta = await fixtureSeries([{ number: 2, pages: [fixturePng(3)] }], 'book_fixture');
        await fixture.import(delta, true);
        expect(fixture.profiles.at(-1)).toMatchObject({ reusedPages: 1, writtenPages: 2, outcome: 'committed' });
        expect((await pages(pool))[1]!.storage_key).toBe(originalPages[1]!.storage_key);
        await drainObjectDeleteOutbox(pool, fixture.config, 1000);
        await assertActiveObjects(pool, fixture);
        const replacement = await fixtureSeries(
          [
            {
              number: 1,
              pages: [fixturePng(4), firstPages[1]!],
              previousHash: integrityHash(Buffer.concat(firstPages)),
            },
          ],
          'book_fixture',
        );
        await fixture.import(replacement, true);
        expect(fixture.profiles.at(-1)).toMatchObject({ reusedPages: 2, writtenPages: 1 });
        await drainObjectDeleteOutbox(pool, fixture.config, 1000);
        await assertActiveObjects(pool, fixture);
        const before = (await pool.query('select active_content_revision_id from library_books')).rows;
        const putCount = fixture.puts.length;
        await fixture.import(delta, true);
        expect(fixture.profiles.at(-1)).toMatchObject({ outcome: 'noop', writtenPages: 0 });
        expect(fixture.puts.length).toBe(putCount);
        expect((await pool.query('select active_content_revision_id from library_books')).rows).toEqual(before);
      });
    });
  }, 30_000);

  test.each(['database failure', 'cancellation'])(
    '%s cannot clean up reused pages; a subsequent append succeeds',
    async (failure) => {
      await withPostgresSchema(harness!, 'page_failure', async (pool) => {
        await withImportPageFixture(pool, async (fixture) => {
          fixture.useExecutionLease = true;
          await fixture.import(
            await fixtureSeries([{ number: 1, pages: Array.from({ length: 5 }, (_, i) => fixturePng(i + 1)) }]),
          );
          const originalPages = await pages(pool);
          const before = (await pool.query('select * from library_books')).rows;
          const delta = await fixtureSeries([{ number: 2, pages: [fixturePng(6)] }], 'book_fixture');
          if (failure === 'database failure') {
            await pool.query(`create function fail_page_insert() returns trigger language plpgsql as $$
            begin raise exception 'fixture activation failure'; end; $$;
            create trigger fail_page_insert before insert on book_assets for each row execute function fail_page_insert()`);
            await expect(fixture.import(delta, true)).rejects.toThrow('fixture activation failure');
            await pool.query('drop trigger fail_page_insert on book_assets');
          } else {
            fixture.onPut = async (key) => {
              if (!key.includes('/document_page_')) return;
              await pool.query(
                "update import_jobs set status = 'cancelled', cancel_requested_at = now() where status = 'processing'",
              );
            };
            await fixture.import(delta, true);
            fixture.onPut = undefined;
          }
          expect(fixture.profiles.at(-1)).toMatchObject({ outcome: 'not_committed', reusedPages: 5, writtenPages: 1 });
          expect((await pool.query('select * from library_books')).rows).toEqual(before);
          expect(await pages(pool)).toEqual(originalPages);
          expect(
            (
              await pool.query('select storage_key from object_delete_outbox where storage_key = any($1::text[])', [
                originalPages.map((p) => p.storage_key),
              ])
            ).rows,
          ).toEqual([]);
          expect((await drainObjectDeleteOutbox(pool, fixture.config, 1000)).failed).toBe(0);
          await assertActiveObjects(pool, fixture);
          await fixture.import(delta, true);
          expect(fixture.profiles.at(-1)).toMatchObject({ outcome: 'committed', reusedPages: 5, writtenPages: 1 });
          await assertActiveObjects(pool, fixture);
        });
      });
    },
    30_000,
  );
});

describe.skipIf(!harness || !benchmark)('worker page write benchmark (real PostgreSQL, loopback S3 fixture)', () => {
  test.each([83, 223, 500])(
    'append 65 pages to %i existing pages',
    async (pageCount) => {
      await withPostgresSchema(harness!, 'page_bench', async (pool) => {
        await withImportPageFixture(pool, async (fixture) => {
          const base = await fixtureSeries([
            { number: 1, pages: Array.from({ length: pageCount }, (_, i) => fixturePng(i + 1, 256)) },
          ]);
          const delta = await fixtureSeries(
            [{ number: 2, pages: Array.from({ length: 65 }, (_, i) => fixturePng(i + 10001, 256)) }],
            'book_fixture',
          );
          await fixture.import(base);
          fixture.puts.length = 0;
          fixture.gets.length = 0;
          fixture.heads.length = 0;
          const result = await fixture.import(delta, true);
          const pageKeys = new Set(
            (
              await pool.query("select storage_key from book_assets where kind = 'document_page' and status = 'active'")
            ).rows.map((row) => row.storage_key),
          );
          const pagePuts = fixture.puts.filter((put) => pageKeys.has(put.key));
          expect(pagePuts.length).toBe(benchmark === 'baseline' ? pageCount + 65 : 65);
          process.stdout.write(
            JSON.stringify({
              benchmark,
              existingPages: pageCount,
              addedPages: 65,
              baseBytes: base.length,
              deltaBytes: delta.length,
              durationMs: Math.round(result.durationMs),
              pagePuts: pagePuts.length,
              pagePutBytes: pagePuts.reduce((sum, put) => sum + put.bytes, 0),
              objectPutBytes: fixture.puts.reduce((sum, put) => sum + put.bytes, 0),
              objectGetBytes: fixture.gets.reduce((sum, get) => sum + get.bytes, 0),
              headRequests: fixture.heads.length,
              profile: fixture.profiles.at(-1),
            }) + '\n',
          );
          if (benchmark === 'parts') {
            const next = await fixtureSeries(
              [{ number: 3, pages: Array.from({ length: 65 }, (_, i) => fixturePng(i + 20001, 256)) }],
              'book_fixture',
            );
            fixture.puts.length = 0;
            fixture.gets.length = 0;
            fixture.heads.length = 0;
            const warm = await fixture.import(next, true);
            expect(fixture.gets).toHaveLength(1);
            expect(fixture.gets[0]!.bytes).toBeLessThan(1024 * 1024);
            expect(fixture.profiles.at(-1)).toMatchObject({ writtenPages: 65 });
            process.stdout.write(
              JSON.stringify({
                benchmark: 'parts-steady',
                existingPages: pageCount + 65,
                addedPages: 65,
                durationMs: Math.round(warm.durationMs),
                objectPutBytes: fixture.puts.reduce((sum, put) => sum + put.bytes, 0),
                objectGetBytes: fixture.gets.reduce((sum, get) => sum + get.bytes, 0),
                headRequests: fixture.heads.length,
                profile: fixture.profiles.at(-1),
              }) + '\n',
            );
          }
        });
      });
    },
    120_000,
  );
});
