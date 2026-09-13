import type { CompatibilityPreference } from '../../../../../src/extensions/packages/compatibility-preferences.js';
import type { PreferenceValues } from './runtime.js';
export function preferenceSchema(raw: unknown): CompatibilityPreference[] {
  if (!Array.isArray(raw) || raw.length > 128) throw new Error('compatibility_preferences_invalid');
  const keys = new Set<string>();
  return raw.flatMap((row) => {
    if (!row || typeof row.key !== 'string' || row.key.length > 256 || keys.has(row.key))
      throw new Error('compatibility_preferences_invalid');
    keys.add(row.key);
    const input = row.editTextPreference ?? row.switchPreferenceCompat ?? row.listPreference;
    if (!input) return [];
    if (typeof input.title !== 'string' || input.title.length > 512)
      throw new Error('compatibility_preferences_invalid');
    const kind = row.switchPreferenceCompat ? 'boolean' : row.listPreference ? 'select' : 'text';
    const choices =
      kind === 'select' && Array.isArray(input.entries) && Array.isArray(input.entryValues)
        ? input.entries
            .slice(0, 128)
            .map((label: unknown, i: number) => ({ label: String(label).slice(0, 512), value: input.entryValues[i] }))
        : undefined;
    if (choices?.some((choice: { value: unknown }) => !['string', 'number'].includes(typeof choice.value)))
      throw new Error('compatibility_preferences_invalid');
    const secret = /(?:secret|password|token|access.?key|api.?key|credential|접속.?키|비밀번호)/i.test(
      row.key + ' ' + input.title,
    );
    return [
      {
        key: row.key,
        title: input.title,
        summary: typeof input.summary === 'string' ? input.summary.slice(0, 2000) : undefined,
        kind,
        secret,
        ...(['string', 'boolean', 'number'].includes(typeof input.value) ? { value: input.value } : {}),
        ...(choices ? { choices } : {}),
      },
    ];
  });
}
export function validatePreferenceChanges(value: unknown): asserts value is PreferenceValues {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 256 ||
    Buffer.byteLength(JSON.stringify(value)) > 48 * 1024 ||
    Object.entries(value).some(
      ([key, v]) =>
        key.length > 256 ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) ||
        (typeof v === 'number' && !Number.isFinite(v)),
    )
  )
    throw new Error('compatibility_preferences_invalid');
}
