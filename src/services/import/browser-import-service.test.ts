import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertLocalImportCapacity, BrowserImportService, estimatedLocalImportBytes } from './browser-import-service';

describe('browser import storage preflight', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('allows import when the browser reports enough persistent storage', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ quota: 100 * 1024 * 1024, usage: 10 * 1024 * 1024 })) },
    });
    await expect(assertLocalImportCapacity(20 * 1024 * 1024)).resolves.toBeUndefined();
    expect(estimatedLocalImportBytes(20 * 1024 * 1024)).toBe(68 * 1024 * 1024);
  });

  it('stops before worker parsing when estimated storage is insufficient', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ quota: 24 * 1024 * 1024, usage: 20 * 1024 * 1024 })) },
    });
    await expect(assertLocalImportCapacity(2 * 1024 * 1024)).rejects.toThrow('저장공간이 부족합니다');
  });

  it('keeps the existing import path when StorageManager is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    await expect(assertLocalImportCapacity(20 * 1024 * 1024)).resolves.toBeUndefined();
  });

  it('forwards the image-series delta contract to the import worker', async () => {
    const posted: unknown[] = [];
    class TestWorker {
      onmessage?: (event: MessageEvent) => void;
      onerror?: (event: ErrorEvent) => void;

      postMessage(message: { type?: string }) {
        posted.push(message);
        if (message.type === 'cancel') {
          queueMicrotask(() =>
            this.onmessage?.({
              data: { type: 'error', name: 'AbortError', message: 'cancelled' },
            } as MessageEvent),
          );
        }
      }

      terminate() {}
    }
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('Worker', TestWorker);
    const service = new BrowserImportService();
    const file = new File(['delta'], '회차.cbz', { type: 'application/vnd.comicbook+zip' });
    const controller = service.importFile(
      {
        file,
        encoding: 'auto',
        clientBookId: 'book-1',
        importMode: 'append_image_series',
        baseActiveContentRevisionId: 'revision-1',
        expectedSourceContentHash: 'delta-hash',
      },
      vi.fn(),
    );
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      type: 'start',
      clientBookId: 'book-1',
      importMode: 'append_image_series',
      baseActiveContentRevisionId: 'revision-1',
      expectedSourceContentHash: 'delta-hash',
    });
    controller.cancel();
    await expect(controller.promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
