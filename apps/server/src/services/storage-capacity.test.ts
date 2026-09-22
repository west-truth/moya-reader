import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStorageCapacity, assertObjectStorageSpace, storageCapacityPath } from './storage-capacity.js';
import { loadConfig } from '../config.js';

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()), statfs: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const config = () => loadConfig({ S3_ENDPOINT: 'http://minio:9000', STORAGE_MIN_FREE_BYTES: '100' });
function disk() {
  vi.mocked(fs.statfs).mockResolvedValue({ bsize: 1n, blocks: 10000n, bfree: 2000n, bavail: 1000n } as never);
}

describe('object store filesystem capacity', () => {
  it('uses available blocks rather than OS-reserved free blocks and checks a safety margin', async () => {
    disk();
    expect(await readStorageCapacity(config())).toEqual({
      status: 'available',
      totalBytes: 10000,
      availableBytes: 1000,
      minimumFreeBytes: 100,
    });
    await expect(assertObjectStorageSpace(config(), 900)).resolves.toBeUndefined();
    await expect(assertObjectStorageSpace(config(), 901)).rejects.toMatchObject({ statusCode: 507 });
  });
  it('does not report local free disk as remote S3 capacity, unless explicitly configured', async () => {
    const remote = loadConfig({ S3_ENDPOINT: 'https://s3.example.com' });
    expect(storageCapacityPath(remote)).toBeUndefined();
    expect(await readStorageCapacity(remote)).toEqual({ status: 'unavailable', reason: 'not_configured' });
    await assertObjectStorageSpace(remote, 100);
    expect(fs.statfs).not.toHaveBeenCalled();
    expect(storageCapacityPath(loadConfig({ STORAGE_CAPACITY_PATH: '/mnt/storage' }))).toBe('/mnt/storage');
    expect(
      storageCapacityPath(loadConfig({ S3_ENDPOINT: 'http://minio:9000', STORAGE_CAPACITY_PATH: '' })),
    ).toBeUndefined();
  });
  it('keeps a failed capacity check unavailable and rejects writes to an unverified mounted store', async () => {
    vi.mocked(fs.statfs).mockRejectedValue(new Error('mount missing'));
    expect(await readStorageCapacity(config())).toEqual({ status: 'unavailable', reason: 'read_failed' });
    await expect(assertObjectStorageSpace(config(), 1)).rejects.toMatchObject({ statusCode: 507 });
    expect(() => loadConfig({ STORAGE_MIN_FREE_BYTES: '-1' })).toThrow();
  });
});
