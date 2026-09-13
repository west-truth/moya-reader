export type SourcePreferenceValue = string | number | boolean;
export interface SourcePreferenceField {
  key: string;
  title: string;
  summary?: string;
  kind: 'text' | 'boolean' | 'select';
  secret: boolean;
  /** A URL entered by the owner grants access to that service origin. Defaults do not grant local access. */
  networkOrigin?: boolean;
  defaultValue?: SourcePreferenceValue;
  choices?: readonly { label: string; value: string | number }[];
}
export interface SourcePreferenceDefinition {
  sourceId: string;
  fields: readonly SourcePreferenceField[];
}
export type SourcePreferencesRequest =
  | { action: 'read' }
  | {
      action: 'save';
      revision: number;
      changes: Record<string, SourcePreferenceValue | null>;
      privateOrigins: readonly string[];
    };
export function validSourcePreferencesRequest(input: unknown): input is SourcePreferencesRequest {
  if (!input || typeof input !== 'object') return false;
  const row = input as SourcePreferencesRequest;
  if (row.action === 'read') return true;
  return (
    row.action === 'save' &&
    Number.isSafeInteger(row.revision) &&
    row.revision >= 0 &&
    !!row.changes &&
    typeof row.changes === 'object' &&
    !Array.isArray(row.changes) &&
    Object.keys(row.changes).length <= 64 &&
    Object.values(row.changes).every(
      (value) =>
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= 8192),
    ) &&
    Array.isArray(row.privateOrigins) &&
    row.privateOrigins.length <= 16 &&
    row.privateOrigins.every((origin) => {
      try {
        const url = new URL(origin);
        return (
          origin.length <= 256 &&
          ['http:', 'https:'].includes(url.protocol) &&
          url.origin === origin &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    })
  );
}
export function validSourcePreferenceDefinitions(
  input: unknown,
  sourceIds: readonly string[],
): input is readonly SourcePreferenceDefinition[] {
  if (
    !Array.isArray(input) ||
    input.length > sourceIds.length ||
    new Set(input.map((row) => row?.sourceId)).size !== input.length
  )
    return false;
  return input.every(
    (row) =>
      row &&
      Object.keys(row).every((key) => ['sourceId', 'fields'].includes(key)) &&
      sourceIds.includes(row.sourceId) &&
      Array.isArray(row.fields) &&
      row.fields.length <= 64 &&
      new Set(row.fields.map((field: SourcePreferenceField) => field?.key)).size === row.fields.length &&
      row.fields.every(
        (field: SourcePreferenceField) =>
          field &&
          Object.keys(field).every((key) =>
            ['key', 'title', 'summary', 'kind', 'secret', 'defaultValue', 'choices', 'networkOrigin'].includes(key),
          ) &&
          typeof field.key === 'string' &&
          /^[a-zA-Z0-9_.-]{1,100}$/.test(field.key) &&
          !['__proto__', 'prototype', 'constructor'].includes(field.key) &&
          (field.networkOrigin === undefined ||
            (field.networkOrigin === true && field.kind === 'text' && !field.secret)) &&
          typeof field.title === 'string' &&
          field.title.length > 0 &&
          field.title.length <= 200 &&
          (field.summary === undefined || (typeof field.summary === 'string' && field.summary.length <= 1000)) &&
          ['text', 'boolean', 'select'].includes(field.kind) &&
          typeof field.secret === 'boolean' &&
          (!field.secret || (field.kind === 'text' && field.defaultValue === undefined)) &&
          (field.kind !== 'select' ||
            (Array.isArray(field.choices) &&
              field.choices.length > 0 &&
              field.choices.length <= 64 &&
              field.choices.every(
                (choice) =>
                  typeof choice.label === 'string' &&
                  choice.label.length <= 200 &&
                  (typeof choice.value === 'string' ||
                    (typeof choice.value === 'number' && Number.isFinite(choice.value))),
              ))) &&
          (field.defaultValue === undefined || validSourcePreferenceValue(field, field.defaultValue)),
      ),
  );
}
export function validSourcePreferenceValue(
  field: SourcePreferenceField,
  value: unknown,
): value is SourcePreferenceValue {
  return field.kind === 'boolean'
    ? typeof value === 'boolean'
    : field.kind === 'select'
      ? !!field.choices?.some((choice) => choice.value === value)
      : typeof value === 'string' && value.length <= 8192;
}
