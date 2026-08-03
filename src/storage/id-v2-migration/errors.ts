import type { IdV2EntityType } from './contracts';

export class IdV2MigrationValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly entityType: IdV2EntityType | 'book' = 'book',
    readonly entityId?: string,
  ) {
    super(message);
    this.name = 'IdV2MigrationValidationError';
  }
}

export function migrationAbortError(): DOMException {
  return new DOMException('ID v2 migration cancelled', 'AbortError');
}

export function throwIfMigrationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw migrationAbortError();
}
