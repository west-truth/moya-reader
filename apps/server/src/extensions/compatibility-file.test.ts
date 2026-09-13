import { expect, it } from 'vitest';
import { compatibilityFile } from './compatibility-file';
import { validateSourceInput, validateSourceResult } from '../../../../packages/extension-contracts/source-protocol';

it('accepts bounded APK envelopes and rejects traversal, malformed data and oversized JS', () => {
  const bytes = Buffer.alloc(32 * 1024 * 1024, 1);
  expect(compatibilityFile({ name: 'source.apk', base64: bytes.toString('base64') }).bytes.length).toBe(bytes.length);
  for (const input of [
    { name: '../source.apk', base64: 'YQ==' },
    { name: 'source.js', base64: 'YW!j' },
    { name: 'source.js', base64: Buffer.alloc(1024 * 1024 + 1).toString('base64') },
  ])
    expect(() => compatibilityFile(input)).toThrow('compatibility_file_invalid');
});
it('validates source browse/filter boundaries without breaking old results', () => {
  expect(validateSourceResult('source.listWorks', { items: [] })).toBe(true);
  expect(
    validateSourceInput('source.listWorks', {
      sourceId: 'one',
      filters: [{ position: 0, value: { index: 1, ascending: true } }],
    }),
  ).toBe(true);
  expect(validateSourceInput('source.listWorks', { sourceId: 'one', filters: [{ position: -1, value: 'bad' }] })).toBe(
    false,
  );
  expect(
    validateSourceResult('source.listWorks', {
      items: [],
      browse: {
        activeMode: 'search',
        availableModes: ['search'],
        filters: [{ id: '0', position: 0, kind: 'select', label: 'Order', options: ['One'], defaultValue: 4 }],
      },
    }),
  ).toBe(false);
});
