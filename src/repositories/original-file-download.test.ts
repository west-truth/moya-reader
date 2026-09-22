import { afterEach, expect, it, vi } from 'vitest';
import { RemoteApiClient } from '../services/remote/remote-api-client';
import { RemoteBookAssetRepository } from './remote-book-asset-repository';

afterEach(() => vi.unstubAllGlobals());

it('uses authenticated metadata/ticket requests and never embeds the account token in the download URL', async () => {
  const ticket = 't'.repeat(43);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ticket })));
  vi.stubGlobal('fetch', fetcher);
  const repository = new RemoteBookAssetRepository(
    new RemoteApiClient('/api', { getAuthToken: () => 'private-token' }),
  );
  expect(await repository.listOriginalFiles('book')).toEqual([]);
  expect(await repository.createOriginalFileDownload('book', 'part')).toBe(`/api/original-downloads/${ticket}`);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]![0]).toBe('/api/books/book/original-files/part/download');
  expect(fetcher.mock.calls[1]![1].headers.Authorization).toBe('Bearer private-token');
});
