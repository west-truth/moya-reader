import { describe, expect, it } from 'vitest';
import { hashSync } from '../domain/hash';
import {
  integrityHash,
  integrityHashVersion,
  isIntegrityHash,
  matchesIntegrityHash,
  persistentId128,
  persistentIdVersion,
  tagLegacySha256Hash,
} from '../domain/id-hash-contract';

describe('persistent ID and integrity hash contract', () => {
  it('builds stable domain-separated 128-bit IDs', () => {
    const first = persistentId128('chapter', ['book_1', '7', '제7화']);
    const second = persistentId128('chapter', ['book_1', '7', '제7화']);

    expect(first).toBe(second);
    expect(first).toMatch(/^chapter_[0-9a-f]{32}$/);
    expect(persistentIdVersion(first)).toBe('v2-sha256-128');
    expect(persistentId128('paragraph', ['book_1', '7', '제7화'])).not.toBe(first);
  });

  it('length-prefixes tuple fields so concatenation cannot alias identities', () => {
    expect(persistentId128('entity', ['ab', 'c'])).not.toBe(persistentId128('entity', ['a', 'bc']));
    expect(persistentId128('entity', ['', 'abc'])).not.toBe(persistentId128('entity', ['abc', '']));
  });

  it('does not reproduce a known FNV-1a collision', () => {
    expect(hashSync('costarring')).toBe(hashSync('liquid'));
    expect(persistentId128('fixture', ['costarring'])).not.toBe(persistentId128('fixture', ['liquid']));
  });

  it('uses a full tagged SHA-256 digest for content integrity', () => {
    const digest = integrityHash('abc');

    expect(digest).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(isIntegrityHash(digest)).toBe(true);
    expect(isIntegrityHash(digest.slice(7, -1))).toBe(false);
  });

  it('validates tagged and legacy integrity hashes during migration', () => {
    const tagged = integrityHash('abc');
    const legacySha256 = tagged.slice('sha256:'.length);
    const legacyFnv = hashSync('abc');

    expect(integrityHashVersion(tagged)).toBe('v2-sha256-tagged');
    expect(integrityHashVersion(legacySha256)).toBe('v1-sha256');
    expect(integrityHashVersion(legacyFnv)).toBe('v1-fnv32');
    expect(tagLegacySha256Hash(legacySha256)).toBe(tagged);
    expect(tagLegacySha256Hash(legacyFnv)).toBe(legacyFnv);
    expect(matchesIntegrityHash(tagged, 'abc')).toBe(true);
    expect(matchesIntegrityHash(legacySha256, 'abc')).toBe(true);
    expect(matchesIntegrityHash(legacyFnv, 'abc')).toBe(true);
    expect(matchesIntegrityHash(legacyFnv, 'different')).toBe(false);
    expect(matchesIntegrityHash('not-a-hash', 'abc')).toBe(false);
  });

  it('recognizes legacy FNV IDs without treating arbitrary values as IDs', () => {
    expect(persistentIdVersion('chapter_5e4daa9d')).toBe('v1-fnv32');
    expect(persistentIdVersion('chapter_5e4daa9d-extra')).toBe('unknown');
    expect(persistentIdVersion('not an id')).toBe('unknown');
  });

  it('rejects ambiguous namespaces and empty identity tuples', () => {
    expect(() => persistentId128('Chapter', ['1'])).toThrow(/namespace/);
    expect(() => persistentId128('chapter', [])).toThrow(/identity field/);
  });
});
