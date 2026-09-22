import { createHash } from 'node:crypto';

/** Limits the actual bytes, not only the ZIP directory's claimed size. */
export function verifiedBackupStream(
  source: ReadableStream<Uint8Array>,
  expected: { byteLength: number; contentHash: string },
): ReadableStream<Uint8Array> {
  let bytes = 0;
  const hash = createHash('sha256');
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > expected.byteLength) throw new Error('Backup entry exceeds its declared size');
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (bytes !== expected.byteLength || `sha256:${hash.digest('hex')}` !== expected.contentHash)
          throw new Error('Backup entry integrity check failed');
      },
    }),
  );
}

export async function hashBackupBlob(blob: Blob, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value);
    }
    return `sha256:${hash.digest('hex')}`;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
