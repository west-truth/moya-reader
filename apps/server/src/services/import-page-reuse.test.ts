import type pg from 'pg';
import { describe, expect, test, vi } from 'vitest';
import type { ParsedNovelImportAsset } from '@noveldesk/contracts';
import { integrityHash } from '@noveldesk/text-core/hash';
import { loadImportPageReuse } from './import-page-reuse.js';

const bytes = new Uint8Array([1, 2, 3]);
const asset: ParsedNovelImportAsset = {
  id: 'new-id',
  bookId: 'book',
  kind: 'document_page',
  provenance: 'archive_embedded',
  fileName: 'new-name.png',
  contentHash: integrityHash(bytes),
  contentType: 'image/png',
  pageIndex: 10,
  bytes,
};
const row = { storage_key: 'old-key', content_hash: asset.contentHash, content_type: 'image/png', byte_length: '3' };

describe('append page reuse boundary', () => {
  test('requires owned active pages, matches bytes rather than page id/path, and caches HEAD per object', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [row] }));
    const inspect = vi.fn(async () => ({ byteLength: 3, contentType: 'image/png' }));
    const reuse = await loadImportPageReuse({ query } as unknown as pg.PoolClient, 'owner', 'book', inspect);
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining("kind = 'document_page' and status = 'active'"),
      ['owner', 'book'],
    ]);
    expect(query.mock.calls[0]?.[0]).toContain('user_id = $1 and book_id = $2');
    expect(await Promise.all([reuse(asset), reuse({ ...asset, id: 'another-id', pageIndex: 20 })])).toEqual([
      'old-key',
      'old-key',
    ]);
    expect(inspect).toHaveBeenCalledTimes(1);
    for (const changed of [
      { ...asset, kind: 'cover' as const },
      { ...asset, contentHash: integrityHash(new Uint8Array([3])) },
      { ...asset, bytes: new Uint8Array([1]) },
      { ...asset, contentType: 'image/jpeg' },
    ])
      expect(await reuse(changed)).toBeUndefined();
  });

  test.each([undefined, { byteLength: 2, contentType: 'image/png' }, { byteLength: 3, contentType: 'text/html' }])(
    'falls back to writing verified bytes when object metadata is %j',
    async (metadata) => {
      const client = { query: vi.fn(async () => ({ rows: [row] })) } as unknown as pg.PoolClient;
      const reuse = await loadImportPageReuse(client, 'owner', 'book', async () => metadata);
      expect(await reuse(asset)).toBeUndefined();
    },
  );

  test('does not turn an object-store outage into an implicit full re-upload', async () => {
    const client = { query: vi.fn(async () => ({ rows: [row] })) } as unknown as pg.PoolClient;
    const reuse = await loadImportPageReuse(client, 'owner', 'book', async () => {
      throw new Error('Unavailable');
    });
    await expect(reuse(asset)).rejects.toThrow('Unavailable');
  });
});
