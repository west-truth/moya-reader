import {
  integrityHash,
  integrityHashVersion,
  matchesIntegrityHash,
  tagLegacySha256Hash,
} from '@noveldesk/text-core/hash';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { IdV2MigrationError } from './contracts.js';

export function verifiedCanonicalHash(
  storedHash: string,
  expected: string | Uint8Array | ArrayBuffer,
  label: string,
): string {
  if (!matchesIntegrityHash(storedHash, expected)) {
    throw new IdV2MigrationError('source_hash_mismatch', `${label} does not match its stored hash.`, {
      entityType: label,
    });
  }
  return integrityHash(expected);
}

export function canonicalOpaqueHash(storedHash: string, fallbackSource: unknown, label: string): string {
  const version = integrityHashVersion(storedHash);
  if (version === 'v2-sha256-tagged') return storedHash;
  if (version === 'v1-sha256') return tagLegacySha256Hash(storedHash);
  if (version === 'v1-fnv32') return structuredIntegrityHash(fallbackSource);
  throw new IdV2MigrationError('source_hash_unknown', `${label} uses an unknown hash format.`, {
    entityType: label,
  });
}
