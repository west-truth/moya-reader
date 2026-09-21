import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

interface UploadChunkFile {
  readonly storage_path: string;
  readonly size_bytes: number;
  readonly chunk_index: number;
}

/** The directory belongs to this execution only; retries never remove another attempt's files. */
export async function assembleUploadFile(input: {
  directory: string;
  expectedBytes: number;
  chunks: readonly UploadChunkFile[];
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  await mkdir(input.directory, { recursive: true });
  const space = await statfs(input.directory, { bigint: true });
  if (space.bavail * space.bsize < BigInt(input.expectedBytes) + 64n * 1024n * 1024n) {
    throw new Error('가져오기를 위한 임시 저장공간이 부족합니다.');
  }
  const directory = await mkdtemp(path.join(input.directory, 'assembly-'));
  const filePath = path.join(directory, 'source');
  const dispose = () => rm(directory, { recursive: true, force: true });
  const hash = createHash('sha256');
  let size = 0;
  async function* chunks() {
    for (const chunk of input.chunks) {
      input.signal?.throwIfAborted();
      let read = 0;
      for await (const bytes of createReadStream(chunk.storage_path, { signal: input.signal })) {
        read += bytes.length;
        size += bytes.length;
        if (read > Number(chunk.size_bytes) || size > input.expectedBytes)
          throw new Error('Upload chunk size mismatch');
        hash.update(bytes);
        yield bytes;
      }
      if (read !== Number(chunk.size_bytes)) throw new Error(`Upload chunk ${chunk.chunk_index} size mismatch`);
    }
    if (size !== input.expectedBytes) throw new Error('Upload size mismatch');
  }
  try {
    await pipeline(chunks(), createWriteStream(filePath, { flags: 'wx' }), { signal: input.signal });
    return { blob: await openAsBlob(filePath), contentHash: `sha256:${hash.digest('hex')}`, dispose };
  } catch (error) {
    await dispose();
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC')
      throw new Error('가져오기 중 임시 저장공간이 부족해졌습니다.', { cause: error });
    throw error;
  }
}
