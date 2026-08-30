import type pg from 'pg';

interface GenerationRow extends pg.QueryResultRow {
  generation: number | string;
}

interface BookTargetRow extends pg.QueryResultRow {
  active_content_revision_id: string | null;
  deleted_at: Date | string | null;
}

export interface BookGenerationTicket {
  readonly generation: number;
  readonly activeContentRevisionId?: string;
  readonly deleted: boolean;
}

export class BookGenerationChangedError extends Error {
  constructor(readonly reason: 'generation_changed' | 'content_revision_changed' | 'target_trashed' | 'target_exists') {
    super(reason === 'target_trashed' ? 'book_target_is_trashed' : `book_generation_changed:${reason}`);
    this.name = 'BookGenerationChangedError';
  }
}

type Queryable = Pick<pg.PoolClient, 'query'>;

async function ensureGenerationRow(queryable: Queryable, userId: string, bookId: string): Promise<void> {
  await queryable.query(
    `insert into book_id_generations (user_id, book_id, generation)
      values ($1, $2, 0)
      on conflict (user_id, book_id) do nothing`,
    [userId, bookId],
  );
}

async function readGeneration(queryable: Queryable, userId: string, bookId: string, forUpdate: boolean) {
  const result = await queryable.query<GenerationRow>(
    `select generation from book_id_generations
      where user_id = $1 and book_id = $2${forUpdate ? ' for update' : ''}`,
    [userId, bookId],
  );
  return result.rows[0] ? Number(result.rows[0].generation) : 0;
}

async function readBookTarget(queryable: Queryable, userId: string, bookId: string, forUpdate: boolean) {
  const result = await queryable.query<BookTargetRow>(
    `select active_content_revision_id, deleted_at from library_books
      where user_id = $1 and id = $2${forUpdate ? ' for update' : ''}`,
    [userId, bookId],
  );
  return result.rows[0];
}

export async function captureBookGenerationTicket(
  queryable: Queryable,
  userId: string,
  bookId: string,
): Promise<BookGenerationTicket> {
  await ensureGenerationRow(queryable, userId, bookId);
  const generation = await readGeneration(queryable, userId, bookId, true);
  const book = await readBookTarget(queryable, userId, bookId, true);
  if (book && generation === 0) throw new Error('book generation ledger is missing for an existing book');
  return {
    generation,
    ...(book?.active_content_revision_id ? { activeContentRevisionId: book.active_content_revision_id } : {}),
    deleted: Boolean(book?.deleted_at),
  };
}

export async function assertBookGenerationTicket(
  queryable: Queryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly expectedGeneration: number;
    readonly expectedActiveContentRevisionId?: string;
    readonly requireExisting: boolean;
    readonly forUpdate?: boolean;
  },
): Promise<void> {
  const generation = await readGeneration(queryable, input.userId, input.bookId, Boolean(input.forUpdate));
  if (generation !== input.expectedGeneration) throw new BookGenerationChangedError('generation_changed');

  const book = await readBookTarget(queryable, input.userId, input.bookId, Boolean(input.forUpdate));
  if (!input.requireExisting) {
    if (book) throw new BookGenerationChangedError(book.deleted_at ? 'target_trashed' : 'target_exists');
    return;
  }
  if (!book || book.deleted_at) throw new BookGenerationChangedError('target_trashed');
  if (
    input.expectedActiveContentRevisionId &&
    book.active_content_revision_id !== input.expectedActiveContentRevisionId
  ) {
    throw new BookGenerationChangedError('content_revision_changed');
  }
}

export async function assertCreateOnlyBookTarget(
  queryable: Queryable,
  userId: string,
  bookId: string,
  forUpdate = false,
): Promise<void> {
  if (forUpdate) {
    await ensureGenerationRow(queryable, userId, bookId);
    await readGeneration(queryable, userId, bookId, true);
  }
  const book = await readBookTarget(queryable, userId, bookId, forUpdate);
  if (book) throw new BookGenerationChangedError(book.deleted_at ? 'target_trashed' : 'target_exists');
}
