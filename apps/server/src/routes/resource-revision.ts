import type { QueryRunner } from './ai/sync-event-repository.js';

export class ServerResourceRevisionConflictError extends Error {
  constructor(
    public readonly resourceKind: string,
    public readonly expectedRevision: string,
    public readonly actualRevision: string,
  ) {
    super(`Resource ${resourceKind} changed after it was read.`);
    this.name = 'ServerResourceRevisionConflictError';
  }
}

export function expectedResourceRevision(body: Record<string, unknown> | undefined): string | undefined {
  const value = body?.expectedRevision;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function assertServerResourceRevision(
  resourceKind: string,
  expectedRevision: string,
  actualRevision: string,
): void {
  if (expectedRevision !== actualRevision) {
    throw new ServerResourceRevisionConflictError(resourceKind, expectedRevision, actualRevision);
  }
}

export async function lockBookResource(client: QueryRunner, userId: string, bookId: string): Promise<boolean> {
  const result = await client.query('select id from library_books where id = $1 and user_id = $2 for update', [
    bookId,
    userId,
  ]);
  return Boolean(result.rows[0]);
}
