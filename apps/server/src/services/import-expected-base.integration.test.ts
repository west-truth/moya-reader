import { afterAll, describe, expect, test } from 'vitest';
import { startPostgresIntegrationHarness, withPostgresSchema } from './id-v2-migration/postgres-integration-harness.js';
import { withImportPageFixture } from './testing/import-page-fixture.js';

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
