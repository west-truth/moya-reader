import { ZipWriter } from '@zip.js/zip.js';
import { Readable } from 'node:stream';
import type { OriginalFileEntry } from '@noveldesk/contracts';
import { verifiedBackupStream } from './backup-streams.js';

export function originalZipStream(
  files: readonly OriginalFileEntry[],
  load: (file: OriginalFileEntry) => Promise<Readable>,
  signal: AbortSignal,
) {
  let controller: TransformStreamDefaultController<Uint8Array>;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const completion = (async () => {
    const zip = new ZipWriter(stream.writable, {
      zip64: true,
      level: 0,
      bufferedWrite: false,
      useWebWorkers: false,
      signal,
    });
    try {
      for (const [index, file] of files.entries()) {
        signal.throwIfAborted();
        const body = await load(file);
        const stop = () => body.destroy(new Error('Download cancelled'));
        signal.addEventListener('abort', stop, { once: true });
        try {
          signal.throwIfAborted();
          const name = Array.from(file.fileName.replace(/.*[\\/]/u, ''))
            .filter((c) => c.charCodeAt(0) >= 32)
            .join('');
          await zip.add(
            `${String(index + 1).padStart(4, '0')}/${name || 'original'}`,
            verifiedBackupStream(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
              byteLength: file.byteLength,
              contentHash: file.contentHash.startsWith('sha256:') ? file.contentHash : `sha256:${file.contentHash}`,
            }),
          );
        } finally {
          signal.removeEventListener('abort', stop);
          body.destroy();
        }
      }
      await zip.close();
    } catch (error) {
      controller!.error(error);
      throw error;
    }
  })();
  return { readable: stream.readable, completion };
}
