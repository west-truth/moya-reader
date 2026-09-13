import { describe, expect, it, vi } from 'vitest';
import { PreparedImageDownloads } from './prepared-image-downloads.js';

describe('server-owned image download receipts', () => {
  it('bounds retained bytes, binds source/release and consumes only once', async () => {
    const store = new PreparedImageDownloads(8);
    const file = new File(['image'], '1.cbz');
    try {
      const receipt = await store.put('source', 'release', file, new AbortController().signal);
      expect(receipt.sourceContentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(receipt).not.toHaveProperty('file');
      await expect(store.put('source', 'two', file, new AbortController().signal)).rejects.toThrow(
        'source_storage_limit',
      );
      await expect(store.consume(receipt.artifactId, 'other', 'release', async () => 1)).rejects.toThrow('unavailable');
      await expect(store.consume(receipt.artifactId, 'source', 'other', async () => 1)).rejects.toThrow('unavailable');
      expect(await store.consume(receipt.artifactId, 'source', 'release', async (actual) => actual.text())).toBe(
        'image',
      );
      await expect(store.consume(receipt.artifactId, 'source', 'release', async () => 1)).rejects.toThrow(
        'unavailable',
      );
      await expect(store.put('source', 'two', file, new AbortController().signal)).resolves.toHaveProperty(
        'artifactId',
      );
    } finally {
      store.close();
    }
  });
  it('expires abandoned downloads and frees failed or cancelled reservations', async () => {
    const store = new PreparedImageDownloads(8, 10);
    try {
      const receipt = await store.put('s', 'r', new File(['image'], '1.cbz'), new AbortController().signal);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);
      await expect(store.consume(receipt.artifactId, 's', 'r', async () => 1)).rejects.toThrow('unavailable');
      const abort = new AbortController();
      abort.abort();
      await expect(store.put('s', 'r', new File(['image'], '1.cbz'), abort.signal)).rejects.toThrow();
      await expect(
        store.put('s', 'r', new File(['image'], '1.cbz'), new AbortController().signal),
      ).resolves.toHaveProperty('artifactId');
    } finally {
      vi.restoreAllMocks();
      store.close();
    }
  });
});
