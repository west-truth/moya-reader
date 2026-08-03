import { sha256 as sha256Digest } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface ChunkedFileReadProgress {
  bytesRead: number;
  totalBytes: number;
}

export interface ChunkedFileReadOptions {
  chunkBytes?: number;
  shouldCancel?: () => boolean;
  onProgress?: (progress: ChunkedFileReadProgress) => void;
}

export const DEFAULT_FILE_READ_CHUNK_BYTES = 2 * 1024 * 1024;
const MIN_FILE_READ_CHUNK_BYTES = 64 * 1024;

function importAbortError(): Error {
  return new DOMException('Import cancelled', 'AbortError') as Error;
}

function throwIfCancelled(options: ChunkedFileReadOptions): void {
  if (options.shouldCancel?.()) throw importAbortError();
}

function normalizeChunkBytes(value: number | undefined): number {
  const parsed = Math.floor(value ?? DEFAULT_FILE_READ_CHUNK_BYTES);
  return Number.isFinite(parsed) ? Math.max(MIN_FILE_READ_CHUNK_BYTES, parsed) : DEFAULT_FILE_READ_CHUNK_BYTES;
}

export async function readFileAsArrayBufferInChunks(
  file: File,
  options: ChunkedFileReadOptions = {},
): Promise<ArrayBuffer> {
  const chunkBytes = normalizeChunkBytes(options.chunkBytes);
  const totalBytes = file.size;
  const output = new Uint8Array(totalBytes);
  let bytesRead = 0;

  while (bytesRead < totalBytes) {
    throwIfCancelled(options);
    const end = Math.min(bytesRead + chunkBytes, totalBytes);
    const chunk = new Uint8Array(await file.slice(bytesRead, end).arrayBuffer());
    throwIfCancelled(options);
    output.set(chunk, bytesRead);
    bytesRead = end;
    options.onProgress?.({ bytesRead, totalBytes });
  }

  throwIfCancelled(options);
  return output.buffer;
}

export async function hashBlobInChunks(blob: Blob, options: ChunkedFileReadOptions = {}): Promise<string> {
  const chunkBytes = normalizeChunkBytes(options.chunkBytes);
  const digest = sha256Digest.create();
  let bytesRead = 0;
  while (bytesRead < blob.size) {
    throwIfCancelled(options);
    const end = Math.min(bytesRead + chunkBytes, blob.size);
    digest.update(new Uint8Array(await blob.slice(bytesRead, end).arrayBuffer()));
    throwIfCancelled(options);
    bytesRead = end;
    options.onProgress?.({ bytesRead, totalBytes: blob.size });
  }
  throwIfCancelled(options);
  return `sha256:${bytesToHex(digest.digest())}`;
}
