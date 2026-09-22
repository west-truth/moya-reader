import { afterAll, describe, expect, test } from 'vitest';
import { Readable } from 'node:stream';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { BackupStaging } from './backup-staging.js';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { LOCAL_ARCHIVE_SERIES_TYPE, isLocalArchiveSeries } from '@noveldesk/document-series-core';
import { startPostgresIntegrationHarness, withPostgresSchema } from './id-v2-migration/postgres-integration-harness.js';
import { fixturePng, withImportPageFixture } from './testing/import-page-fixture.js';
import { exportHostedBackup, restoreHostedBackup } from './hosted-backup-service.js';
import { drainObjectDeleteOutbox } from './object-delete-outbox.js';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => harness?.stop());
async function archive(format: string, number: number) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await writer.add('page.png', new Uint8ArrayReader(fixturePng(number)));
  if (format === 'epub') {
    await writer.add('mimetype', new TextReader('application/epub+zip'));
    await writer.add(
      'META-INF/container.xml',
      new TextReader('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    );
    await writer.add(
      'book.opf',
      new TextReader(
        '<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Original</dc:title></metadata><manifest><item id="text" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="image" href="page.png" media-type="image/png" properties="cover-image"/></manifest><spine><itemref idref="text"/></spine></package>',
      ),
    );
    await writer.add(
      'chapter.xhtml',
      new TextReader(
        `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Same title</h1><p>Chapter ${number}<a href="chapter.xhtml#note" role="doc-noteref">Note</a><a href="https://example.invalid/">Outside</a></p><p id="note">Footnote ${number}</p><img src="page.png"/></body></html>`,
      ),
    );
  }
  return Buffer.from(await (await writer.close()).arrayBuffer());
}

describe.skipIf(!harness)('hosted raw archive append', () => {
  test.each(['epub', 'cbz'])(
    'appends %s without reading or rewriting old content; fences retries and conflicts',
    async (format) => {
      await withPostgresSchema(harness!, `append_${format}`, async (pool) => {
        await withImportPageFixture(pool, async (fixture) => {
          const options = (number: number) => ({
            fileName: `${number}.${format}`,
            contentType: format === 'epub' ? 'application/epub+zip' : 'application/vnd.comicbook+zip',
          });
          const run = async (
            bytes: Buffer,
            opts: ReturnType<typeof options> & { localAppend?: boolean; baseRevision?: string },
          ) => {
            const { jobId } = await fixture.import(bytes, false, 'book_fixture', opts);
            return (await pool.query('select status,error_message from import_jobs where id=$1', [jobId])).rows[0];
          };
          const first = await archive(format, 1);
          expect(await run(first, options(1))).toMatchObject({ status: 'done' });
          await pool.query("update library_books set title='My title',favorite=true where id='book_fixture'");
          const beforeBook = (await pool.query("select * from library_books where id='book_fixture'")).rows[0];
          const beforeChapters = (
            await pool.query("select * from chapters where book_id='book_fixture' order by chapter_index")
          ).rows;
          const beforePages = (
            await pool.query("select * from paragraph_pages where book_id='book_fixture' order by id")
          ).rows;
          const beforeAssets = (
            await pool.query(
              "select id,storage_key,content_hash from book_assets where book_id='book_fixture' and status='active' order by id",
            )
          ).rows;
          const oldSource = (await pool.query('select * from book_objects where id=$1', [beforeBook.object_id]))
            .rows[0];
          const anchor = beforePages[0].paragraphs[0];
          await pool.query(
            "insert into reading_positions (book_id,user_id,chapter_id,paragraph_id,paragraph_index,scroll_top) values ('book_fixture','user_test',$1,$2,$3,123)",
            [anchor.chapterId, anchor.id, anchor.index],
          );
          await pool.query(
            "insert into bookmarks (id,book_id,user_id,chapter_id,paragraph_id,label) values ('bookmark','book_fixture','user_test',$1,$2,'keep')",
            [anchor.chapterId, anchor.id],
          );
          await pool.query(
            "insert into fixed_document_section_read_states (book_id,user_id,document_section_id,last_read_at) values ('book_fixture','user_test',$1,now())",
            [beforeChapters[0].document_section_id ?? beforeChapters[0].id],
          );
          const beforePosition = (await pool.query('select * from reading_positions')).rows[0];
          const beforeBookmark = (await pool.query('select * from bookmarks')).rows[0];
          const beforeRead = (await pool.query('select * from fixed_document_section_read_states')).rows;
          const putsAtStart = fixture.puts.length;
          const getsAtStart = fixture.gets.length;
          const second = await archive(format, 2);
          expect(await run(second, { ...options(2), localAppend: true })).toMatchObject({ status: 'done' });
          const book = (await pool.query("select * from library_books where id='book_fixture'")).rows[0];
          expect(book).toMatchObject({
            title: 'My title',
            favorite: true,
            total_chapters: beforeBook.total_chapters * 2,
            cover_asset_id: beforeBook.cover_asset_id,
            metadata_revision: beforeBook.metadata_revision,
          });
          expect((await pool.query('select * from reading_positions')).rows[0]).toEqual(beforePosition);
          expect((await pool.query('select * from bookmarks')).rows[0]).toEqual(beforeBookmark);
          expect((await pool.query('select * from fixed_document_section_read_states')).rows).toEqual(
            expect.arrayContaining(beforeRead),
          );
          const readProjection = (
            await pool.query(
              `select state.last_read_at from chapters c
            left join fixed_document_section_read_states state on state.book_id=c.book_id and state.user_id='user_test'
              and state.document_section_id=coalesce(c.document_section_id,c.id)
            where c.id=$1`,
              [beforeChapters[0].id],
            )
          ).rows[0];
          expect(readProjection.last_read_at).toEqual(beforeRead[0].last_read_at);
          expect(book.active_content_revision_id).not.toBe(beforeBook.active_content_revision_id);
          for (const row of beforePages)
            expect((await pool.query('select * from paragraph_pages where id=$1', [row.id])).rows[0]).toEqual(row);
          for (const row of beforeChapters)
            expect((await pool.query('select * from chapters where id=$1', [row.id])).rows[0]).toMatchObject({
              id: row.id,
              title: row.title,
              chapter_index: row.chapter_index,
              raw_start_offset: row.raw_start_offset,
            });
          for (const row of beforeAssets)
            expect(
              (await pool.query('select id,storage_key,content_hash from book_assets where id=$1', [row.id])).rows[0],
            ).toEqual(row);
          expect(fixture.gets.slice(getsAtStart)).toEqual([]);
          expect(fixture.puts.slice(putsAtStart).some((p) => beforeAssets.some((a) => p.key === a.storage_key))).toBe(
            false,
          );
          if (format === 'epub') {
            const newParagraphs = (
              await pool.query(
                "select p.paragraphs from paragraph_pages p join chapters c on c.id=p.chapter_id where c.book_id='book_fixture' and c.chapter_index > $1",
                [beforeBook.total_chapters],
              )
            ).rows.flatMap((r) => r.paragraphs);
            const linked = newParagraphs.find((p) => p.inlineMarks?.some((m: { kind: string }) => m.kind === 'link'));
            const internal = linked.inlineMarks.find((m: { href?: string }) =>
              m.href?.startsWith('.moya-append/'),
            ).href;
            expect(newParagraphs.some((p) => p.sourceHref === internal)).toBe(true);
            expect(
              linked.inlineSemantics.find((s: { kind: string }) => s.kind === 'footnote_reference').relatedBlockId,
            ).toBe(internal);
            expect(linked.inlineMarks.some((m: { href?: string }) => m.href === 'https://example.invalid/')).toBe(true);
            expect(beforePages.flatMap((p) => p.paragraphs).some((p) => p.sourceHref === internal)).toBe(false);
          }
          const index = (await pool.query('select * from book_objects where id=$1', [book.object_id])).rows[0];
          expect(index.content_type).toBe(LOCAL_ARCHIVE_SERIES_TYPE);
          const manifest = JSON.parse(fixture.objects.get(index.storage_key)!.bytes.toString());
          expect(isLocalArchiveSeries(manifest)).toBe(true);
          expect(manifest.sources).toHaveLength(2);
          const parts = (
            await pool.query(
              "select * from book_assets where book_id='book_fixture' and kind='source_part' order by page_index",
            )
          ).rows;
          expect(fixture.objects.get(parts[0].storage_key)!.bytes).toEqual(first);
          expect(fixture.objects.get(parts[1].storage_key)!.bytes).toEqual(second);
          expect(parts[0].storage_key).not.toBe(oldSource.storage_key);
          const putsBeforeRetry = fixture.puts.length;
          expect(
            await run(second, {
              ...options(2),
              localAppend: true,
              baseRevision: beforeBook.active_content_revision_id,
            }),
          ).toMatchObject({ status: 'done' });
          expect(fixture.puts).toHaveLength(putsBeforeRetry);
          expect(
            (await pool.query("select active_content_revision_id from library_books where id='book_fixture'")).rows[0]
              .active_content_revision_id,
          ).toBe(book.active_content_revision_id);
          await expect(
            run(await archive(format, 3), {
              ...options(3),
              localAppend: true,
              baseRevision: beforeBook.active_content_revision_id,
            }),
          ).rejects.toThrow('다른 작업');
          expect(
            (await pool.query("select total_chapters from library_books where id='book_fixture'")).rows[0]
              .total_chapters,
          ).toBe(book.total_chapters);
          expect(await run(await archive(format, 3), { ...options(3), localAppend: true })).toMatchObject({
            status: 'done',
          });
          expect(
            (await pool.query("select total_chapters from library_books where id='book_fixture'")).rows[0]
              .total_chapters,
          ).toBe(beforeBook.total_chapters * 3);
          const beforeCancel = (await pool.query("select * from library_books where id='book_fixture'")).rows[0];
          fixture.useExecutionLease = true;
          fixture.onPut = async () => {
            await pool.query(
              "update import_jobs set status='cancelled',cancel_requested_at=now() where status='processing'",
            );
          };
          expect(await run(await archive(format, 4), { ...options(4), localAppend: true })).toMatchObject({
            status: 'cancelled',
          });
          fixture.onPut = undefined;
          expect((await pool.query("select * from library_books where id='book_fixture'")).rows[0]).toEqual(
            beforeCancel,
          );
          const backup = await exportHostedBackup(pool, fixture.config);
          const beforeBackupPosition = (await pool.query('select * from reading_positions')).rows;
          const beforeBackupBookmarks = (await pool.query('select * from bookmarks')).rows;
          const stagingPath = path.join(fixture.config.dataDir, 'backup-staging');
          const staging = new BackupStaging(stagingPath);
          try {
            const [received] = await Promise.all([
              staging.receive(Readable.fromWeb(backup.readable as never)),
              backup.completion,
            ]);
            const stage = staging.take(received.id);
            try {
              expect([...stage.parsed.assetBlobs.values()].every((value) => value instanceof Blob)).toBe(true);
              await restoreHostedBackup(pool, fixture.config, stage.parsed, { defaultConflictResolution: 'replace' });
            } finally {
              await stage.dispose();
            }
          } finally {
            await staging.close();
          }
          expect(await readdir(stagingPath)).toEqual([]);
          expect((await pool.query('select * from reading_positions')).rows).toEqual(beforeBackupPosition);
          expect((await pool.query('select * from bookmarks')).rows).toEqual(beforeBackupBookmarks);
          expect(
            (await pool.query("select total_chapters from library_books where id='book_fixture'")).rows[0]
              .total_chapters,
          ).toBe(beforeBook.total_chapters * 3);
          expect(
            (await pool.query("select * from book_assets where kind='source_part' and status='active'")).rows,
          ).toHaveLength(3);
          await drainObjectDeleteOutbox(pool, fixture.config, 1000);
          for (const row of (await pool.query("select storage_key from book_assets where status='active'")).rows)
            expect(fixture.objects.has(row.storage_key), row.storage_key).toBe(true);
        });
      });
    },
    60_000,
  );
});
