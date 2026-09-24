import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { IndexedDbBackupRepository } from '../../../src/storage/indexeddb-backup-repository.js';
import {
  getChapters,
  getParagraphs,
  resetReaderDbForTests,
  saveBookmark,
  saveReadingPosition,
} from '../../../src/storage/db.js';
import { runBrowserImportPipeline } from '../../../src/services/import/browser-import-pipeline.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../src/services/id-v2-migration/postgres-integration-harness.js';
import { withImportPageFixture } from '../src/services/testing/import-page-fixture.js';
import { BackupStaging } from '../src/services/backup-staging.js';
import { inspectHostedBackup, restoreHostedBackup } from '../src/services/hosted-backup-service.js';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => harness?.stop());

describe.skipIf(!harness)('local v1 backup restore with PostgreSQL and object storage', () => {
  it('stages an actual local ZIP and preserves source, position and bookmark across conflict choices', async () => {
    await resetReaderDbForTests();
    const source = new TextEncoder().encode('제1화 시작\n\n이전할 문단입니다.');
    const imported = await runBrowserImportPipeline({
      jobId: 'local-db-restore',
      fileName: 'local.txt',
      buffer: source.buffer as ArrayBuffer,
      sourceBlob: new Blob([source], { type: 'text/plain' }),
      totalBytes: source.byteLength,
      encoding: 'utf-8',
      chapterSplitMode: 'mixed',
      onProgress: () => undefined,
      yieldControl: async () => undefined,
    });
    const [chapter] = await getChapters(imported.novel.id);
    const [paragraph] = await getParagraphs(chapter.id);
    await saveBookmark({
      id: 'local_bookmark',
      novelId: imported.novel.id,
      chapterId: chapter.id,
      paragraphId: paragraph.id,
      label: '보존할 위치',
      progress: 0.4,
      scrollTop: 31,
      createdAt: '2026-09-24T00:00:00.000Z',
    });
    await saveReadingPosition({
      novelId: imported.novel.id,
      chapterId: chapter.id,
      paragraphId: paragraph.id,
      paragraphIndex: paragraph.index,
      chapterProgress: 0.4,
      scrollTop: 31,
    });
    const { blob } = await new IndexedDbBackupRepository().exportBackup();
    const zip = Buffer.from(await blob.arrayBuffer());
    const zipHash = `sha256:${createHash('sha256').update(zip).digest('hex')}`;

    await withPostgresSchema(harness!, 'local_backup', async (pool) => {
      await withImportPageFixture(pool, async (fixture) => {
        const staging = new BackupStaging(
          path.join(fixture.config.dataDir, 'backup-staging'),
          fixture.config.defaultUserId,
        );
        try {
          const interrupted = await staging.receive(Readable.from([zip]), zip.length);
          const interruptedStage = staging.take(interrupted.id);
          fixture.onPut = async () => {
            throw new Error('fixture upload interruption');
          };
          try {
            await expect(
              restoreHostedBackup(pool, fixture.config, interruptedStage.parsed, { defaultConflictResolution: 'skip' }),
            ).rejects.toThrow();
          } finally {
            fixture.onPut = undefined;
            await interruptedStage.dispose();
          }
          expect((await pool.query('select count(*)::int as count from library_books')).rows[0].count).toBe(0);

          const received = await staging.receive(Readable.from([zip]), zip.length);
          expect(received.stage.source).toBe('local');
          expect(received.stage.parsed.archiveHash).toBe(zipHash);
          const inspection = await inspectHostedBackup(pool, fixture.config, received.stage.parsed, zip.length);
          expect(inspection.conflicts).toEqual([]);
          const stage = staging.take(received.id);
          try {
            expect(
              await restoreHostedBackup(pool, fixture.config, stage.parsed, { defaultConflictResolution: 'skip' }),
            ).toMatchObject({ restoredBooks: 1 });
          } finally {
            await stage.dispose();
          }
          const book = (await pool.query('select * from library_books where id=$1', [imported.novel.id])).rows[0];
          const object = (await pool.query('select * from book_objects where id=$1', [book.object_id])).rows[0];
          expect(fixture.objects.get(object.storage_key)?.bytes).toEqual(Buffer.from(source));
          expect(
            (await pool.query('select * from reading_positions where book_id=$1', [book.id])).rows[0],
          ).toMatchObject({ chapter_id: chapter.id, paragraph_id: paragraph.id, scroll_top: 31 });
          expect((await pool.query('select * from bookmarks where book_id=$1', [book.id])).rows[0]).toMatchObject({
            id: 'local_bookmark',
            label: '보존할 위치',
          });

          const second = await staging.receive(Readable.from([zip]), zip.length);
          expect((await inspectHostedBackup(pool, fixture.config, second.stage.parsed)).conflicts).toEqual([
            expect.objectContaining({ bookId: book.id }),
          ]);
          const secondStage = staging.take(second.id);
          try {
            expect(
              await restoreHostedBackup(pool, fixture.config, secondStage.parsed, {
                defaultConflictResolution: 'skip',
              }),
            ).toMatchObject({ skippedBooks: 1 });
          } finally {
            await secondStage.dispose();
          }
          expect((await pool.query('select count(*)::int as count from library_books')).rows[0].count).toBe(1);
          for (const [choice, expected] of [
            ['replace', { restoredBooks: 1 }],
            ['copy', { copiedBooks: 1 }],
          ] as const) {
            const pending = await staging.receive(Readable.from([zip]), zip.length);
            const claimed = staging.take(pending.id);
            try {
              expect(
                await restoreHostedBackup(pool, fixture.config, claimed.parsed, { defaultConflictResolution: choice }),
              ).toMatchObject(expected);
            } finally {
              await claimed.dispose();
            }
          }
          const copied = (await pool.query('select * from library_books where id<>$1', [book.id])).rows[0];
          expect(copied).toMatchObject({ title: `${book.title} (복사본)` });
          const copiedPosition = (await pool.query('select * from reading_positions where book_id=$1', [copied.id]))
            .rows[0];
          expect(copiedPosition).toMatchObject({ scroll_top: 31 });
          const copiedBookmark = (await pool.query('select * from bookmarks where book_id=$1', [copied.id])).rows[0];
          expect(copiedBookmark).toMatchObject({ label: '보존할 위치' });
          expect(copiedBookmark.id).not.toBe('local_bookmark');
        } finally {
          await staging.close();
        }
      });
    });
  }, 60_000);
});
