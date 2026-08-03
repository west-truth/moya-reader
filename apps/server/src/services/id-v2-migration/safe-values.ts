import { IdV2MigrationError } from './contracts.js';

export type JsonRecord = Record<string, unknown>;

export function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdV2MigrationError('migration_row_invalid', `${label} is malformed.`);
  }
  return value as JsonRecord;
}

export function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IdV2MigrationError('migration_row_invalid', `${label} is missing.`);
  }
  return value;
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function integerValue(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new IdV2MigrationError('migration_row_invalid', `${label} is not an integer.`);
  }
  return parsed;
}

export function isoValue(value: unknown, label: string): string {
  const text = textValue(value, label);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new IdV2MigrationError('migration_row_invalid', `${label} is not a timestamp.`);
  }
  return parsed.toISOString();
}

export function safeErrorCode(error: unknown): string {
  return error instanceof IdV2MigrationError ? error.code : 'id_v2_migration_failed';
}

export function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof IdV2MigrationError)) return {};
  const allowed = ['entityType', 'sourceId', 'stage', 'expectedCount', 'actualCount', 'activeWork'];
  return Object.fromEntries(Object.entries(error.details).filter(([key]) => allowed.includes(key)));
}
