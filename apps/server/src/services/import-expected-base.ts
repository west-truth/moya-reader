import type pg from 'pg';
import type { ImportExpectedBase } from '@noveldesk/contracts';

export function parseImportExpectedBase(value: unknown): ImportExpectedBase | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (candidate.kind === 'absent' && Object.keys(candidate).length === 1) return { kind: 'absent' };
    if (
      candidate.kind === 'revision' &&
      Object.keys(candidate).length === 2 &&
      typeof candidate.contentRevisionId === 'string' &&
      /^[A-Za-z0-9:_-]{1,512}$/.test(candidate.contentRevisionId)
    ) {
      return { kind: 'revision', contentRevisionId: candidate.contentRevisionId };
    }
  }
  throw new Error('invalid_import_expected_base');
}

/** Run in the activation transaction, before preparing/quarantining the old book. */
export async function assertImportExpectedBase(
  client: pg.PoolClient,
  input: { bookId: string; userId: string; expectedBase?: ImportExpectedBase },
): Promise<void> {
  if (!input.expectedBase) return;
  const current = await client.query<{ user_id: string; active_content_revision_id: string }>(
    'select user_id, active_content_revision_id from library_books where id = $1 for update',
    [input.bookId],
  );
  const row = current.rows[0];
  if (
    input.expectedBase.kind === 'absent'
      ? Boolean(row)
      : !row || row.user_id !== input.userId || row.active_content_revision_id !== input.expectedBase.contentRevisionId
  ) {
    throw new Error('import_expected_base_conflict');
  }
  // Absence cannot be row-locked. The book INSERT also uses a conditional conflict
  // clause so a concurrent first creation can never turn this into a replacement.
}
