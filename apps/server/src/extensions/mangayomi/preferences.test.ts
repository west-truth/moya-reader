import { expect, it } from 'vitest';
import { preferenceSchema, validatePreferenceChanges, validatePreferenceState } from './preferences.js';
it('bounds catalog caches separately from user-editable form changes', () => {
  const state = { status: 'x'.repeat(91031), mapping: 'y'.repeat(1200 * 1024) };
  expect(() => validatePreferenceState(state)).not.toThrow();
  expect(() => validatePreferenceChanges(state)).toThrow('compatibility_preferences_invalid');
  expect(() => validatePreferenceState({ cache: 'x'.repeat(2 * 1024 * 1024) })).toThrow('source_storage_limit');
  expect(() => validatePreferenceState(JSON.parse('{"__proto__":"value"}'))).toThrow(
    'compatibility_preferences_invalid',
  );
});
it('keeps original multi selections and resolves single choice indexes', () => {
  expect(
    preferenceSchema([
      {
        key: 'languages',
        multiSelectListPreference: {
          title: 'Languages',
          entries: ['Korean', 'English'],
          entryValues: ['ko', 'en'],
          values: ['ko'],
        },
      },
      {
        key: 'quality',
        listPreference: { title: 'Quality', entries: ['Full', 'Small'], entryValues: ['full', 'small'], valueIndex: 1 },
      },
    ]),
  ).toMatchObject([
    { kind: 'multi-select', value: ['ko'] },
    { kind: 'select', value: 'small' },
  ]);
  expect(() => validatePreferenceChanges({ languages: [] })).not.toThrow();
  for (const value of [['ko', 'ko'], [3], [{}], Array(129).fill('a')])
    expect(() => validatePreferenceChanges({ languages: value })).toThrow('compatibility_preferences_invalid');
  expect(() =>
    preferenceSchema([
      {
        key: 'languages',
        multiSelectListPreference: { title: 'Languages', entries: ['Korean'], entryValues: ['ko'], values: ['bad'] },
      },
    ]),
  ).toThrow('compatibility_preferences_invalid');
});
