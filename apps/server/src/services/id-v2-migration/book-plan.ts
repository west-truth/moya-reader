import type { BookMigrationPlan, BookSourceLoader, IdV2IdentityFactory } from './contracts.js';
import { BOOK_BACKUP_TABLE_ORDER, bookSnapshotFingerprint, type BookSnapshotRows } from './book-snapshot.js';
import { buildCoreMigrationPlan } from './core-plan.js';
import { buildDependentMigrationRows } from './dependent-plan.js';
import { textValue } from './safe-values.js';

export async function buildBookMigrationPlan(input: {
  readonly runId: string;
  readonly userId: string;
  readonly rows: BookSnapshotRows;
  readonly identities: IdV2IdentityFactory;
  readonly sourceLoader: BookSourceLoader;
}): Promise<BookMigrationPlan> {
  const core = await buildCoreMigrationPlan({
    rows: input.rows,
    identities: input.identities,
    sourceLoader: input.sourceLoader,
    runId: input.runId,
  });
  const canonicalRows = buildDependentMigrationRows({
    sourceRows: input.rows,
    core,
    identities: input.identities,
  });
  const sourceFingerprint = bookSnapshotFingerprint(input.rows);
  const sourceCounts = Object.fromEntries(BOOK_BACKUP_TABLE_ORDER.map((table) => [table, input.rows[table].length]));
  const canonicalCounts = Object.fromEntries(
    BOOK_BACKUP_TABLE_ORDER.map((table) => [table, table === 'tts_audio_cache' ? 0 : canonicalRows[table].length]),
  );
  return {
    runId: input.runId,
    userId: input.userId,
    sourceBookId: core.sourceBookId,
    canonicalBookId: core.canonicalBookId,
    sourceFileName: core.sourceFileName,
    sourceNormalizedTextHash: core.sourceNormalizedTextHash,
    canonicalNormalizedTextHash: core.canonicalNormalizedTextHash,
    sourceObjectId: core.sourceObjectId,
    canonicalObjectId: core.canonicalObjectId,
    sourceFingerprint,
    aliases: core.aliases.entries(),
    rows: canonicalRows,
    quarantinedTtsRows: input.rows.tts_audio_cache,
    report: {
      idContract: 'v2-sha256-128',
      hashContract: 'v2-sha256-tagged',
      sourceCounts,
      canonicalCounts,
      aliasCount: core.aliases.entries().length,
      ttsCacheQuarantined: input.rows.tts_audio_cache.length,
      sourceBookId: core.sourceBookId,
      canonicalBookId: core.canonicalBookId,
      sourceObjectId: core.sourceObjectId,
      canonicalObjectId: core.canonicalObjectId,
      sourceTitle: textValue(input.rows.library_books[0].title, 'library_books.title'),
    },
  };
}
