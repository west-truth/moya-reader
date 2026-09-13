import { describe, expect, it } from 'vitest';
import { validateSourceInput, validateSourceResult } from './source-protocol';

describe('untrusted source RPC values', () => {
  it('preserves opaque cursors, stable order and fractional chapter numbers', () => {
    expect(
      validateSourceInput('source.listWorks', { sourceId: 'org.example.source', query: '', cursor: 'next/=%' }),
    ).toBe(true);
    expect(
      validateSourceResult('source.listReleases', {
        items: [{ id: 'special', title: 'Extra', order: -1, number: 0.5 }],
        nextCursor: 'next/=%',
      }),
    ).toBe(true);
  });
  it('rejects malformed IDs, duplicate releases, infinite order and oversized metadata', () => {
    expect(validateSourceInput('source.getContent', { sourceId: 'source', workId: 'work' })).toBe(false);
    const release = { id: 'one', title: 'One', order: 1 };
    expect(validateSourceResult('source.listReleases', { items: [release, release] })).toBe(false);
    expect(validateSourceResult('source.listReleases', { items: [{ ...release, order: Infinity }] })).toBe(false);
    expect(validateSourceResult('source.getWork', { id: 'work', title: 'Work', description: 'x'.repeat(64001) })).toBe(
      false,
    );
  });
  it('accepts only bounded host asset references, with distinct image pages', () => {
    const asset = { handle: 'opaque', byteLength: 68, sha256: '0'.repeat(64), contentType: 'image/png' };
    expect(validateSourceResult('source.getContent', { kind: 'images', assets: [asset] })).toBe(true);
    expect(validateSourceResult('source.getContent', { kind: 'images', assets: [asset, asset] })).toBe(false);
    expect(validateSourceResult('source.getContent', { kind: 'text', asset: { ...asset, byteLength: 0 } })).toBe(false);
    expect(validateSourceResult('source.getContent', { kind: 'text', text: 'inline instead of host asset' })).toBe(
      false,
    );
  });
});
