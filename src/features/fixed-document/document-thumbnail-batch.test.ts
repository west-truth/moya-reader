import { describe, expect, it } from 'vitest';
import { runDocumentThumbnailBatch } from './document-thumbnail-batch';

describe('document thumbnail batch', () => {
  it('skips cache hits and continues after an isolated render failure', async () => {
    const rendered: number[] = [];
    const result = await runDocumentThumbnailBatch({
      totalPages: 4,
      signal: new AbortController().signal,
      isCached: async (pageIndex) => pageIndex === 1,
      renderPage: async (pageIndex) => {
        if (pageIndex === 2) throw new Error('broken page');
        rendered.push(pageIndex);
      },
    });
    expect(rendered).toEqual([0, 3]);
    expect(result).toEqual({ current: 4, total: 4, rendered: 2, failed: 1, cancelled: false });
  });

  it('stops before starting another page after cancellation', async () => {
    const controller = new AbortController();
    const rendered: number[] = [];
    const result = await runDocumentThumbnailBatch({
      totalPages: 5,
      signal: controller.signal,
      isCached: async () => false,
      renderPage: async (pageIndex) => {
        rendered.push(pageIndex);
        controller.abort();
      },
    });
    expect(rendered).toEqual([0]);
    expect(result.cancelled).toBe(true);
    expect(result.current).toBe(1);
  });
});
