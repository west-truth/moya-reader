import { canonicalJson } from '../canonical-json';
import { integrityHash, matchesIntegrityHash } from '../id-hash-contract';

export function structuredIntegrityHash(value: unknown): string {
  return integrityHash(canonicalJson(value));
}

export function textIntegrityHash(text: string): string {
  return integrityHash(text);
}

export function matchesStructuredIntegrityHash(
  value: string,
  expected: unknown,
  legacyPrefixes: readonly string[] = [],
): boolean {
  const candidates = [
    value,
    ...legacyPrefixes.filter((prefix) => value.startsWith(prefix)).map((prefix) => value.slice(prefix.length)),
  ];
  const canonical = canonicalJson(expected);
  return candidates.some((candidate) => matchesIntegrityHash(candidate, canonical));
}
