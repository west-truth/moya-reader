import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { integrityHash } from '@noveldesk/text-core/hash';
import { readDocumentSeriesArchive } from '@noveldesk/document-series-core';
import { startPostgresIntegrationHarness, withPostgresSchema } from './id-v2-migration/postgres-integration-harness.js';
import { withImportPageFixture } from './testing/import-page-fixture.js';
import { createS3Client } from './object-storage.js';
import { createDocumentSeriesSnapshot } from './document-series-snapshot.js';
import { stageServerImport } from './stage-server-import.js';
import { processImportJob } from './import-service.js';
import { registerPreparedSourceDocuments } from '../routes/prepared-source-documents.js';
import { registerReaderStateRoutes } from '../routes/books/reader-state-routes.js';
import type { ExternalSourceRegistryPort } from '../../../../src/external-sources/app-external-source-registry.js';
import type { ExternalItemSummary } from '../../../../src/external-sources/contracts.js';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => harness?.stop());
describe.skipIf(!harness)('server-owned document imports with PostgreSQL and S3 HTTP', () => {
  it('stages exact-base jobs, preserves reading anchors, rejects stale activation and never transfers a book to the browser', async () => {
    await withPostgresSchema(harness!, 'prepared_document', (pool) =>
      withImportPageFixture(pool, async (fixture) => {
        const app = Fastify();
        const s3 = createS3Client(fixture.config);
        const read = createDocumentSeriesSnapshot(pool, fixture.config, s3);
        const sourceId = 'fixture.document';
        const body = (id: string) => `\uFEFF${id}\r\n\r\n두 번째 문단.  공백 보존.\r\n`;
        const registry = {
          getExternalSourceStatus: () => ({ state: 'connected', connectionGeneration: 'one' }),
          downloadExternalSource: async (_id: string, _context: unknown, ref: { key: { remoteId: string } }) => {
            const file = new File([body(ref.key.remoteId)], 'release.txt');
            return {
              file,
              content: { kind: 'document', file, format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
            };
          },
        } as unknown as ExternalSourceRegistryPort;
        registerPreparedSourceDocuments(
          app,
          registry,
          async () => {},
          {
            read,
            stage: (file, input, signal) => stageServerImport(pool, fixture.config, file, input, signal),
          },
          async (reply, run) => {
            try {
              return await run();
            } catch (error) {
              return reply.code(422).send({ error: (error as Error).message });
            }
          },
          (_request, _reply, run) => run(new AbortController().signal),
        );
        await registerReaderStateRoutes(app, pool, fixture.config);
        const prefix = `/api/extensions/sources/${sourceId}/prepared-documents`;
        const book = async () => (await pool.query("select * from library_books where id = 'book_fixture'")).rows[0];
        const prepare = async (n: number) => {
          const key = { connectorId: sourceId, remoteId: `release-${n}` };
          const downloaded = await app.inject({
            method: 'POST',
            url: prefix,
            payload: { key, fileName: 'release.txt' },
          });
          expect(downloaded.statusCode, downloaded.body).toBe(200);
          const current = await book();
          const item: ExternalItemSummary = {
            key,
            kind: 'file',
            title: `${n}화`,
            importability: 'supported',
            release: { title: `${n}화`, sourceOrder: n },
            collection: {
              remoteId: 'work',
              title: 'Fixture',
              seriesProfile: { kind: 'document_series', format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
            },
          };
          const result = await app.inject({
            method: 'POST',
            url: `${prefix}/assemble`,
            payload: {
              artifactId: downloaded.json().artifactId,
              item,
              targetBookId: 'book_fixture',
              expectedBase: current
                ? { kind: 'revision', contentRevisionId: current.active_content_revision_id }
                : { kind: 'absent' },
            },
          });
          expect(result.statusCode, result.body).toBe(200);
          expect(result.json()).not.toHaveProperty('file');
          expect(result.json()).not.toHaveProperty('existingSource');
          return result.json().prepared as { uploadId: string; byteLength: number; sourceContentHash: string };
        };
        const activate = async (receipt: Awaited<ReturnType<typeof prepare>>) => {
          const jobId = `job_${randomUUID()}`;
          await pool.query("update upload_sessions set status = 'queued' where id = $1", [receipt.uploadId]);
          await pool.query(
            `insert into import_jobs (id,user_id,upload_id,status,stage,total_bytes) values ($1,$2,$3,'queued','queued',$4)`,
            [jobId, fixture.config.defaultUserId, receipt.uploadId, receipt.byteLength],
          );
          await processImportJob(pool, fixture.config, jobId, receipt.uploadId, {
            attemptNumber: 1,
            maxAttempts: 1,
            finalAttempt: true,
          });
        };
        try {
          const first = await prepare(1);
          const stored = (
            await pool.query('select expected_base, encoding, chapter_split_mode from upload_sessions where id = $1', [
              first.uploadId,
            ])
          ).rows[0];
          expect(stored).toEqual({
            expected_base: { kind: 'absent' },
            encoding: 'utf-8',
            chapter_split_mode: 'single',
          });
          await activate(first);
          const chapter = (await pool.query('select id from chapters order by chapter_index')).rows[0]!;
          const paragraph = (await pool.query('select paragraph_id from paragraph_search order by paragraph_index'))
            .rows[1]!;
          const saved = await app.inject({
            method: 'PATCH',
            url: '/api/books/book_fixture/reading-position',
            payload: {
              chapterId: chapter.id,
              paragraphId: paragraph.paragraph_id,
              offsetInParagraph: 3,
              chapterProgress: 0.45,
              scrollTop: 321,
              deviceId: 'tablet',
              updatedAt: '2026-09-13T01:00:00Z',
            },
          });
          expect(saved.statusCode, saved.body).toBe(200);
          const beforePosition = (
            await pool.query('select chapter_id, paragraph_id, offset_in_paragraph from reading_positions')
          ).rows;
          const second = await prepare(2);
          const staleThird = await prepare(3);
          await activate(second);
          expect((await book()).total_chapters).toBe(2);
          expect(
            (await pool.query('select chapter_id, paragraph_id, offset_in_paragraph from reading_positions')).rows,
          ).toEqual(beforePosition);
          await expect(activate(staleThird)).rejects.toThrow('import_expected_base_conflict');
          expect((await book()).total_chapters).toBe(2);
          const third = await prepare(3);
          await activate(third);
          const current = await book();
          const snapshot = await read(
            'book_fixture',
            { kind: 'revision', contentRevisionId: current.active_content_revision_id },
            new AbortController().signal,
          );
          const archive = (await readDocumentSeriesArchive(snapshot.existingSource!.blob))!;
          expect(archive.manifest.sources).toHaveLength(3);
          for (const entry of archive.manifest.sources) {
            const bytes = new Uint8Array(await archive.sources.get(entry.id)!.arrayBuffer());
            expect(bytes).toEqual(new TextEncoder().encode(body(`release-${entry.sourceOrder}`)));
            expect(integrityHash(bytes)).toBe(entry.contentHash);
          }
          expect(await prepare(3)).toBeUndefined();
          expect(
            (await pool.query('select chapter_id, paragraph_id, offset_in_paragraph from reading_positions')).rows,
          ).toEqual(beforePosition);
          await expect(read('book_fixture', { kind: 'absent' }, new AbortController().signal)).rejects.toThrow(
            'import_expected_base_conflict',
          );
          const otherOwner = createDocumentSeriesSnapshot(pool, { ...fixture.config, defaultUserId: 'other' }, s3);
          await expect(
            otherOwner(
              'book_fixture',
              { kind: 'revision', contentRevisionId: current.active_content_revision_id },
              new AbortController().signal,
            ),
          ).rejects.toThrow('import_expected_base_conflict');
          const key = (await pool.query('select storage_key from book_objects where id = $1', [current.object_id]))
            .rows[0]!.storage_key;
          const object = fixture.objects.get(key)!;
          const original = object.bytes;
          object.bytes = Buffer.from(original);
          object.bytes[0] ^= 1;
          try {
            await expect(
              read(
                'book_fixture',
                { kind: 'revision', contentRevisionId: current.active_content_revision_id },
                new AbortController().signal,
              ),
            ).rejects.toThrow('invalid_source_assets');
          } finally {
            object.bytes = original;
          }
        } finally {
          await app.close();
          s3.destroy();
        }
      }),
    );
  }, 60_000);
});
