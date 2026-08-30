import type { FastifyReply } from 'fastify';

export interface ContentReadRevisionRow {
  readonly active_content_revision_id?: unknown;
  readonly has_prior_purge?: unknown;
}

export type ContentReadRevisionConflict = 'content_revision_required' | 'content_revision_changed';

export function expectedContentReadRevision(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function contentReadRevisionConflict(
  row: ContentReadRevisionRow,
  expectedContentRevisionId: string | undefined,
): ContentReadRevisionConflict | undefined {
  if (!expectedContentRevisionId) return row.has_prior_purge ? 'content_revision_required' : undefined;
  return row.active_content_revision_id === expectedContentRevisionId ? undefined : 'content_revision_changed';
}

export function sendContentReadRevisionConflict(
  reply: FastifyReply,
  conflict: ContentReadRevisionConflict,
  row: ContentReadRevisionRow,
) {
  return reply.code(409).send({
    error:
      conflict === 'content_revision_required'
        ? 'book content revision is required'
        : 'book content revision changed',
    actualContentRevisionId:
      typeof row.active_content_revision_id === 'string' ? row.active_content_revision_id : undefined,
  });
}

export function canonicalContentReadRevision(row: ContentReadRevisionRow): string | undefined {
  return typeof row.active_content_revision_id === 'string' && row.active_content_revision_id
    ? row.active_content_revision_id
    : undefined;
}

export function withoutContentReadRevision<T extends ContentReadRevisionRow>(
  row: T,
): Omit<T, 'active_content_revision_id' | 'has_prior_purge'> {
  const { active_content_revision_id: _active, has_prior_purge: _prior, ...value } = row;
  return value;
}
