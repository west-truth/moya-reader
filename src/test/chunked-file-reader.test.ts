import { describe, expect, it } from 'vitest';
import { readFileAsArrayBufferInChunks } from '../services/import/chunked-file-reader';

describe('readFileAsArrayBufferInChunks', () => {
  it('reads a file in bounded chunks and reports byte progress', async () => {
    const content = 'a'.repeat(150_000);
    const file = new File([content], 'sample.txt', { type: 'text/plain' });
    const progress: number[] = [];

    const buffer = await readFileAsArrayBufferInChunks(file, {
      chunkBytes: 64 * 1024,
      onProgress: (next) => progress.push(next.bytesRead),
    });

    expect(new TextDecoder().decode(buffer)).toBe(content);
    expect(progress).toEqual([65_536, 131_072, 150_000]);
  });

  it('aborts between chunks when cancellation is requested', async () => {
    const file = new File(['a'.repeat(150_000)], 'sample.txt', { type: 'text/plain' });
    const progress: number[] = [];
    let cancelled = false;

    await expect(
      readFileAsArrayBufferInChunks(file, {
        chunkBytes: 64 * 1024,
        shouldCancel: () => cancelled,
        onProgress: (next) => {
          progress.push(next.bytesRead);
          cancelled = true;
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(progress).toEqual([65_536]);
  });
});
