import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { assembleUploadFile } from './upload-file.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moya-upload-file-'));
  directories.push(directory);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 37);
  const chunk = path.join(directory, 'chunk');
  await writeFile(chunk, bytes);
  return { directory, bytes, chunks: [{ storage_path: chunk, size_bytes: bytes.length, chunk_index: 0 }] };
}
it('assembles and hashes a file with readable slices, isolating concurrent attempts', async () => {
  const f = await fixture();
  const first = await assembleUploadFile({ ...f, expectedBytes: f.bytes.length });
  const second = await assembleUploadFile({ ...f, expectedBytes: f.bytes.length });
  expect(first.contentHash).toBe(`sha256:${createHash('sha256').update(f.bytes).digest('hex')}`);
  expect(Buffer.from(await first.blob.slice(1024, 2048).arrayBuffer())).toEqual(f.bytes.subarray(1024, 2048));
  await first.dispose();
  expect((await second.blob.slice(0, 10).arrayBuffer()).byteLength).toBe(10);
  await second.dispose();
  expect(await readdir(f.directory)).toEqual(['chunk']);
});
it('removes partial assembly on mismatch and cancellation while preserving chunks', async () => {
  const f = await fixture();
  await expect(assembleUploadFile({ ...f, expectedBytes: f.bytes.length - 1 })).rejects.toThrow('size mismatch');
  const controller = new AbortController();
  const pending = assembleUploadFile({ ...f, expectedBytes: f.bytes.length, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(await readdir(f.directory)).toEqual(['chunk']);
});
