import { sha256 as sha256Digest } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();

export async function sha256(input: string | ArrayBuffer): Promise<string> {
  const data = typeof input === 'string' ? encoder.encode(input) : new Uint8Array(input);
  return bytesToHex(sha256Digest(data));
}

export function hashSync(input: string): string {
  return hashSyncRange(input, 0, input.length);
}

export function hashSyncRange(input: string, start = 0, end = input.length): string {
  let hash = 0x811c9dc5;
  for (let index = Math.max(0, start); index < Math.min(input.length, end); index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function stableId(prefix: string, seed: string, size = 12): string {
  return `${prefix}_${hashSync(seed).slice(0, size)}`;
}
