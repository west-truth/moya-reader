import { describe, expect, it } from 'vitest';
import { comicCropRefitScale, detectComicContentBounds, runComicAutoCropBatch } from './comic-auto-crop';

describe('comic auto crop', () => {
  it('finds a dark panel inside a light scanner margin', () => {
    const width = 20;
    const height = 20;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 4; y <= 15; y += 1) {
      for (let x = 3; x <= 16; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 20;
        pixels[offset + 1] = 20;
        pixels[offset + 2] = 20;
      }
    }
    expect(detectComicContentBounds(pixels, width, height)).toEqual({
      top: 0.15,
      right: 0.1,
      bottom: 0.15,
      left: 0.1,
    });
  });

  it('does not crop a blank page on weak evidence', () => {
    expect(detectComicContentBounds(new Uint8ClampedArray(10 * 10 * 4).fill(255), 10, 10)).toBeUndefined();
  });

  it('refits the visible crop against the active fit axis', () => {
    const crop = { top: 0.1, right: 0.2, bottom: 0.1, left: 0.2 };
    expect(comicCropRefitScale(crop, 'page')).toBe(1.25);
    expect(comicCropRefitScale(crop, 'width')).toBeCloseTo(1 / 0.6);
    expect(comicCropRefitScale(crop, 'height')).toBe(1.25);
    expect(comicCropRefitScale(crop, 'original')).toBe(1);
  });

  it('processes a batch sequentially while preserving previous successful crops', async () => {
    const analyzed: number[] = [];
    const result = await runComicAutoCropBatch({
      pageIndexes: [0, 1, 2],
      existing: { 0: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 } },
      signal: new AbortController().signal,
      analyze: async (pageIndex) => {
        analyzed.push(pageIndex);
        if (pageIndex === 1) throw new Error('broken page');
        return pageIndex === 2 ? { top: 0.2, right: 0.2, bottom: 0.2, left: 0.2 } : undefined;
      },
    });

    expect(analyzed).toEqual([0, 1, 2]);
    expect(result).toMatchObject({ processed: 3, detected: 1, failedPages: [0, 1], aborted: false });
    expect(result.pageCrops).toEqual({
      0: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
      2: { top: 0.2, right: 0.2, bottom: 0.2, left: 0.2 },
    });
  });

  it('stops between pages when cancelled and returns completed results', async () => {
    const controller = new AbortController();
    const result = await runComicAutoCropBatch({
      pageIndexes: [0, 1],
      signal: controller.signal,
      analyze: async (pageIndex) => {
        controller.abort();
        return { top: pageIndex / 10, right: 0, bottom: 0, left: 0 };
      },
    });

    expect(result).toMatchObject({ processed: 0, detected: 0, failedPages: [], aborted: true, pageCrops: {} });
  });
});
