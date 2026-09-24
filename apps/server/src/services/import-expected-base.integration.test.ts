import { afterAll, describe, expect, test } from 'vitest';
import { syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import { Readable } from 'node:stream';
import path from 'node:path';
import { startPostgresIntegrationHarness, withPostgresSchema } from './id-v2-migration/postgres-integration-harness.js';
import { withImportPageFixture } from './testing/import-page-fixture.js';
import { BackupStaging } from './backup-staging.js';
import { exportHostedBackup } from './hosted-backup-service.js';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => harness?.stop());
const describeWithPostgres = harness ? describe : describe.skip;
const textOptions = { fileName: 'fixture.txt', contentType: 'text/plain' };

describeWithPostgres('complete-package expected base with PostgreSQL and loopback S3', () => {
  test('creates and replaces once, rejecting same-hash absent and stale revision retries', async () => {
    await withPostgresSchema(harness!, 'import_expected_base', async (pool) => {
      await withImportPageFixture(pool, async (fixture) => {
        const read = async () =>
          (
            await pool.query(
              'select active_content_revision_id, normalized_text_hash, object_id from library_books where id = $1',
              ['book_fixture'],
            )
          ).rows[0];
        await fixture.import(Buffer.from('original paragraph'), false, 'book_fixture', {
          ...textOptions,
          expectedBase: { kind: 'absent' },
        });
        const original = await read();
        await expect(
          fixture.import(Buffer.from('original paragraph'), false, 'book_fixture', {
            ...textOptions,
            expectedBase: { kind: 'absent' },
          }),
        ).rejects.toThrow('import_expected_base_conflict');
        expect(await read()).toEqual(original);
        const expectedBase = { kind: 'revision', contentRevisionId: original.active_content_revision_id } as const;
        await fixture.import(Buffer.from('updated paragraph'), false, 'book_fixture', { ...textOptions, expectedBase });
        const updated = await read();
        expect(updated.active_content_revision_id).not.toBe(original.active_content_revision_id);
        const contentEvents = await pool.query<{
          payload: { bookId: string; content?: Record<string, unknown> };
          revision: { payloadHash: string };
        }>(
          "select payload, revision from sync_events where book_id='book_fixture' and type='book_imported' order by sequence",
        );
        expect(contentEvents.rows).toHaveLength(2);
        expect(contentEvents.rows[1].payload).toMatchObject({
          bookId: 'book_fixture',
          content: {
            kind: 'revision_v1',
            baseRevisionId: original.active_content_revision_id,
            targetRevisionId: updated.active_content_revision_id,
            revisionNumber: 2,
          },
        });
        expect(contentEvents.rows[1].revision.payloadHash).toBe(
          syncPayloadIntegrityHash(contentEvents.rows[1].payload),
        );
        const sourceHistory = await pool.query(
          `select revision.source_object_id, object.storage_key
             from book_content_revisions revision
             left join book_objects object on object.id=revision.source_object_id
            where revision.book_id='book_fixture' order by revision.revision_number`,
        );
        expect(sourceHistory.rows).toHaveLength(2);
        expect(sourceHistory.rows.every((row) => typeof row.storage_key === 'string')).toBe(true);
        const staging = new BackupStaging(path.join(fixture.config.dataDir, 'history-backup-staging'));
        try {
          const backup = await exportHostedBackup(pool, fixture.config);
          const received = await staging.receive(Readable.fromWeb(backup.readable as never));
          await backup.completion;
          expect(received.stage.source).toBe('hosted');
          if (received.stage.source !== 'hosted') throw new Error('Expected hosted archive');
          expect(received.stage.parsed.objects.filter((object) => object.asset_kind === 'source')).toHaveLength(2);
          expect(received.stage.parsed.tables.get('book_content_revisions')).toHaveLength(2);
          await staging.discard(received.id);
        } finally {
          await staging.close();
        }
        await expect(
          fixture.import(Buffer.from('updated paragraph'), false, 'book_fixture', { ...textOptions, expectedBase }),
        ).rejects.toThrow('import_expected_base_conflict');
        expect(await read()).toEqual(updated);
        const invalid = await pool.query(
          'select count(*)::int as count from upload_sessions where expected_base is not null',
        );
        expect(invalid.rows[0].count).toBe(4);
        await expect(pool.query("update upload_sessions set expected_base = '{}'::jsonb")).rejects.toThrow(
          'upload_sessions_expected_base_check',
        );
        for (const contentRevisionId of ['a', 'r'.repeat(512)]) {
          await pool.query('update upload_sessions set expected_base = $1::jsonb', [
            JSON.stringify({ kind: 'revision', contentRevisionId }),
          ]);
        }
        for (const contentRevisionId of ['', 'r'.repeat(513), 'invalid/id', 'invalid\nid']) {
          await expect(
            pool.query('update upload_sessions set expected_base = $1::jsonb', [
              JSON.stringify({ kind: 'revision', contentRevisionId }),
            ]),
          ).rejects.toThrow('upload_sessions_expected_base_check');
        }
      });
    });
  }, 30_000);

  test('allows only one concurrent creator and one concurrent replacement from the same captured base', async () => {
    await withPostgresSchema(harness!, 'import_expected_race', async (pool) => {
      await withImportPageFixture(pool, async (fixture) => {
        for (const kind of ['absent', 'revision'] as const) {
          const book = (
            await pool.query('select active_content_revision_id from library_books where id = $1', ['book_fixture'])
          ).rows[0];
          const expectedBase =
            kind === 'absent' ? { kind } : { kind, contentRevisionId: book.active_content_revision_id };
          const outcomes = await Promise.allSettled(
            ['one', 'two'].map((body) =>
              fixture.import(Buffer.from(`${kind} ${body} paragraph`), false, 'book_fixture', {
                ...textOptions,
                expectedBase,
              }),
            ),
          );
          expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
          const failure = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
          expect(failure.reason.message).toContain('import_expected_base_conflict');
        }
      });
    });
  }, 30_000);
});
