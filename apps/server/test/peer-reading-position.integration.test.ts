import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import Fastify from 'fastify';
import pg from 'pg';
import { syncEventId, syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import { persistentId128 } from '@noveldesk/text-core/hash';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import { afterAll, describe, expect, it } from 'vitest';
import { registerAuthHook } from '../src/auth.js';
import { migrateDatabase } from '../src/db/migrate.js';
import type { ServerConfig } from '../src/config.js';
import { registerSelfHostAuthRoutes } from '../src/routes/auth.js';
import { registerBackupRoutes } from '../src/routes/backups.js';
import { registerReaderStateRoutes } from '../src/routes/books/reader-state-routes.js';
import { registerSyncRoutes } from '../src/routes/sync.js';
import { PostgresSelfHostAuthStore, SelfHostAuthService } from '../src/services/self-host-auth-service.js';
import { FileObjectStore } from '../src/services/file-object-store.js';
import { fixturePng, fixtureSeries, withImportPageFixture } from '../src/services/testing/import-page-fixture.js';
import { startPostgresIntegrationHarness } from '../src/services/id-v2-migration/postgres-integration-harness.js';
import {
  bookmarkCreatedEvent,
  canonicalV2Event,
  readingPositionEvent,
  v2PushEnvelope,
} from '../src/routes/sync/sync-route-test-harness.js';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => harness?.stop());

const USER_A = 'user_desktop';
const USER_B = 'user_dev';

async function epubBytes(body: string): Promise<Buffer> {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  const entries = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
    'book.opf':
      '<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Peer EPUB</dc:title><dc:language>en</dc:language></metadata><manifest><item id="text" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="image" href="images/page.png" media-type="image/png"/></manifest><spine><itemref idref="text"/></spine></package>',
    'chapter.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>First chapter</h1><p>Keep this paragraph.</p><p>${body}</p><img src="images/page.png"/></body></html>`,
  };
  for (const [name, value] of Object.entries(entries)) await writer.add(name, new TextReader(value), { level: 0 });
  await writer.add('images/page.png', new Uint8ArrayReader(fixturePng(45)), { level: 0 });
  return Buffer.from(await (await writer.close()).arrayBuffer());
}

function pdfBytes(body: string): Buffer {
  const text = `BT /F1 24 Tf 72 720 Td (${body}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function ownedEvent(event: SyncEvent, userId: string): SyncEvent {
  return {
    ...event,
    id: syncEventId({
      userId,
      deviceId: event.deviceId,
      type: event.type,
      novelId: event.novelId,
      entityId: event.entityId,
      seed: `peer-fixture:${event.id}`,
    }),
  };
}

async function fixtureBook(pool: pg.Pool, userId: string) {
  await migrateDatabase(pool);
  await pool.query("insert into users (id,email,display_name) values ($1,'reader@example.com','Reader')", [userId]);
  await pool.query(
    `insert into book_objects (id,raw_text_hash,storage_key,file_name,content_type,size_bytes)
     values ('source_1','sha256:fixture','fixture/source','book.txt','text/plain',12)`,
  );
  await pool.query(
    `insert into library_books (
       id,user_id,object_id,title,source_file_name,normalized_text_hash,total_chapters,total_characters,total_paragraphs
     ) values ('book_1',$1,'source_1','Same Book','book.txt','sha256:normalized',1,12,1)`,
    [userId],
  );
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query("update book_content_revisions set id = 'revision_1' where book_id = 'book_1'");
    await client.query("update library_books set active_content_revision_id = 'revision_1' where id = 'book_1'");
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  await pool.query(
    `insert into chapters (
       id,book_id,chapter_index,title,text_hash,raw_start_offset,raw_end_offset,character_count,paragraph_count
     ) values ('chapter_1','book_1',1,'Chapter','sha256:chapter',0,12,12,1)`,
  );
  await pool.query(
    `insert into paragraph_pages (
       id,book_id,chapter_id,page_index,start_paragraph_index,end_paragraph_index,paragraphs,text_hash
     ) values ('page_1','book_1','chapter_1',0,0,0,$1::jsonb,'sha256:page')`,
    [JSON.stringify([{ id: 'paragraph_1', index: 0, text: 'Text' }])],
  );
  await pool.query(
    `insert into paragraph_search (
       id,paragraph_id,book_id,chapter_id,page_index,paragraph_index,text,text_lower,paragraph
     ) values ('search_1','paragraph_1','book_1','chapter_1',0,0,'Text','text','{}'::jsonb)`,
  );
}

async function testServer(
  pool: pg.Pool,
  directory: string,
  token: string,
  userId: string,
  port = 0,
  override?: ServerConfig,
) {
  const config: ServerConfig = override
    ? { ...override, authToken: token }
    : {
        host: '127.0.0.1',
        port: 0,
        databaseUrl: '',
        redisUrl: '',
        dataDir: directory,
        objectStorageDir: path.join(directory, 'objects'),
        authToken: token,
        maxChunkBytes: 1024,
        maxUploadBytes: 1024,
        staleUploadMaxAgeMs: 1000,
        runMigrationsOnStart: false,
        defaultUserId: userId,
        s3: {
          endpoint: 'http://127.0.0.1:9000',
          region: 'us-east-1',
          bucket: 'test',
          accessKeyId: 'test',
          secretAccessKey: 'test',
          forcePathStyle: true,
        },
      };
  const app = Fastify({ logger: false });
  // Match production's inherited parser so streaming route registration is tested.
  app.addContentTypeParser('application/zip', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  const auth = new SelfHostAuthService(new PostgresSelfHostAuthStore(pool), userId);
  await registerAuthHook(app, config, auth);
  await registerSelfHostAuthRoutes(app, auth, config);
  await registerReaderStateRoutes(app, pool, config);
  await registerBackupRoutes(app, pool, config);
  await registerSyncRoutes(app, pool, config);
  const url = await app.listen({ host: '127.0.0.1', port });
  return { app, url, token, config };
}

async function withTwoDatabases(run: (poolA: pg.Pool, poolB: pg.Pool) => Promise<void>) {
  const names = ['a', 'b'].map((side) => `moya_peer_${side}_${randomUUID().replaceAll('-', '').slice(0, 12)}`);
  const admin = new pg.Pool({ connectionString: harness!.url });
  const pools: pg.Pool[] = [];
  try {
    for (const name of names) await admin.query(`create database "${name}"`);
    for (const name of names) {
      const url = new URL(harness!.url);
      url.pathname = `/${name}`;
      pools.push(new pg.Pool({ connectionString: url.toString(), max: 4 }));
    }
    await run(pools[0], pools[1]);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    for (const name of names) await admin.query(`drop database if exists "${name}"`);
    await admin.end();
  }
}

describe.skipIf(!harness)('two server reading position sync', () => {
  it('transfers and replaces EPUB content with resources while preserving the target note', async () => {
    await withTwoDatabases(async (poolA, poolB) => {
      await withImportPageFixture(poolA, async (fixtureA) => {
        await withImportPageFixture(poolB, async (fixtureB) => {
          const a = await testServer(poolA, fixtureA.config.dataDir, 'native_a', 'user_test', 0, fixtureA.config);
          const b = await testServer(poolB, fixtureB.config.dataDir, 'native_b', 'user_test', 0, fixtureB.config);
          const request = (server: typeof a, resource: string, body: unknown) =>
            fetch(`${server.url}/api${resource}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
          const options = { fileName: 'fixture.epub', contentType: 'application/epub+zip' };
          try {
            expect(
              (
                await request(b, '/auth/register', {
                  username: 'peer',
                  password: 'long peer test password',
                  setupCode: b.token,
                })
              ).status,
            ).toBe(201);
            expect(
              (
                await request(a, '/sync/peer', {
                  url: b.url,
                  username: 'peer',
                  password: 'long peer test password',
                  startFromNow: true,
                })
              ).status,
            ).toBe(200);
            await fixtureA.import(await epubBytes('Original ending.'), false, 'book_epub', options);
            const firstRun = (await (await request(a, '/sync/peer/run', {})).json()) as {
              status: string;
              lastError: string | null;
            };
            expect(firstRun.lastError).toBeNull();
            expect(firstRun.status).toBe('ready');
            const original = (
              await poolB.query("select active_content_revision_id from library_books where id='book_epub'")
            ).rows[0].active_content_revision_id as string;
            const anchor = (
              await poolB.query(
                "select chapter_id,paragraph_id from paragraph_search where book_id='book_epub' and text like '%Keep this paragraph%' limit 1",
              )
            ).rows[0] as { chapter_id: string; paragraph_id: string };
            expect(anchor).toBeDefined();
            await poolB.query(
              `insert into notes (id,book_id,user_id,chapter_id,paragraph_id,body)
               values ('epub_note','book_epub','user_test',$1,$2,'Keep EPUB note')`,
              [anchor.chapter_id, anchor.paragraph_id],
            );
            await poolB.query("update library_books set title='My EPUB title' where id='book_epub'");
            await fixtureA.import(await epubBytes('Updated ending.'), false, 'book_epub', {
              ...options,
              expectedBase: { kind: 'revision', contentRevisionId: original },
            });
            const secondRun = (await (await request(a, '/sync/peer/run', {})).json()) as {
              status: string;
              lastError: string | null;
            };
            expect(secondRun.lastError).toBeNull();
            expect(secondRun.status).toBe('ready');
            expect(
              (await poolB.query("select active_content_revision_id from library_books where id='book_epub'")).rows[0]
                .active_content_revision_id,
            ).toBe(
              (await poolA.query("select active_content_revision_id from library_books where id='book_epub'")).rows[0]
                .active_content_revision_id,
            );
            expect((await poolB.query("select title from library_books where id='book_epub'")).rows[0].title).toBe(
              'My EPUB title',
            );
            expect((await poolB.query("select body from notes where id='epub_note'")).rows[0]?.body).toBe(
              'Keep EPUB note',
            );
            const resources = (
              await poolB.query(
                "select storage_key,content_hash from book_assets where book_id='book_epub' and kind='epub_resource' and status='active'",
              )
            ).rows;
            expect(resources.length).toBeGreaterThan(0);
            for (const resource of resources) {
              const bytes = fixtureB.objects.get(resource.storage_key)?.bytes;
              expect(bytes).toBeDefined();
              expect(`sha256:${createHash('sha256').update(bytes!).digest('hex')}`).toBe(resource.content_hash);
            }
            const pdf = pdfBytes('Peer PDF proof');
            await fixtureA.import(pdf, false, 'book_pdf', {
              fileName: 'fixture.pdf',
              contentType: 'application/pdf',
            });
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
            const pdfBook = (
              await poolB.query(
                "select format,active_content_revision_id,object_id from library_books where id='book_pdf'",
              )
            ).rows[0];
            expect(pdfBook.format).toBe('pdf');
            expect(pdfBook.active_content_revision_id).toBe(
              (await poolA.query("select active_content_revision_id from library_books where id='book_pdf'")).rows[0]
                .active_content_revision_id,
            );
            const pdfKey = (await poolB.query('select storage_key from book_objects where id=$1', [pdfBook.object_id]))
              .rows[0].storage_key as string;
            expect(fixtureB.objects.get(pdfKey)?.bytes).toEqual(pdf);
            await fixtureA.import(pdfBytes('Updated PDF proof'), false, 'book_pdf', {
              fileName: 'fixture.pdf',
              contentType: 'application/pdf',
              expectedBase: { kind: 'revision', contentRevisionId: pdfBook.active_content_revision_id },
            });
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
            const updatedPdf = (
              await poolB.query("select active_content_revision_id from library_books where id='book_pdf'")
            ).rows[0].active_content_revision_id as string;
            expect(updatedPdf).toBe(
              (await poolA.query("select active_content_revision_id from library_books where id='book_pdf'")).rows[0]
                .active_content_revision_id,
            );
            await poolB.query(
              `insert into document_annotations (id,book_id,user_id,page_index,annotation_type,anchor,body)
               values ('pdf_note','book_pdf','user_test',0,'note','{"pageHash":"saved"}'::jsonb,'Keep PDF annotation')`,
            );
            await fixtureA.import(pdfBytes('Third PDF proof'), false, 'book_pdf', {
              fileName: 'fixture.pdf',
              contentType: 'application/pdf',
              expectedBase: { kind: 'revision', contentRevisionId: updatedPdf },
            });
            const pdfCursor = Number(
              (await poolA.query('select outbound_cursor from sync_server_peers')).rows[0].outbound_cursor,
            );
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({
              status: 'blocked',
              outboundCursor: pdfCursor,
              lastError: 'peer_book_document_annotations_require_remap',
            });
            expect(
              (await poolB.query("select active_content_revision_id from library_books where id='book_pdf'")).rows[0]
                .active_content_revision_id,
            ).toBe(updatedPdf);
            expect((await poolB.query("select body from document_annotations where id='pdf_note'")).rows[0].body).toBe(
              'Keep PDF annotation',
            );
            expect(
              (
                await poolA.query(
                  "select count(*)::int as n from sync_peer_conflicts where reason='peer_book_document_annotations_require_remap' and status='unresolved'",
                )
              ).rows[0].n,
            ).toBe(1);
          } finally {
            await a.app.close();
            await b.app.close();
          }
        });
      });
    });
  }, 90_000);

  it('transfers an imported image series and its page assets to an empty peer', async () => {
    await withTwoDatabases(async (poolA, poolB) => {
      await withImportPageFixture(poolA, async (fixtureA) => {
        await withImportPageFixture(poolB, async (fixtureB) => {
          const a = await testServer(poolA, fixtureA.config.dataDir, 'native_a', 'user_test', 0, fixtureA.config);
          const b = await testServer(poolB, fixtureB.config.dataDir, 'native_b', 'user_test', 0, fixtureB.config);
          const request = (server: typeof a, resource: string, body: unknown) =>
            fetch(`${server.url}/api${resource}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
          try {
            expect(
              (
                await request(b, '/auth/register', {
                  username: 'peer',
                  password: 'long peer test password',
                  setupCode: b.token,
                })
              ).status,
            ).toBe(201);
            expect(
              (
                await request(a, '/sync/peer', {
                  url: b.url,
                  username: 'peer',
                  password: 'long peer test password',
                  startFromNow: true,
                })
              ).status,
            ).toBe(200);
            const archive = await fixtureSeries([{ number: 1, pages: [fixturePng(1), fixturePng(2)] }], 'book_series');
            await fixtureA.import(archive, false, 'book_series');
            const run = (await (await request(a, '/sync/peer/run', {})).json()) as {
              status: string;
              lastError: string | null;
            };
            expect(run.lastError).toBeNull();
            expect(run.status).toBe('ready');
            const source = (
              await poolA.query("select active_content_revision_id, format from library_books where id='book_series'")
            ).rows[0];
            expect(
              (await poolB.query("select active_content_revision_id, format from library_books where id='book_series'"))
                .rows[0],
            ).toEqual(source);
            const assets = await poolB.query(
              "select storage_key, content_hash from book_assets where book_id='book_series' and status='active' and kind='document_page' order by id",
            );
            expect(assets.rows).toHaveLength(2);
            expect(assets.rows.every((row) => fixtureB.objects.has(row.storage_key))).toBe(true);
            const preservedCover = (
              await poolB.query(
                "select id, storage_key from book_assets where book_id='book_series' and kind='cover' and status='active'",
              )
            ).rows[0];
            const firstChapter = (
              await poolB.query("select id from chapters where book_id='book_series' order by chapter_index limit 1")
            ).rows[0].id as string;
            await poolB.query(
              `insert into reading_positions (book_id,user_id,chapter_id,paragraph_index,scroll_top)
               values ('book_series','user_test',$1,0,17)`,
              [firstChapter],
            );
            await poolB.query(
              `insert into notes (id,book_id,user_id,chapter_id,body)
               values ('series_note','book_series','user_test',$1,'Remember this page')`,
              [firstChapter],
            );
            const delta = await fixtureSeries([{ number: 2, pages: [fixturePng(3)] }], 'book_series');
            await fixtureA.import(delta, true, 'book_series');
            const appended = (await (await request(a, '/sync/peer/run', {})).json()) as {
              status: string;
              lastError: string | null;
            };
            expect(appended.lastError).toBeNull();
            expect(appended.status).toBe('ready');
            expect(
              (await poolB.query("select id from chapters where book_id='book_series' order by chapter_index")).rows,
            ).toEqual(
              (await poolA.query("select id from chapters where book_id='book_series' order by chapter_index")).rows,
            );
            expect(
              (
                await poolB.query(
                  "select id, storage_key from book_assets where book_id='book_series' and kind='cover' and status='active'",
                )
              ).rows[0],
            ).toEqual(preservedCover);
            expect(
              (await poolB.query("select chapter_id from reading_positions where book_id='book_series'")).rows[0]
                ?.chapter_id,
            ).toBe(firstChapter);
            expect((await poolB.query("select body from notes where id='series_note'")).rows[0]?.body).toBe(
              'Remember this page',
            );
            const activeAssets = await poolB.query(
              "select kind, storage_key, content_hash, byte_length from book_assets where book_id='book_series' and status='active' and kind in ('document_page','source_part')",
            );
            expect(activeAssets.rows.filter((row) => row.kind === 'document_page')).toHaveLength(3);
            expect(activeAssets.rows.filter((row) => row.kind === 'source_part')).toHaveLength(2);
            for (const asset of activeAssets.rows) {
              const bytes = fixtureB.objects.get(asset.storage_key)?.bytes;
              expect(bytes?.byteLength).toBe(Number(asset.byte_length));
              expect(`sha256:${createHash('sha256').update(bytes!).digest('hex')}`).toBe(asset.content_hash);
            }
            const pageZero = (
              await poolB.query(
                "select id from book_assets where book_id='book_series' and kind='document_page' and status='active' and page_index=0",
              )
            ).rows[0].id as string;
            const pageHash = persistentId128('archive_thumbnail_asset_v2', [pageZero, '0']);
            await poolB.query(
              `insert into document_annotations (id,book_id,user_id,page_index,annotation_type,anchor,body)
               values ('series_document_note','book_series','user_test',0,'note',$1::jsonb,'Page note')`,
              [JSON.stringify({ pageHash })],
            );
            for (const number of [3, 4]) {
              const next = await fixtureSeries([{ number, pages: [fixturePng(number + 1)] }], 'book_series');
              await fixtureA.import(next, true, 'book_series');
            }
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
            expect(
              (
                await poolB.query(
                  "select active_content_revision_id, content_revision_number from library_books where id='book_series'",
                )
              ).rows[0],
            ).toEqual(
              (
                await poolA.query(
                  "select active_content_revision_id, content_revision_number from library_books where id='book_series'",
                )
              ).rows[0],
            );
            const sourceAssets = (
              await poolA.query(
                "select id,kind,content_hash from book_assets where book_id='book_series' and status='active' and kind in ('document_page','source_part') order by id",
              )
            ).rows;
            const targetAssets = (
              await poolB.query(
                "select id,kind,content_hash,storage_key from book_assets where book_id='book_series' and status='active' and kind in ('document_page','source_part') order by id",
              )
            ).rows;
            expect(targetAssets.map(({ storage_key: _storageKey, ...asset }) => asset)).toEqual(sourceAssets);
            expect(targetAssets.every((asset) => fixtureB.objects.has(asset.storage_key))).toBe(true);
            expect(
              (await poolB.query("select body from document_annotations where id='series_document_note'")).rows[0].body,
            ).toBe('Page note');
            expect(
              (await poolB.query("select event_ids from sync_peer_content_receipts where book_id='book_series'"))
                .rows[0].event_ids,
            ).toHaveLength(2);
            const imageRevision = (
              await poolB.query("select active_content_revision_id from library_books where id='book_series'")
            ).rows[0].active_content_revision_id as string;
            await fixtureA.import(
              await fixtureSeries([{ number: 1, pages: [fixturePng(99)] }], 'book_series'),
              false,
              'book_series',
              { expectedBase: { kind: 'revision', contentRevisionId: imageRevision } },
            );
            const imageCursor = Number(
              (await poolA.query('select outbound_cursor from sync_server_peers')).rows[0].outbound_cursor,
            );
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({
              status: 'blocked',
              outboundCursor: imageCursor,
              lastError: 'peer_book_document_annotations_require_remap',
            });
            expect(
              (await poolB.query("select active_content_revision_id from library_books where id='book_series'")).rows[0]
                .active_content_revision_id,
            ).toBe(imageRevision);
            expect(
              (await poolB.query("select body from document_annotations where id='series_document_note'")).rows[0].body,
            ).toBe('Page note');
          } finally {
            await a.app.close();
            await b.app.close();
          }
        });
      });
    });
  }, 90_000);

  it('fast-forwards two remote TXT replacements through the inbound path', async () => {
    await withTwoDatabases(async (poolA, poolB) => {
      await withImportPageFixture(poolA, async (fixtureA) => {
        await withImportPageFixture(poolB, async (fixtureB) => {
          const a = await testServer(poolA, fixtureA.config.dataDir, 'native_a', 'user_test', 0, fixtureA.config);
          const b = await testServer(poolB, fixtureB.config.dataDir, 'native_b', 'user_test', 0, fixtureB.config);
          const request = (server: typeof a, resource: string, body: unknown) =>
            fetch(`${server.url}/api${resource}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
          const options = { fileName: 'fixture.txt', contentType: 'text/plain' };
          try {
            expect(
              (
                await request(b, '/auth/register', {
                  username: 'peer',
                  password: 'long peer test password',
                  setupCode: b.token,
                })
              ).status,
            ).toBe(201);
            expect(
              (
                await request(a, '/sync/peer', {
                  url: b.url,
                  username: 'peer',
                  password: 'long peer test password',
                  startFromNow: true,
                })
              ).status,
            ).toBe(200);
            await fixtureB.import(Buffer.from('First remote text.'), false, 'book_fixture', options);
            const inboundResult = await (await request(a, '/sync/peer/run', {})).json();
            expect(inboundResult).toEqual(expect.objectContaining({ status: 'ready', lastError: null }));
            const original = (
              await poolA.query("select active_content_revision_id from library_books where id='book_fixture'")
            ).rows[0].active_content_revision_id as string;
            await fixtureB.import(Buffer.from('Second remote text.'), false, 'book_fixture', {
              ...options,
              expectedBase: { kind: 'revision', contentRevisionId: original },
            });
            const second = (
              await poolB.query("select active_content_revision_id from library_books where id='book_fixture'")
            ).rows[0].active_content_revision_id as string;
            await fixtureB.import(Buffer.from('Third remote text.'), false, 'book_fixture', {
              ...options,
              expectedBase: { kind: 'revision', contentRevisionId: second },
            });
            const fastForwardResult = (await (await request(a, '/sync/peer/run', {})).json()) as {
              status: string;
              lastError: string | null;
            };
            expect(fastForwardResult.lastError).toBeNull();
            expect(fastForwardResult.status).toBe('ready');
            const source = (
              await poolB.query(
                "select active_content_revision_id, content_revision_number from library_books where id='book_fixture'",
              )
            ).rows[0];
            const target = (
              await poolA.query(
                "select active_content_revision_id, content_revision_number from library_books where id='book_fixture'",
              )
            ).rows[0];
            expect(target).toEqual(source);
            expect(Number(target.content_revision_number)).toBe(3);
            const receipt = (
              await poolA.query("select event_ids from sync_peer_content_receipts where book_id='book_fixture'")
            ).rows[0];
            expect(receipt.event_ids).toHaveLength(2);
            await fixtureB.import(Buffer.from('Offline initial.'), false, 'book_offline', options);
            const offlineFirst = (
              await poolB.query("select active_content_revision_id from library_books where id='book_offline'")
            ).rows[0].active_content_revision_id as string;
            await fixtureB.import(Buffer.from('Offline second.'), false, 'book_offline', {
              ...options,
              expectedBase: { kind: 'revision', contentRevisionId: offlineFirst },
            });
            const offlineSecond = (
              await poolB.query("select active_content_revision_id from library_books where id='book_offline'")
            ).rows[0].active_content_revision_id as string;
            await fixtureB.import(Buffer.from('Offline third.'), false, 'book_offline', {
              ...options,
              expectedBase: { kind: 'revision', contentRevisionId: offlineSecond },
            });
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
            expect(
              (
                await poolA.query(
                  "select active_content_revision_id, content_revision_number from library_books where id='book_offline'",
                )
              ).rows[0],
            ).toEqual(
              (
                await poolB.query(
                  "select active_content_revision_id, content_revision_number from library_books where id='book_offline'",
                )
              ).rows[0],
            );
            expect(
              (await poolA.query("select event_ids from sync_peer_content_receipts where book_id='book_offline'"))
                .rows[0].event_ids,
            ).toHaveLength(2);
          } finally {
            await a.app.close();
            await b.app.close();
          }
        });
      });
    });
  }, 90_000);

  it('applies a TXT replacement from the import worker and preserves target-only reader state', async () => {
    await withTwoDatabases(async (poolA, poolB) => {
      await withImportPageFixture(poolA, async (fixtureA) => {
        await withImportPageFixture(poolB, async (fixtureB) => {
          const a = await testServer(poolA, fixtureA.config.dataDir, 'native_a', 'user_test', 0, fixtureA.config);
          const b = await testServer(poolB, fixtureB.config.dataDir, 'native_b', 'user_test', 0, fixtureB.config);
          const request = (server: typeof a, resource: string, body: unknown) =>
            fetch(`${server.url}/api${resource}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
          try {
            expect(
              (
                await request(b, '/auth/register', {
                  username: 'peer',
                  password: 'long peer test password',
                  setupCode: b.token,
                })
              ).status,
            ).toBe(201);
            expect(
              (
                await request(a, '/sync/peer', {
                  url: b.url,
                  username: 'peer',
                  password: 'long peer test password',
                  startFromNow: true,
                })
              ).status,
            ).toBe(200);
            const original = Buffer.from('Chapter One\n\nKeep this paragraph.\n\nOld ending.');
            await fixtureA.import(original, false, 'book_fixture', {
              fileName: 'fixture.txt',
              contentType: 'text/plain',
            });
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
            const before = (
              await poolB.query("select active_content_revision_id from library_books where id='book_fixture'")
            ).rows[0].active_content_revision_id as string;
            const anchor = (
              await poolB.query(
                "select chapter_id, paragraph_id from paragraph_search where book_id='book_fixture' and text like '%Keep this paragraph%' limit 1",
              )
            ).rows[0] as { chapter_id: string; paragraph_id: string };
            expect(anchor).toBeDefined();
            await poolB.query("update library_books set title='Target title', favorite=true where id='book_fixture'");
            await poolB.query(
              `insert into reading_positions (book_id,user_id,chapter_id,paragraph_id,paragraph_index,scroll_top)
               values ('book_fixture','user_test',$1,$2,1,55)`,
              [anchor.chapter_id, anchor.paragraph_id],
            );
            await poolB.query(
              `insert into notes (id,book_id,user_id,chapter_id,paragraph_id,body)
               values ('target_note','book_fixture','user_test',$1,$2,'Do not lose this note')`,
              [anchor.chapter_id, anchor.paragraph_id],
            );
            await fixtureA.import(
              Buffer.from('Chapter One\n\nKeep this paragraph.\n\nNew ending.'),
              false,
              'book_fixture',
              {
                fileName: 'fixture.txt',
                contentType: 'text/plain',
                expectedBase: { kind: 'revision', contentRevisionId: before },
              },
            );
            const changed = (
              await poolA.query("select active_content_revision_id from library_books where id='book_fixture'")
            ).rows[0].active_content_revision_id as string;
            expect(changed).not.toBe(before);
            await poolB.query(`create function reject_peer_finalize() returns trigger language plpgsql as $$
              begin raise exception 'injected_peer_finalize_failure'; end $$`);
            await poolB.query(`create trigger reject_peer_finalize before update on book_replacement_runs
              for each row execute function reject_peer_finalize()`);
            const beforeFailedRun = Number(
              (await poolA.query('select outbound_cursor from sync_server_peers')).rows[0].outbound_cursor,
            );
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({
              status: 'offline',
              outboundCursor: beforeFailedRun,
            });
            expect(
              (await poolB.query("select active_content_revision_id from library_books where id='book_fixture'"))
                .rows[0].active_content_revision_id,
            ).toBe(before);
            expect((await poolB.query("select body from notes where id='target_note'")).rows[0]?.body).toBe(
              'Do not lose this note',
            );
            await poolB.query('drop trigger reject_peer_finalize on book_replacement_runs');
            await poolB.query('drop function reject_peer_finalize()');
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
            expect(
              (await poolB.query("select active_content_revision_id from library_books where id='book_fixture'"))
                .rows[0].active_content_revision_id,
            ).toBe(changed);
            expect(
              (await poolB.query("select title, favorite from library_books where id='book_fixture'")).rows[0],
            ).toMatchObject({
              title: 'Target title',
              favorite: true,
            });
            expect((await poolB.query("select body from notes where id='target_note'")).rows[0]?.body).toBe(
              'Do not lose this note',
            );
            expect(
              (await poolB.query("select paragraph_id from reading_positions where book_id='book_fixture'")).rows[0]
                ?.paragraph_id,
            ).toBe(anchor.paragraph_id);
            const transferred = (
              await poolB.query(
                "select storage_key from book_objects where id=(select object_id from library_books where id='book_fixture')",
              )
            ).rows[0].storage_key as string;
            expect(fixtureB.objects.get(transferred)?.bytes.toString()).toContain('New ending.');
            await poolA.query('update sync_server_peers set outbound_cursor=1');
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
            expect(
              (
                await poolB.query(
                  "select count(*)::int as n from book_content_revisions where book_id='book_fixture' and status='active'",
                )
              ).rows[0].n,
            ).toBe(1);
            const outboundOptions = { fileName: 'fixture.txt', contentType: 'text/plain' };
            await fixtureA.import(Buffer.from('Outbound initial.'), false, 'book_outbound', outboundOptions);
            const outboundFirst = (
              await poolA.query("select active_content_revision_id from library_books where id='book_outbound'")
            ).rows[0].active_content_revision_id as string;
            await fixtureA.import(Buffer.from('Outbound second.'), false, 'book_outbound', {
              ...outboundOptions,
              expectedBase: { kind: 'revision', contentRevisionId: outboundFirst },
            });
            const outboundSecond = (
              await poolA.query("select active_content_revision_id from library_books where id='book_outbound'")
            ).rows[0].active_content_revision_id as string;
            await fixtureA.import(Buffer.from('Outbound third.'), false, 'book_outbound', {
              ...outboundOptions,
              expectedBase: { kind: 'revision', contentRevisionId: outboundSecond },
            });
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
            expect(
              (
                await poolB.query(
                  "select active_content_revision_id, content_revision_number from library_books where id='book_outbound'",
                )
              ).rows[0],
            ).toEqual(
              (
                await poolA.query(
                  "select active_content_revision_id, content_revision_number from library_books where id='book_outbound'",
                )
              ).rows[0],
            );
            expect(
              (await poolB.query("select event_ids from sync_peer_content_receipts where book_id='book_outbound'"))
                .rows[0].event_ids,
            ).toHaveLength(2);
            const cursorBeforeRetry = Number(
              (await poolA.query('select outbound_cursor from sync_server_peers')).rows[0].outbound_cursor,
            );
            await fixtureA.import(
              Buffer.from('Chapter One\n\nKeep this paragraph.\n\nLater ending.'),
              false,
              'book_fixture',
              {
                fileName: 'fixture.txt',
                contentType: 'text/plain',
                expectedBase: { kind: 'revision', contentRevisionId: changed },
              },
            );
            const intermediate = (
              await poolA.query("select active_content_revision_id from library_books where id='book_fixture'")
            ).rows[0].active_content_revision_id as string;
            await fixtureA.import(
              Buffer.from('Chapter One\n\nKeep this paragraph.\n\nFinal offline ending.'),
              false,
              'book_fixture',
              {
                fileName: 'fixture.txt',
                contentType: 'text/plain',
                expectedBase: { kind: 'revision', contentRevisionId: intermediate },
              },
            );
            const nextKey = (
              await poolA.query(
                "select storage_key from book_objects where id=(select object_id from library_books where id='book_fixture')",
              )
            ).rows[0].storage_key as string;
            const savedSource = fixtureA.objects.get(nextKey);
            expect(savedSource).toBeDefined();
            fixtureA.objects.delete(nextKey);
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({
              status: 'offline',
              outboundCursor: cursorBeforeRetry,
            });
            fixtureA.objects.set(nextKey, savedSource!);
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
            const receipt = await poolB.query(
              "select base_revision_id, target_revision_id, event_ids from sync_peer_content_receipts where book_id='book_fixture'",
            );
            expect(receipt.rows).toHaveLength(1);
            expect(receipt.rows[0].base_revision_id).toBe(changed);
            expect(receipt.rows[0].event_ids).toHaveLength(2);
            const sharedBase = (
              await poolA.query("select active_content_revision_id from library_books where id='book_fixture'")
            ).rows[0].active_content_revision_id as string;
            expect(
              (await poolB.query("select active_content_revision_id from library_books where id='book_fixture'"))
                .rows[0].active_content_revision_id,
            ).toBe(sharedBase);
            const expectedBase = { kind: 'revision', contentRevisionId: sharedBase } as const;
            await fixtureA.import(Buffer.from('Chapter One\n\nOnly A changed.'), false, 'book_fixture', {
              fileName: 'fixture.txt',
              contentType: 'text/plain',
              expectedBase,
            });
            await fixtureB.import(Buffer.from('Chapter One\n\nOnly B changed.'), false, 'book_fixture', {
              fileName: 'fixture.txt',
              contentType: 'text/plain',
              expectedBase,
            });
            const bRevision = (
              await poolB.query("select active_content_revision_id from library_books where id='book_fixture'")
            ).rows[0].active_content_revision_id as string;
            const aRevision = (
              await poolA.query("select active_content_revision_id from library_books where id='book_fixture'")
            ).rows[0].active_content_revision_id as string;
            const staleDownload = await fetch(
              `${a.url}/api/sync/book-content/book_fixture?revision=${encodeURIComponent(sharedBase)}`,
              { headers: { Authorization: `Bearer ${a.token}` } },
            );
            expect(staleDownload.status).toBe(409);
            const archiveResponse = await fetch(
              `${a.url}/api/sync/book-content/book_fixture?revision=${encodeURIComponent(aRevision)}`,
              { headers: { Authorization: `Bearer ${a.token}` } },
            );
            expect(archiveResponse.status).toBe(200);
            const change = (
              await poolA.query(
                "select payload->'content' as change from sync_events where book_id='book_fixture' and type='book_imported' order by sequence desc limit 1",
              )
            ).rows[0].change;
            const staleInstall = await fetch(`${b.url}/api/sync/book-replacement/book_fixture`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${b.token}`,
                'Content-Type': 'application/zip',
                'X-Moya-Content-Change': Buffer.from(JSON.stringify(change)).toString('base64url'),
              },
              body: Buffer.from(await archiveResponse.arrayBuffer()),
            });
            expect(staleInstall.status).toBe(409);
            const beforeConflict = Number(
              (await poolA.query('select outbound_cursor from sync_server_peers')).rows[0].outbound_cursor,
            );
            expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({
              status: 'blocked',
              lastError: 'peer_book_revision_conflict',
              outboundCursor: beforeConflict,
            });
            expect(
              (await poolB.query("select active_content_revision_id from library_books where id='book_fixture'"))
                .rows[0].active_content_revision_id,
            ).toBe(bRevision);
            expect(
              (
                await poolA.query(
                  "select count(*)::int as n from sync_peer_conflicts where reason='peer_book_revision_conflict' and status='unresolved'",
                )
              ).rows[0].n,
            ).toBe(1);
          } finally {
            await a.app.close();
            await b.app.close();
          }
        });
      });
    });
  }, 90_000);

  it('does not skip an earlier event when transactions commit in the opposite sequence order', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'moya-peer-cursor-'));
    try {
      await withTwoDatabases(async (pool) => {
        await fixtureBook(pool, USER_A);
        const server = await testServer(pool, directory, 'native_a', USER_A);
        const writer = await pool.connect();
        let pending: Promise<{ cursor: number; events: Array<{ id: string }> }> | undefined;
        try {
          const event = (id: string) =>
            ownedEvent(
              canonicalV2Event({
                id,
                type: 'book_imported',
                deviceId: 'server',
                novelId: 'book_1',
                entityId: 'book_1',
                payload: { bookId: 'book_1' },
                createdAt: '2026-09-24T00:00:00.000Z',
              }),
              USER_A,
            );
          const earlier = event('earlier');
          const later = event('later');
          const sql = `insert into sync_events (id,user_id,type,book_id,entity_id,payload,created_at,id_contract,hash_contract)
            values ($1,$2,'book_imported','book_1','book_1',$3,$4,'v2-sha256-128','v2-sha256-tagged')`;
          const args = (e: SyncEvent) => [e.id, USER_A, JSON.stringify(e.payload), e.createdAt];
          await writer.query('begin');
          await writer.query(sql, args(earlier));
          await pool.query(sql, args(later));
          const pull = async (since: number) => {
            const response = await fetch(
              `${server.url}/api/sync?since=${since}&contractVersion=2&idContract=v2-sha256-128&hashContract=v2-sha256-tagged`,
              {
                headers: { Authorization: `Bearer ${server.token}` },
              },
            );
            expect(response.status).toBe(200);
            return response.json() as Promise<{ cursor: number; events: Array<{ id: string }> }>;
          };
          let settled = false;
          pending = pull(0).finally(() => {
            settled = true;
          });
          // Either the old SELECT returns too early, or the fixed pull queues its
          // table read lock behind the uncommitted writer. Do not rely on sleeps.
          const deadline = Date.now() + 3_000;
          while (!settled) {
            const queued = await pool.query(
              "select 1 from pg_locks where relation='sync_events'::regclass and mode='ShareLock' and not granted",
            );
            if (queued.rows.length) break;
            if (Date.now() > deadline) throw new Error('Sync pull did not reach its snapshot boundary');
            await delay(10);
          }
          await writer.query('commit');
          const first = await pending;
          const second = await pull(first.cursor);
          expect([...first.events, ...second.events].map((row) => row.id)).toEqual([earlier.id, later.id]);
        } finally {
          await writer.query('rollback');
          writer.release();
          await pending?.catch(() => undefined);
          await server.app.close();
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('transfers new book content in both directions without replacing user state, and retries an interrupted transfer', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'moya-peer-books-'));
    try {
      await withTwoDatabases(async (poolA, poolB) => {
        await fixtureBook(poolA, USER_A);
        await fixtureBook(poolB, USER_B);
        const a = await testServer(poolA, path.join(directory, 'a'), 'native_a', USER_A);
        const b = await testServer(poolB, path.join(directory, 'b'), 'native_b', USER_B);
        const request = (server: typeof a, resource: string, body?: unknown) =>
          fetch(`${server.url}/api${resource}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        const addBook = async (server: typeof a, pool: pg.Pool, suffix: string, publish = true) => {
          const bytes = Buffer.from(`New book content ${suffix}`);
          const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          const bookId = `book_${suffix}`;
          await pool.query(
            `insert into book_objects (id,raw_text_hash,storage_key,file_name,content_type,size_bytes)
            values ($1,$2,$3,'new.txt','text/plain',$4)`,
            [`source_${suffix}`, hash, `fixture/${suffix}`, bytes.length],
          );
          await pool.query(
            `insert into library_books (id,user_id,object_id,title,source_file_name,normalized_text_hash,total_chapters,total_characters,total_paragraphs)
            values ($1,$2,$3,$4,'new.txt',$5,1,$6,1)`,
            [bookId, server.config.defaultUserId, `source_${suffix}`, suffix, hash, bytes.length],
          );
          await pool.query(
            `insert into chapters (id,book_id,chapter_index,title,text_hash,raw_start_offset,raw_end_offset,character_count,paragraph_count)
            values ($1,$2,0,'Chapter',$3,0,$4,$4,1)`,
            [`chapter_${suffix}`, bookId, hash, bytes.length],
          );
          await pool.query(
            `insert into paragraph_pages (id,book_id,chapter_id,page_index,start_paragraph_index,end_paragraph_index,paragraphs,text_hash)
            values ($1,$2,$3,0,0,0,$4::jsonb,$5)`,
            [
              `page_${suffix}`,
              bookId,
              `chapter_${suffix}`,
              JSON.stringify([{ id: `paragraph_${suffix}`, index: 0, text: bytes.toString() }]),
              hash,
            ],
          );
          if (publish)
            await new FileObjectStore(server.config.objectStorageDir!).put(
              'test',
              `fixture/${suffix}`,
              bytes,
              'text/plain',
            );
          const event = ownedEvent(
            canonicalV2Event({
              id: `import_${suffix}`,
              type: 'book_imported',
              novelId: bookId,
              entityId: bookId,
              deviceId: 'server',
              payload: { bookId },
              createdAt: '2026-09-24T00:00:00.000Z',
              revision: {
                entityType: 'book',
                entityId: bookId,
                novelId: bookId,
                localSequence: 0,
                updatedAt: '2026-09-24T00:00:00.000Z',
                payloadHash: 'canonicalized-by-fixture',
              },
            }),
            server.config.defaultUserId,
          );
          const emitted = await request(server, '/sync/events', v2PushEnvelope([event]));
          expect(await emitted.json()).toMatchObject({ acceptedIds: [event.id] });
          // The existing import worker emits a book revision with no device_id.
          await pool.query('update sync_events set device_id=null where id=$1', [event.id]);
          return { bookId, bytes };
        };
        const copiedBytes = async (server: typeof a, pool: pg.Pool, bookId: string) => {
          const stored = await pool.query(
            'select o.storage_key from library_books b join book_objects o on o.id=b.object_id where b.id=$1',
            [bookId],
          );
          const object = await new FileObjectStore(server.config.objectStorageDir!).get(
            'test',
            stored.rows[0].storage_key,
          );
          const chunks: Buffer[] = [];
          for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
          return Buffer.concat(chunks);
        };
        try {
          expect(
            (
              await request(b, '/auth/register', {
                username: 'peer',
                password: 'long peer test password',
                setupCode: b.token,
              })
            ).status,
          ).toBe(201);
          expect(
            (
              await request(a, '/sync/peer', {
                url: b.url,
                username: 'peer',
                password: 'long peer test password',
                startFromNow: true,
              })
            ).status,
          ).toBe(200);
          await poolA.query(
            'insert into reader_settings (user_id,settings) values ($1, \'{"fontSize":17}\') on conflict (user_id) do update set settings=excluded.settings',
            [USER_A],
          );
          await poolB.query(
            'insert into reader_settings (user_id,settings) values ($1, \'{"fontSize":23}\') on conflict (user_id) do update set settings=excluded.settings',
            [USER_B],
          );
          const first = await addBook(a, poolA, 'new_a');
          const reading = await fetch(`${a.url}/api/books/${first.bookId}/reading-position`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ chapterId: 'chapter_new_a', updatedAt: '2026-09-24T01:00:00.000Z', scrollTop: 19 }),
          });
          expect(reading.status).toBe(200);
          const firstRun = await request(a, '/sync/peer/run', {});
          expect(await firstRun.json()).toMatchObject({ status: 'ready' });
          expect(await copiedBytes(b, poolB, first.bookId)).toEqual(first.bytes);
          expect(
            (await poolB.query('select scroll_top from reading_positions where book_id=$1', [first.bookId])).rows[0]
              .scroll_top,
          ).toBe(19);
          expect(
            (await poolB.query('select count(*)::int as n from paragraph_search where book_id=$1', [first.bookId]))
              .rows[0].n,
          ).toBe(1);
          expect(
            (await poolB.query('select settings from reader_settings where user_id=$1', [USER_B])).rows[0].settings,
          ).toEqual({ fontSize: 23 });
          const archiveResponse = await request(a, `/sync/book-content/${first.bookId}`);
          expect(archiveResponse.status).toBe(200);
          const archive = Buffer.from(await archiveResponse.arrayBuffer());
          const replayArchive = () =>
            fetch(`${b.url}/api/sync/book-content/${first.bookId}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/zip' },
              body: archive,
            });
          expect(await (await replayArchive()).json()).toMatchObject({ installed: false });
          expect(
            (await poolB.query('select scroll_top from reading_positions where book_id=$1', [first.bookId])).rows[0]
              .scroll_top,
          ).toBe(19);
          const unauthenticated = await fetch(`${b.url}/api/sync/book-content/${first.bookId}`);
          expect(unauthenticated.status).toBe(401);
          // Simulate loss of the acknowledgement/cursor after the receiver committed.
          await poolA.query('update sync_server_peers set outbound_cursor=0');
          expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
          expect(
            (await poolB.query('select count(*)::int as n from library_books where id=$1', [first.bookId])).rows[0].n,
          ).toBe(1);
          const second = await addBook(b, poolB, 'new_b');
          expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
          expect(await copiedBytes(a, poolA, second.bookId)).toEqual(second.bytes);
          expect(
            (await poolA.query('select settings from reader_settings where user_id=$1', [USER_A])).rows[0].settings,
          ).toEqual({ fontSize: 17 });
          const before = (await poolA.query('select inbound_cursor from sync_server_peers')).rows[0].inbound_cursor;
          const missing = await addBook(b, poolB, 'missing', false);
          expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'offline' });
          expect((await poolA.query('select inbound_cursor from sync_server_peers')).rows[0].inbound_cursor).toBe(
            before,
          );
          expect((await poolA.query('select id from library_books where id=$1', [missing.bookId])).rows).toHaveLength(
            0,
          );
          await new FileObjectStore(b.config.objectStorageDir!).put(
            'test',
            'fixture/missing',
            missing.bytes,
            'text/plain',
          );
          expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({ status: 'ready' });
          expect(await copiedBytes(a, poolA, missing.bookId)).toEqual(missing.bytes);
          // A collision preserves the target book and leaves the next event pending.
          await poolB.query("update book_objects set raw_text_hash='sha256:different' where id='source_new_a'");
          const positionUpdate = await fetch(`${a.url}/api/books/${first.bookId}/reading-position`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ chapterId: 'chapter_new_a', updatedAt: '2026-09-24T05:00:00.000Z', scrollTop: 43 }),
          });
          expect(positionUpdate.status).toBe(200);
          const cursor = Number(
            (await poolA.query('select outbound_cursor from sync_server_peers')).rows[0].outbound_cursor,
          );
          expect(await (await request(a, '/sync/peer/run', {})).json()).toMatchObject({
            status: 'blocked',
            lastError: 'peer_book_identity_mismatch',
            outboundCursor: cursor,
          });
          expect(cursor).toBeGreaterThan(0);
          expect(
            (await poolB.query("select raw_text_hash from book_objects where id='source_new_a'")).rows[0].raw_text_hash,
          ).toBe('sha256:different');
          expect((await replayArchive()).status).toBe(409);
        } finally {
          await a.app.close();
          await b.app.close();
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it('seeds an empty peer from the existing streamed server backup and then syncs new positions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'moya-peer-bootstrap-'));
    try {
      await withTwoDatabases(async (poolA, poolB) => {
        await fixtureBook(poolA, USER_A);
        await migrateDatabase(poolB);
        await poolB.query("insert into users (id,email,display_name) values ($1,'peer@example.com','Peer')", [USER_B]);
        const a = await testServer(poolA, path.join(directory, 'a'), 'native_a', USER_A);
        let b = await testServer(poolB, path.join(directory, 'b'), 'native_b', USER_B);
        try {
          const account = await fetch(`${a.url}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'source', password: 'long bootstrap password', setupCode: a.token }),
          });
          expect(account.status).toBe(201);
          const paired = await fetch(`${b.url}/api/sync/peer`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: a.url,
              username: 'source',
              password: 'long bootstrap password',
              startFromNow: true,
              requireEmptyLibrary: true,
            }),
          });
          expect(paired.status).toBe(200);
          expect(await paired.json()).toMatchObject({ status: 'awaiting_bootstrap', bootstrapRequired: true });
          // Opening/closing native settings can save preferences after pairing,
          // while the target book shelf is still empty.
          const preferences = await fetch(`${b.url}/api/settings`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ttsSpeed: 1.25 }),
          });
          expect(preferences.status).toBe(200);
          await poolA.query(
            'insert into reader_settings (user_id,settings) values ($1,\'{"ttsSpeed":0.75}\') on conflict (user_id) do update set settings=excluded.settings',
            [USER_A],
          );
          await b.app.close();
          b = await testServer(poolB, path.join(directory, 'b'), 'native_b', USER_B);
          // Closing the panel between pairing and copying must retain a durable retry state.
          const waiting = await fetch(`${b.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}` },
          });
          expect(await waiting.json()).toMatchObject({ status: 'awaiting_bootstrap', bootstrapRequired: true });
          const source = Buffer.from('Example text');
          const hash = `sha256:${createHash('sha256').update(source).digest('hex')}`;
          await poolA.query('update book_objects set raw_text_hash = $1, size_bytes = $2 where id = $3', [
            hash,
            source.length,
            'source_1',
          ]);
          const bootstrap = () =>
            fetch(`${b.url}/api/sync/peer/bootstrap`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${b.token}` },
            });
          await poolB.query(
            "insert into sync_events (id,user_id,type,payload,created_at) values ('scope_guard',$1,'shelf_created','{}',now())",
            [USER_B],
          );
          expect(await (await bootstrap()).json()).toMatchObject({ error: 'peer_bootstrap_library_changed' });
          await poolB.query("delete from sync_events where id='scope_guard'");
          await poolA.query('delete from self_host_sessions');
          expect((await bootstrap()).status).toBe(409);
          const pendingAuth = await fetch(`${b.url}/api/sync/peer`, {
            headers: { Authorization: `Bearer ${b.token}` },
          });
          expect(await pendingAuth.json()).toMatchObject({ status: 'needs_login', bootstrapRequired: true });
          const resumeAuth = await fetch(`${b.url}/api/sync/peer/reauthenticate`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'source', password: 'long bootstrap password' }),
          });
          expect(await resumeAuth.json()).toMatchObject({ status: 'awaiting_bootstrap', bootstrapRequired: true });
          const missingSource = await bootstrap();
          expect(missingSource.status).toBe(409);
          expect((await poolB.query('select count(*)::int as count from library_books')).rows[0].count).toBe(0);
          await new FileObjectStore(a.config.objectStorageDir!).put('test', 'fixture/source', source, 'text/plain');
          const seeded = await bootstrap();
          expect(await seeded.json()).toMatchObject({ status: 'ready', restoredBooks: 1 });
          expect(
            (await poolB.query('select settings from reader_settings where user_id=$1', [USER_B])).rows[0].settings
              .ttsSpeed,
          ).toBe(1.25);
          expect((await poolB.query('select count(*)::int as count from library_books')).rows[0].count).toBe(1);
          const object = (await poolB.query("select storage_key from book_objects where id='source_1'")).rows[0];
          const stored = await new FileObjectStore(b.config.objectStorageDir!).get('test', object.storage_key);
          const chunks: Buffer[] = [];
          for await (const chunk of stored.body) chunks.push(Buffer.from(chunk));
          const copied = Buffer.concat(chunks);
          expect(copied).toEqual(source);
          expect((await bootstrap()).status).toBe(409);
          const linkedPeer = (await poolB.query('select peer_id from sync_server_peers where user_id = $1', [USER_B]))
            .rows[0].peer_id;
          const reconnect = await fetch(`${b.url}/api/sync/peer`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: a.url,
              username: 'source',
              password: 'long bootstrap password',
              startFromNow: true,
              requireEmptyLibrary: true,
            }),
          });
          expect(reconnect.status).toBe(409);
          expect(await reconnect.json()).toMatchObject({ error: 'peer_bootstrap_requires_empty_library' });
          expect(
            (await poolB.query('select peer_id from sync_server_peers where user_id = $1', [USER_B])).rows[0].peer_id,
          ).toBe(linkedPeer);

          const changed = await fetch(`${a.url}/api/books/book_1/reading-position`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chapterId: 'chapter_1',
              paragraphId: 'paragraph_1',
              chapterProgress: 0.5,
              scrollTop: 320,
              deviceId: 'source',
              updatedAt: '2026-09-24T05:00:00.000Z',
            }),
          });
          expect(await changed.json()).toMatchObject({ ok: true, applied: true });
          const beforeLogin = (await poolB.query('select * from sync_server_peers')).rows[0];
          await poolA.query('delete from self_host_sessions');
          const expired = await fetch(`${b.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}` },
          });
          expect(await expired.json()).toMatchObject({ status: 'needs_login' });
          const wrongPassword = await fetch(`${b.url}/api/sync/peer/reauthenticate`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'source', password: 'incorrect password' }),
          });
          expect(wrongPassword.status).toBe(400);
          expect((await poolB.query('select * from sync_server_peers')).rows[0]).toMatchObject({
            peer_id: beforeLogin.peer_id,
            inbound_cursor: beforeLogin.inbound_cursor,
            outbound_cursor: beforeLogin.outbound_cursor,
            session_ciphertext: beforeLogin.session_ciphertext,
          });
          const loginAgain = await fetch(`${b.url}/api/sync/peer/reauthenticate`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'source', password: 'long bootstrap password' }),
          });
          expect(loginAgain.status).toBe(200);
          const afterLogin = (await poolB.query('select * from sync_server_peers')).rows[0];
          expect(afterLogin).toMatchObject({
            peer_id: beforeLogin.peer_id,
            inbound_cursor: beforeLogin.inbound_cursor,
            outbound_cursor: beforeLogin.outbound_cursor,
          });
          const sync = await fetch(`${b.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.token}` },
          });
          const syncState = await sync.json();
          expect(syncState, JSON.stringify(syncState)).toMatchObject({ status: 'ready' });
          expect(
            (await poolB.query("select scroll_top from reading_positions where book_id='book_1'")).rows[0].scroll_top,
          ).toBe(320);
        } finally {
          await a.app.close();
          await b.app.close();
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('commits a local position and its event together, and rejects a changed replay', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'moya-position-atomic-'));
    try {
      await withTwoDatabases(async (pool) => {
        await fixtureBook(pool, USER_A);
        const server = await testServer(pool, directory, 'native_a', USER_A);
        try {
          const position = {
            chapterId: 'chapter_1',
            paragraphId: 'paragraph_1',
            chapterProgress: 0.25,
            scrollTop: 120,
            deviceId: 'device_a',
            updatedAt: '2026-09-24T01:00:00.000Z',
          };
          const request = (method: 'PATCH' | 'DELETE', body: Record<string, unknown>) =>
            fetch(`${server.url}/api/books/book_1/reading-position`, {
              method,
              headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
          const rejectEvent = async () => {
            await pool.query(`create function reject_position_event() returns trigger language plpgsql as $$
              begin raise exception 'injected event write failure'; end $$`);
            await pool.query(`create trigger reject_position_event before insert on sync_events
              for each row execute function reject_position_event()`);
          };
          const allowEvent = async () => {
            await pool.query('drop trigger reject_position_event on sync_events');
            await pool.query('drop function reject_position_event()');
          };
          await rejectEvent();
          expect((await request('PATCH', position)).status).toBe(500);
          expect((await pool.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(0);
          await allowEvent();

          expect((await request('PATCH', position)).status).toBe(200);
          expect((await request('PATCH', position)).status).toBe(200);
          expect(
            (await pool.query("select count(*)::int as count from sync_events where type='reading_position_updated'"))
              .rows[0].count,
          ).toBe(1);
          expect((await request('PATCH', { ...position, scrollTop: 777 })).status).toBe(409);
          expect((await pool.query('select scroll_top from reading_positions')).rows[0].scroll_top).toBe(120);

          await rejectEvent();
          const deletion = { deviceId: 'device_a', updatedAt: '2026-09-24T02:00:00.000Z' };
          expect((await request('DELETE', deletion)).status).toBe(500);
          expect((await pool.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(1);
          await allowEvent();
          expect((await request('DELETE', deletion)).status).toBe(200);
          expect((await pool.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(0);
          expect(
            (await pool.query("select count(*)::int as count from sync_events where type='reading_position_deleted'"))
              .rows[0].count,
          ).toBe(1);
          // Both requests wait behind the same lock. The later PATCH must read the
          // DELETE tombstone committed while it was waiting, not its old statement snapshot.
          await request('PATCH', { ...position, updatedAt: '2026-09-24T03:00:00.000Z' });
          const blocker = await pool.connect();
          const pending: Array<Promise<Response>> = [];
          try {
            await blocker.query('begin');
            await blocker.query("select pg_advisory_xact_lock(hashtextextended('book_1', 7319))");
            const waitQueued = async (count: number) => {
              const deadline = Date.now() + 3_000;
              while (Date.now() < deadline) {
                const result = await pool.query(
                  "select count(*)::int as n from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())",
                );
                if (result.rows[0].n >= count) return;
                await delay(10);
              }
              throw new Error('Reading position requests did not queue behind the test lock');
            };
            pending.push(request('DELETE', { deviceId: 'device_a', updatedAt: '2026-09-24T05:00:00.000Z' }));
            await waitQueued(1);
            pending.push(request('PATCH', { ...position, updatedAt: '2026-09-24T04:00:00.000Z' }));
            await waitQueued(2);
            await blocker.query('commit');
            const [deleted, staleWrite] = await Promise.all(pending);
            expect(deleted.status).toBe(200);
            expect(await staleWrite.json()).toMatchObject({ applied: false });
            expect((await pool.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(0);
          } finally {
            await blocker.query('rollback');
            blocker.release();
            await Promise.allSettled(pending);
          }
        } finally {
          await server.app.close();
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('pairs with an account session and exchanges new positions in both directions across a restart', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'moya-peer-sync-'));
    try {
      await withTwoDatabases(async (poolA, poolB) => {
        await fixtureBook(poolA, USER_A);
        await fixtureBook(poolB, USER_B);
        const a = await testServer(poolA, path.join(directory, 'a'), 'native_a', USER_A);
        let b = await testServer(poolB, path.join(directory, 'b'), 'native_b', USER_B);
        try {
          const register = await fetch(`${b.url}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'peer', password: 'long peer test password', setupCode: b.token }),
          });
          expect(register.status).toBe(201);
          const cookie = register.headers.get('set-cookie')!.split(';', 1)[0];
          const unsafeUrl = await fetch(`${a.url}/api/sync/peer`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: 'http://192.0.2.1',
              username: 'peer',
              password: 'long peer test password',
              startFromNow: true,
            }),
          });
          expect(unsafeUrl.status).toBe(400);
          expect(await unsafeUrl.json()).toEqual({ error: 'invalid_peer_url' });
          const pair = await fetch(`${a.url}/api/sync/peer`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: b.url,
              username: 'peer',
              password: 'long peer test password',
              startFromNow: true,
            }),
          });
          expect(pair.status).toBe(200);
          expect(await pair.json()).toMatchObject({ outboundCursor: 0, inboundCursor: 0, status: 'ready' });
          const secret = await poolA.query('select session_ciphertext from sync_server_peers');
          expect(secret.rows[0].session_ciphertext).not.toContain('moya_session');

          const writeA = await fetch(`${a.url}/api/books/book_1/reading-position`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chapterId: 'chapter_1',
              paragraphId: 'paragraph_1',
              paragraphIndex: 12,
              offsetInParagraph: 3,
              chapterProgress: 0.42,
              scrollTop: 240,
              deviceId: 'device_a',
              updatedAt: '2026-09-24T01:00:00.000Z',
            }),
          });
          expect(await writeA.json()).toMatchObject({ ok: true, applied: true });
          const identities = await Promise.all([
            fetch(`${a.url}/api/sync/book-identity/book_1`, { headers: { Authorization: `Bearer ${a.token}` } }).then(
              (r) => r.json(),
            ),
            fetch(`${b.url}/api/sync/book-identity/book_1`, { headers: { Cookie: cookie } }).then((r) => r.json()),
          ]);
          expect(identities[0], JSON.stringify(identities)).toEqual(identities[1]);
          const firstRun = await fetch(`${a.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.token}` },
          });
          const firstState = await firstRun.json();
          expect(firstState, JSON.stringify(firstState)).toMatchObject({
            status: 'ready',
            outboundCursor: 1,
            inboundCursor: 1,
          });
          expect(
            (await poolB.query("select chapter_id from reading_positions where book_id='book_1'")).rows[0],
          ).toMatchObject({ chapter_id: 'chapter_1' });

          const peerPort = Number(new URL(b.url).port);
          await b.app.close();
          const offlineRun = await fetch(`${a.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.token}` },
          });
          expect(await offlineRun.json()).toMatchObject({ status: 'offline', lastError: 'peer_unreachable' });
          b = await testServer(poolB, path.join(directory, 'b'), 'native_b', USER_B, peerPort);
          const recoveredRun = await fetch(`${a.url}/api/sync/peer/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.token}` },
          });
          expect(await recoveredRun.json()).toMatchObject({ status: 'ready' });

          await a.app.close();
          const restarted = await testServer(poolA, path.join(directory, 'a'), 'native_a', USER_A);
          try {
            const bPosition = ownedEvent(readingPositionEvent('peer_b_position', '2026-09-24T02:00:00.000Z'), USER_B);
            const pushB = await fetch(`${b.url}/api/sync/events`, {
              method: 'POST',
              headers: { Cookie: cookie, 'Content-Type': 'application/json' },
              body: JSON.stringify(v2PushEnvelope([bPosition])),
            });
            expect((await pushB.json()).acceptedIds).toEqual([bPosition.id]);
            const secondRun = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect(await secondRun.json()).toMatchObject({ status: 'ready', outboundCursor: 1, inboundCursor: 2 });
            expect(
              (
                await poolA.query("select updated_at from reading_positions where book_id='book_1'")
              ).rows[0].updated_at.toISOString(),
            ).toBe('2026-09-24T02:00:00.000Z');
            const replay = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect((await replay.json()).status).toBe('ready');

            const deletedAt = '2026-09-24T02:30:00.000Z';
            const deleted = ownedEvent(
              canonicalV2Event({
                id: 'peer_b_position_deleted',
                type: 'reading_position_deleted',
                deviceId: 'device_b',
                novelId: 'book_1',
                entityId: 'reading_position_book_1',
                payload: { id: 'reading_position_book_1', bookId: 'book_1', deletedAt },
                createdAt: deletedAt,
              }),
              USER_B,
            );
            const pushedDelete = await fetch(`${b.url}/api/sync/events`, {
              method: 'POST',
              headers: { Cookie: cookie, 'Content-Type': 'application/json' },
              body: JSON.stringify(v2PushEnvelope([deleted])),
            });
            expect((await pushedDelete.json()).acceptedIds).toEqual([deleted.id]);
            const deletedRun = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            const peerWatermark = Number(
              (await poolB.query('select max(sequence) as cursor from sync_events')).rows[0].cursor,
            );
            expect(await deletedRun.json()).toMatchObject({ status: 'ready', inboundCursor: peerWatermark });
            expect((await poolA.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(0);
            expect((await poolB.query('select count(*)::int as count from reading_positions')).rows[0].count).toBe(0);
            const deletedReplay = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect(await deletedReplay.json()).toMatchObject({ status: 'ready' });

            const pairedAgain = await fetch(`${restarted.url}/api/sync/peer`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: b.url,
                username: 'peer',
                password: 'long peer test password',
                startFromNow: true,
              }),
            }).then((response) => response.json());
            const aConflict = ownedEvent(readingPositionEvent('peer_a_conflict', '2026-09-24T03:00:00.000Z'), USER_A);
            const bBase = ownedEvent(readingPositionEvent('peer_b_conflict', '2026-09-24T03:00:00.000Z'), USER_B);
            const bPayload = {
              position: { ...(bBase.payload as { position: Record<string, unknown> }).position, scrollTop: 777 },
            };
            const bConflict = {
              ...bBase,
              payload: bPayload,
              revision: bBase.revision
                ? { ...bBase.revision, payloadHash: syncPayloadIntegrityHash(bPayload) }
                : undefined,
            };
            for (const [server, headers, event] of [
              [restarted, { Authorization: `Bearer ${restarted.token}` }, aConflict],
              [b, { Cookie: cookie }, bConflict],
            ] as const) {
              const pushed = await fetch(`${server.url}/api/sync/events`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify(v2PushEnvelope([event])),
              });
              expect((await pushed.json()).acceptedIds).toEqual([event.id]);
            }
            const conflictRun = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect(await conflictRun.json()).toMatchObject({
              status: 'blocked',
              lastError: 'peer_stale_or_conflicting_position',
              outboundCursor: pairedAgain.outboundCursor,
              inboundCursor: pairedAgain.inboundCursor,
            });
            expect(
              (await poolA.query("select scroll_top from reading_positions where book_id='book_1'")).rows[0].scroll_top,
            ).toBe(240);
            expect(
              (await poolB.query("select scroll_top from reading_positions where book_id='book_1'")).rows[0].scroll_top,
            ).toBe(777);

            const unsupportedBaseline = await fetch(`${restarted.url}/api/sync/peer`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: b.url,
                username: 'peer',
                password: 'long peer test password',
                startFromNow: true,
              }),
            }).then((response) => response.json());
            const bookmark = ownedEvent(
              bookmarkCreatedEvent('peer_unsupported_bookmark', '2026-09-24T04:00:00.000Z'),
              USER_A,
            );
            const pushedBookmark = await fetch(`${restarted.url}/api/sync/events`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(v2PushEnvelope([bookmark])),
            });
            expect((await pushedBookmark.json()).acceptedIds).toEqual([bookmark.id]);
            const unsupportedRun = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect(await unsupportedRun.json()).toMatchObject({
              status: 'blocked',
              lastError: 'peer_event_type_unsupported',
              outboundCursor: unsupportedBaseline.outboundCursor,
              inboundCursor: unsupportedBaseline.inboundCursor,
            });
            const unresolved = await fetch(`${restarted.url}/api/sync/peer/conflicts`, {
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect(unresolved.status).toBe(200);
            expect(await unresolved.json()).toMatchObject({
              conflicts: [
                {
                  direction: 'outbound',
                  event_id: bookmark.id,
                  event_type: 'bookmark_created',
                  book_id: 'book_1',
                  reason: 'peer_event_type_unsupported',
                },
              ],
            });
            const persisted = await poolA.query(
              'select count(*)::int as count from sync_peer_conflicts where event_id=$1 and status=$2',
              [bookmark.id, 'unresolved'],
            );
            expect(persisted.rows[0].count).toBe(1);
            expect((await poolB.query('select count(*)::int as count from bookmarks')).rows[0].count).toBe(0);

            const reauthenticated = await fetch(`${restarted.url}/api/sync/peer`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: b.url,
                username: 'peer',
                password: 'long peer test password',
                startFromNow: true,
              }),
            });
            expect(reauthenticated.status).toBe(200);
            await poolB.query('delete from self_host_sessions');
            const expiredRun = await fetch(`${restarted.url}/api/sync/peer/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}` },
            });
            expect(await expiredRun.json()).toMatchObject({ status: 'needs_login', lastError: 'peer_auth_required' });

            const rePairBeforeShutdown = await fetch(`${restarted.url}/api/sync/peer`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${restarted.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: b.url,
                username: 'peer',
                password: 'long peer test password',
                startFromNow: true,
              }),
            });
            expect(rePairBeforeShutdown.status).toBe(200);
            const hangingPort = Number(new URL(b.url).port);
            await b.app.close();
            let requestArrived: () => void = () => undefined;
            const requestStarted = new Promise<void>((resolve) => {
              requestArrived = resolve;
            });
            const hanging = createServer(() => requestArrived());
            await new Promise<void>((resolve) => hanging.listen(hangingPort, '127.0.0.1', resolve));
            try {
              const pending = fetch(`${restarted.url}/api/sync/peer/run`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${restarted.token}` },
              }).catch(() => undefined);
              await Promise.race([
                requestStarted,
                delay(2_000).then(() => {
                  throw new Error('peer request never started');
                }),
              ]);
              const shutdownStarted = Date.now();
              await restarted.app.close();
              expect(Date.now() - shutdownStarted).toBeLessThan(2_000);
              await pending;
            } finally {
              hanging.closeAllConnections();
              await new Promise<void>((resolve) => hanging.close(() => resolve()));
            }
          } finally {
            await restarted.app.close();
          }
        } finally {
          await a.app.close();
          await b.app.close();
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
