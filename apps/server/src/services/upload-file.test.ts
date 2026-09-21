import * as fs from 'node:fs/promises';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { assembleUploadFile, assertUploadDiskSpace, UploadSpaceError } from './upload-file.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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

it('reports bounded assembly progress and cleans its file when the progress sink cancels', async () => {
  const f = await fixture();
  const updates: number[] = [];
  const file = await assembleUploadFile({
    ...f,
    expectedBytes: f.bytes.length,
    onProgress: async (bytes, total) => {
      expect(total).toBe(f.bytes.length);
      updates.push(bytes);
    },
  });
  expect(updates.length).toBeGreaterThanOrEqual(2);
  expect(updates[0]).toBeGreaterThan(0);
  expect(updates[0]).toBeLessThan(f.bytes.length);
  expect(updates.at(-1)).toBe(f.bytes.length);
  expect(updates).toEqual([...new Set(updates)].sort((a, b) => a - b));
  await file.dispose();
  await expect(
    assembleUploadFile({
      ...f,
      expectedBytes: f.bytes.length,
      onProgress: async () => {
        throw new Error('cancelled');
      },
    }),
  ).rejects.toThrow('cancelled');
  expect(await readdir(f.directory)).toEqual(['chunk']);
});

it('checks available space including headroom before creating an assembly', async () => {
  const f = await fixture();
  const required = BigInt(f.bytes.length) + 64n * 1024n * 1024n;
  const stat = await fs.statfs(f.directory, { bigint: true });
  const check = vi.mocked(fs.statfs).mockResolvedValueOnce({ ...stat, bsize: 1n, bavail: required - 1n });
  await expect(assembleUploadFile({ ...f, expectedBytes: f.bytes.length })).rejects.toBeInstanceOf(UploadSpaceError);
  expect(await readdir(f.directory)).toEqual(['chunk']);
  check.mockResolvedValueOnce({ ...stat, bsize: 1n, bavail: required });
  await expect(assertUploadDiskSpace(f.directory, f.bytes.length)).resolves.toBeUndefined();
});
