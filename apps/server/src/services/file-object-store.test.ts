import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { FileObjectStore } from './file-object-store.js';
import {
  copyStoredObject,
  createS3Client,
  deleteObject,
  ensureBucket,
  getObjectBuffer,
  getObjectRangeBuffer,
  inspectStoredObject,
  putRawBookObject,
} from './object-storage.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'moya-file-store-'));
  roots.push(root);
  const config = loadConfig({ OBJECT_STORAGE_DIR: path.join(root, 'objects'), STORAGE_MIN_FREE_BYTES: '0' });
  return { root, config, client: createS3Client(config) };
}

it('uses the server API for persistent bytes, metadata, ranges, copy and deletion without S3', async () => {
  const { config, client } = await fixture();
  expect(client).toBeInstanceOf(FileObjectStore);
  const key = '../CON/한글.txt';
  await ensureBucket(client, config.s3.bucket);
  await putRawBookObject(client, config, key, new Blob(['abcdef']), 'text/plain;charset=utf-8');
  const reopened = createS3Client(config);
  expect(await inspectStoredObject(reopened, config, key)).toEqual({
    byteLength: 6,
    contentType: 'text/plain;charset=utf-8',
  });
  expect((await getObjectRangeBuffer(reopened, config, key, 2, 99)).body.toString()).toBe('cdef');
  await expect(getObjectRangeBuffer(reopened, config, key, 6, 7)).rejects.toMatchObject({
    $metadata: { httpStatusCode: 416 },
  });
  await copyStoredObject(reopened, config, key, 'copy');
  await deleteObject(reopened, config, key);
  expect(await inspectStoredObject(reopened, config, key)).toBeUndefined();
  expect((await getObjectBuffer(reopened, config, 'copy')).body.toString()).toBe('abcdef');
  await putRawBookObject(reopened, config, 'copy', Buffer.alloc(0), 'application/empty');
  expect(await getObjectBuffer(reopened, config, 'copy')).toMatchObject({
    body: Buffer.alloc(0),
    contentType: 'application/empty',
    contentLength: 0,
  });
  await deleteObject(reopened, config, 'missing');
});

it('aborted writes preserve the published object and remove partial files', async () => {
  const { config, client } = await fixture();
  await putRawBookObject(client, config, 'book', Buffer.from('original'), 'text/plain');
  const controller = new AbortController();
  const blob = new Blob([new Uint8Array(1024 * 1024)]);
  // Abort after an actual chunk has entered the writer.
  blob.stream = () =>
    new ReadableStream({
      start(stream) {
        stream.enqueue(new Uint8Array(128));
      },
      pull() {
        controller.abort();
      },
    });
  await expect(putRawBookObject(client, config, 'book', blob, 'text/new', controller.signal)).rejects.toThrow();
  expect((await getObjectBuffer(client, config, 'book')).body.toString()).toBe('original');
  expect(
    (await readdir(config.objectStorageDir!, { recursive: true })).filter((name) => name.endsWith('.tmp')),
  ).toEqual([]);
});

it('keeps bucket namespaces separate and preserves the old S3 default', async () => {
  const { config, client } = await fixture();
  await putRawBookObject(client, config, 'key', Buffer.from('one'), 'text/plain');
  const other = { ...config, s3: { ...config.s3, bucket: 'other' } };
  await putRawBookObject(client, other, 'key', Buffer.from('two'), 'text/plain');
  expect((await getObjectBuffer(client, config, 'key')).body.toString()).toBe('one');
  expect((await getObjectBuffer(client, other, 'key')).body.toString()).toBe('two');
  const s3 = createS3Client(loadConfig({}));
  expect(s3).not.toBeInstanceOf(FileObjectStore);
  s3.destroy();
});
