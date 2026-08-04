import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteApiClient } from '../services/remote/remote-api-client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RemoteSearchTransport', () => {
  it('passes the caller signal to fetch and aborts the in-flight request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const client = new RemoteApiClient('https://reader.test');

    const pending = client.searchParagraphPage({
      scope: 'chapter',
      chapterId: 'chapter-1',
      query: 'needle',
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
