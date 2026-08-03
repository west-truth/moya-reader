export interface ComicCropMargins {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ComicAutoCropBatchResult {
  readonly pageCrops: Record<string, ComicCropMargins>;
  readonly processed: number;
  readonly detected: number;
  readonly failedPages: number[];
  readonly aborted: boolean;
}

export function comicCropRefitScale(
  crop: ComicCropMargins | undefined,
  fit: 'page' | 'width' | 'height' | 'original',
): number {
  if (!crop || fit === 'original') return 1;
  const visibleWidth = Math.max(0.4, 1 - crop.left - crop.right);
  const visibleHeight = Math.max(0.4, 1 - crop.top - crop.bottom);
  const scale = fit === 'width' ? 1 / visibleWidth : fit === 'height' ? 1 / visibleHeight : Math.min(1 / visibleWidth, 1 / visibleHeight);
  return Math.max(1, Math.min(2.5, scale));
}

export async function runComicAutoCropBatch(input: {
  readonly pageIndexes: readonly number[];
  readonly existing?: Readonly<Record<string, ComicCropMargins>>;
  readonly signal: AbortSignal;
  readonly analyze: (pageIndex: number, signal: AbortSignal) => Promise<ComicCropMargins | undefined>;
  readonly onProgress?: (processed: number, total: number, detected: number) => void;
}): Promise<ComicAutoCropBatchResult> {
  const pageIndexes = [...new Set(input.pageIndexes.filter((page) => Number.isInteger(page) && page >= 0))];
  const pageCrops = { ...input.existing };
  const failedPages: number[] = [];
  let processed = 0;
  let detected = 0;
  for (const pageIndex of pageIndexes) {
    if (input.signal.aborted) break;
    try {
      const crop = await input.analyze(pageIndex, input.signal);
      if (input.signal.aborted) break;
      if (crop) {
        pageCrops[String(pageIndex)] = crop;
        detected += 1;
      } else failedPages.push(pageIndex);
    } catch (error) {
      if (input.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) break;
      failedPages.push(pageIndex);
    }
    processed += 1;
    input.onProgress?.(processed, pageIndexes.length, detected);
  }
  return { pageCrops, processed, detected, failedPages, aborted: input.signal.aborted };
}

export function detectComicContentBounds(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 24,
): ComicCropMargins | undefined {
  if (width < 4 || height < 4 || pixels.length < width * height * 4) return undefined;
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  const background = [0, 1, 2].map(
    (channel) => corners.reduce((sum, pixel) => sum + pixels[pixel * 4 + channel], 0) / corners.length,
  );
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let contentPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const difference = Math.max(
        Math.abs(pixels[offset] - background[0]),
        Math.abs(pixels[offset + 1] - background[1]),
        Math.abs(pixels[offset + 2] - background[2]),
      );
      if (difference < threshold || pixels[offset + 3] < 128) continue;
      contentPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY || contentPixels < width * height * 0.01) return undefined;
  const paddingX = Math.max(1, Math.round(width * 0.006));
  const paddingY = Math.max(1, Math.round(height * 0.006));
  return {
    top: Math.min(0.3, Math.max(0, minY - paddingY) / height),
    right: Math.min(0.3, Math.max(0, width - 1 - maxX - paddingX) / width),
    bottom: Math.min(0.3, Math.max(0, height - 1 - maxY - paddingY) / height),
    left: Math.min(0.3, Math.max(0, minX - paddingX) / width),
  };
}
