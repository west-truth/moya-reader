import { sha256 as sha256Digest } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';
import { hashSync } from './legacy-hash';

const encoder = new TextEncoder();
const ID_CONTRACT_TAG = encoder.encode('noveldesk:persistent-id:v2');
const INTEGRITY_PREFIX = 'sha256:';
const ID_NAMESPACE_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

export type PersistentIdVersion = 'v1-fnv32' | 'v2-sha256-128' | 'unknown';
export type IntegrityHashVersion = 'v1-fnv32' | 'v1-sha256' | 'v2-sha256-tagged' | 'unknown';

function uint32Bytes(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`Tuple field length is outside uint32: ${value}`);
  }
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

function lengthPrefixed(value: Uint8Array): Uint8Array {
  return concatBytes(uint32Bytes(value.byteLength), value);
}

function idDigest(namespace: string, parts: readonly string[]): Uint8Array {
  if (!ID_NAMESPACE_PATTERN.test(namespace)) {
    throw new TypeError(`Invalid persistent ID namespace: ${namespace}`);
  }
  if (parts.length === 0) {
    throw new TypeError('A persistent ID requires at least one identity field.');
  }

  const fields = [ID_CONTRACT_TAG, encoder.encode(namespace), ...parts.map((part) => encoder.encode(part))];
  const tuple = concatBytes(uint32Bytes(fields.length), ...fields.map(lengthPrefixed));
  return sha256Digest(tuple);
}

function bytes(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}

/**
 * Builds a deterministic 128-bit persistent ID from an unambiguous, domain-separated tuple.
 * The namespace is also the readable ID prefix and must describe the entity kind.
 */
export function persistentId128(namespace: string, parts: readonly string[]): string {
  return `${namespace}_${bytesToHex(idDigest(namespace, parts).subarray(0, 16))}`;
}

/** Returns a full SHA-256 integrity value. This is not an entity identifier. */
export function integrityHash(value: string | Uint8Array | ArrayBuffer): string {
  return `${INTEGRITY_PREFIX}${bytesToHex(sha256Digest(bytes(value)))}`;
}

export function persistentIdVersion(value: string): PersistentIdVersion {
  const separator = value.lastIndexOf('_');
  if (separator <= 0) return 'unknown';
  const namespace = value.slice(0, separator);
  const digest = value.slice(separator + 1);
  if (!ID_NAMESPACE_PATTERN.test(namespace)) return 'unknown';
  if (/^[0-9a-f]{32}$/.test(digest)) return 'v2-sha256-128';
  if (/^[0-9a-f]{8}$/.test(digest)) return 'v1-fnv32';
  return 'unknown';
}

export function isIntegrityHash(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

export function integrityHashVersion(value: string): IntegrityHashVersion {
  if (isIntegrityHash(value)) return 'v2-sha256-tagged';
  if (/^[0-9a-f]{64}$/.test(value)) return 'v1-sha256';
  if (/^[0-9a-f]{8}$/.test(value)) return 'v1-fnv32';
  return 'unknown';
}

/** Tags an existing SHA-256 digest without pretending a legacy FNV value was upgraded. */
export function tagLegacySha256Hash(value: string): string {
  return integrityHashVersion(value) === 'v1-sha256' ? `${INTEGRITY_PREFIX}${value}` : value;
}

/** Verifies both current hashes and hashes that can still exist before the IDB v13 migration. */
export function matchesIntegrityHash(value: string, expected: string | Uint8Array | ArrayBuffer): boolean {
  const version = integrityHashVersion(value);
  if (version === 'v2-sha256-tagged') return value === integrityHash(expected);
  if (version === 'v1-sha256') return value === integrityHash(expected).slice(INTEGRITY_PREFIX.length);
  return version === 'v1-fnv32' && typeof expected === 'string' && value === hashSync(expected);
}
