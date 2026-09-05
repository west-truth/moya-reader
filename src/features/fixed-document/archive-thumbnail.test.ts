import { describe, expect, it } from 'vitest';
import { comicPageAssetId } from '@noveldesk/fixed-document-core/comic-source';
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
    expect(archiveThumbnailPageHash('asset-a', 0)).toBe(archiveThumbnailPageHash('asset-a', 0));
    expect(archiveThumbnailPageHash('asset-a', 0)).not.toBe(archiveThumbnailPageHash('asset-b', 0));
    expect(archiveThumbnailPageHash('asset-a', 0)).not.toBe(archiveThumbnailPageHash('asset-a', 1));
  });

  it('keeps full-size images near the viewport instead of following the thumbnail rail', () => {
    expect(archiveFullImageWindow([50, 51], 50, 100)).toEqual([48, 49, 50, 51, 52]);
    expect(archiveFullImageWindow([0], 0, 100)).toEqual([0, 1, 2]);
  });

  it('keeps an immutable page thumbnail across appends but invalidates changed image bytes', () => {
    const retainedPage = {
      partHash: 'sha256:old-part',
      sourcePageIndex: 0,
      entryName: '001.png',
      contentType: 'image/png',
    };
    const beforeAppend = archiveThumbnailPageHash(comicPageAssetId('book', retainedPage), 0);
    const afterAppend = archiveThumbnailPageHash(comicPageAssetId('book', { ...retainedPage }), 0);
    const replacement = archiveThumbnailPageHash(
      comicPageAssetId('book', { ...retainedPage, partHash: 'sha256:replacement' }),
      0,
    );
    expect(afterAppend).toBe(beforeAppend);
    expect(replacement).not.toBe(beforeAppend);
  });
});
