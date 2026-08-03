import { sha256 as sha256Digest } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();
const DEFAULT_CHUNK_CHARACTERS = 256 * 1024;

export interface CooperativeTextHashOptions {
  chunkCharacters?: number;
  checkpoint?: () => Promise<void>;
}

function safeChunkEnd(text: string, start: number, requestedEnd: number, rangeEnd: number): number {
  let chunkEnd = Math.min(requestedEnd, rangeEnd);
  if (chunkEnd <= start || chunkEnd >= rangeEnd) return chunkEnd;
  const previous = text.charCodeAt(chunkEnd - 1);
  const next = text.charCodeAt(chunkEnd);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    chunkEnd += chunkEnd - start === 1 ? 1 : -1;
  }
  return chunkEnd;
}

export async function hashTextRangeCooperatively(
  text: string,
  start = 0,
  end = text.length,
  options: CooperativeTextHashOptions = {},
): Promise<string> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length) {
    throw new RangeError('Invalid text hash range.');
  }
  const chunkCharacters = Math.max(1, Math.floor(options.chunkCharacters ?? DEFAULT_CHUNK_CHARACTERS));
  const digest = sha256Digest.create();
  let offset = start;
  while (offset < end) {
    const next = safeChunkEnd(text, offset, offset + chunkCharacters, end);
    digest.update(encoder.encode(text.slice(offset, next)));
    offset = next;
    if (offset < end) await options.checkpoint?.();
  }
  return `sha256:${bytesToHex(digest.digest())}`;
}
