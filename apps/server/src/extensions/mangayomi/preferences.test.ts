import { expect, it } from 'vitest';
import { preferenceSchema, validatePreferenceChanges } from './preferences.js';
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
