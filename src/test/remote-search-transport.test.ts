import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteApiClient } from '../services/remote/remote-api-client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RemoteSearchTransport', () => {
  it('propagates caller cancellation through the timeout-aware fetch signal', async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal).not.toBe(controller.signal);
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
