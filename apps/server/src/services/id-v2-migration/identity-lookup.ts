import type pg from 'pg';
import type { BookEntityType, GlobalEntityType } from './contracts.js';
import { IdV2MigrationError } from './contracts.js';

interface BookAliasRow extends pg.QueryResultRow {
  source_book_id: string;
  canonical_book_id: string;
  alias_complete: boolean;
  status: string;
}

interface EntityAliasRow extends pg.QueryResultRow {
  source_id: string;
  canonical_id: string;
  alias_complete: boolean;
  status: string;
}

export interface CanonicalBookIdentity {
  readonly bookId: string;
  readonly sourceBookId: string;
  readonly source: 'canonical' | 'alias';
}

async function activeBookAlias(pool: pg.Pool, userId: string, bookId: string): Promise<BookAliasRow | undefined> {
  const result = await pool.query<BookAliasRow>(
    `
      select source_book_id, canonical_book_id, alias_complete, status
      from id_v2_book_aliases
      where user_id = $1
        and status = 'active'
        and alias_complete
        and (source_book_id = $2 or canonical_book_id = $2)
      order by case when source_book_id = $2 then 0 else 1 end
      limit 1
    `,
    [userId, bookId],
  );
  return result.rows[0];
}

export async function canonicalizeBookId(
  pool: pg.Pool,
  userId: string,
  sourceOrCanonicalBookId: string,
): Promise<CanonicalBookIdentity> {
  const alias = await activeBookAlias(pool, userId, sourceOrCanonicalBookId);
  if (alias) {
    return {
      bookId: alias.canonical_book_id,
      sourceBookId: alias.source_book_id,
      source: alias.source_book_id === sourceOrCanonicalBookId ? 'alias' : 'canonical',
    };
  }

  const canonical = await pool.query(
    `
      select 1
      from library_books
      where user_id = $1 and id = $2 and id_contract = 'v2-sha256-128'
    `,
    [userId, sourceOrCanonicalBookId],
  );
  if (canonical.rowCount === 1) {
    return {
      bookId: sourceOrCanonicalBookId,
      sourceBookId: sourceOrCanonicalBookId,
      source: 'canonical',
    };
  }
  throw new IdV2MigrationError('book_alias_missing', 'The book identity has no complete v2 alias.');
}

export async function resolveBookBySourceIdentity(
  pool: pg.Pool,
  userId: string,
  sourceFileName: string,
  canonicalNormalizedTextHash: string,
): Promise<string | undefined> {
  const result = await pool.query<{ canonical_book_id: string }>(
    `
      select canonical_book_id
      from id_v2_book_aliases
      where user_id = $1
        and source_file_name = $2
        and canonical_normalized_text_hash = $3
        and status = 'active'
        and alias_complete
      limit 1
    `,
    [userId, sourceFileName, canonicalNormalizedTextHash],
  );
  if (result.rows[0]) return result.rows[0].canonical_book_id;

  const direct = await pool.query<{ id: string }>(
    `
      select id
      from library_books
      where user_id = $1
        and source_file_name = $2
        and normalized_text_hash = $3
        and id_contract = 'v2-sha256-128'
        and hash_contract = 'v2-sha256-tagged'
      limit 1
    `,
    [userId, sourceFileName, canonicalNormalizedTextHash],
  );
  return direct.rows[0]?.id;
}

export async function canonicalizeBookEntityId(
  pool: pg.Pool,
  input: {
    readonly userId: string;
    readonly sourceBookId: string;
    readonly entityType: BookEntityType;
    readonly sourceId: string;
  },
): Promise<string> {
  const book = await canonicalizeBookId(pool, input.userId, input.sourceBookId);
  if (input.entityType === 'book') return book.bookId;

  const result = await pool.query<EntityAliasRow>(
    `
      select source_id, canonical_id, alias_complete, status
      from id_v2_entity_aliases
      where user_id = $1
        and source_book_id = $2
        and entity_type = $3
        and status = 'active'
        and alias_complete
        and (source_id = $4 or canonical_id = $4)
      limit 1
    `,
    [input.userId, book.sourceBookId, input.entityType, input.sourceId],
  );
  const alias = result.rows[0];
  if (!alias) {
    throw new IdV2MigrationError('entity_alias_missing', 'The child identity has no complete v2 alias.', {
      entityType: input.entityType,
      sourceId: input.sourceId,
    });
  }
  return alias.canonical_id;
}

export async function reverseMapBookEntityId(
  pool: pg.Pool,
  input: {
    readonly userId: string;
    readonly canonicalBookId: string;
    readonly entityType: BookEntityType;
    readonly canonicalId: string;
  },
): Promise<string> {
  const bookAlias = await activeBookAlias(pool, input.userId, input.canonicalBookId);
  if (!bookAlias?.alias_complete || bookAlias.status !== 'active') {
    throw new IdV2MigrationError('reverse_book_alias_incomplete', 'The book cannot be reverse-mapped safely.');
  }
  if (input.entityType === 'book') return bookAlias.source_book_id;

  const result = await pool.query<EntityAliasRow>(
    `
      select source_id, canonical_id, alias_complete, status
      from id_v2_entity_aliases
      where user_id = $1
        and source_book_id = $2
        and entity_type = $3
        and canonical_id = $4
        and status = 'active'
        and alias_complete
      limit 1
    `,
    [input.userId, bookAlias.source_book_id, input.entityType, input.canonicalId],
  );
  const alias = result.rows[0];
  if (!alias) {
    throw new IdV2MigrationError('reverse_entity_alias_incomplete', 'The child identity cannot be reverse-mapped.', {
      entityType: input.entityType,
      sourceId: input.canonicalId,
    });
  }
  return alias.source_id;
}

export async function canonicalizeGlobalEntityId(
  pool: pg.Pool,
  input: {
    readonly userId: string;
    readonly entityType: GlobalEntityType;
    readonly sourceId: string;
  },
): Promise<string> {
  const result = await pool.query<EntityAliasRow>(
    `
      select source_id, canonical_id, alias_complete, status
      from id_v2_global_aliases
      where user_id = $1
        and entity_type = $2
        and status = 'active'
        and alias_complete
        and (source_id = $3 or canonical_id = $3)
      limit 1
    `,
    [input.userId, input.entityType, input.sourceId],
  );
  const alias = result.rows[0];
  if (!alias) {
    throw new IdV2MigrationError('global_alias_missing', 'The global identity has no complete v2 alias.', {
      entityType: input.entityType,
      sourceId: input.sourceId,
    });
  }
  return alias.canonical_id;
}
