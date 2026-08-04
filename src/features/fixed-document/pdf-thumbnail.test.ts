import { describe, expect, it } from 'vitest';
import { pdfThumbnailDimensions, pdfThumbnailFingerprint } from './pdf-thumbnail';

describe('PDF thumbnail policy', () => {
  it('fits portrait and landscape pages inside the rail box', () => {
    expect(pdfThumbnailDimensions(600, 900)).toEqual({ width: 95, height: 142 });
    expect(pdfThumbnailDimensions(1200, 600)).toEqual({ width: 112, height: 56 });
  });

  it('keeps a stable renderer fingerprint', () => {
    expect(pdfThumbnailFingerprint()).toBe(pdfThumbnailFingerprint());
  });
});
