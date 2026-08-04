import { describe, expect, it } from 'vitest';
import {
  archiveFullImageWindow,
  archiveThumbnailDimensions,
  archiveThumbnailFingerprint,
  archiveThumbnailPageHash,
} from './archive-thumbnail';

describe('archive thumbnail policy', () => {
  it('fits portrait and landscape images inside the rail box', () => {
    expect(archiveThumbnailDimensions(1_000, 2_000)).toEqual({ width: 71, height: 142 });
    expect(archiveThumbnailDimensions(2_000, 1_000)).toEqual({ width: 112, height: 56 });
  });

  it('uses stable source and renderer fingerprints', () => {
    expect(archiveThumbnailFingerprint()).toBe(archiveThumbnailFingerprint());
    expect(archiveThumbnailPageHash('source-a', 'asset-a', 0)).toBe(archiveThumbnailPageHash('source-a', 'asset-a', 0));
    expect(archiveThumbnailPageHash('source-a', 'asset-a', 0)).not.toBe(
      archiveThumbnailPageHash('source-a', 'asset-b', 0),
    );
  });

  it('keeps full-size images near the viewport instead of following the thumbnail rail', () => {
    expect(archiveFullImageWindow([50, 51], 50, 100)).toEqual([48, 49, 50, 51, 52]);
    expect(archiveFullImageWindow([0], 0, 100)).toEqual([0, 1, 2]);
  });
});
