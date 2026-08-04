import { describe, expect, it } from 'vitest';
import {
  generatedPdfCoverDimensions,
  generatedPdfCoverFingerprint,
  PDF_GENERATED_COVER_MAX_HEIGHT,
  PDF_GENERATED_COVER_MAX_WIDTH,
} from './pdf-generated-cover';

describe('PDF generated cover policy', () => {
  it('bounds portrait, landscape and small PDF pages without cropping', () => {
    expect(generatedPdfCoverDimensions(600, 900)).toEqual({ width: 480, height: 720 });
    expect(generatedPdfCoverDimensions(1200, 600)).toEqual({ width: 480, height: 240 });
    expect(generatedPdfCoverDimensions(120, 180)).toEqual({
      width: PDF_GENERATED_COVER_MAX_WIDTH,
      height: PDF_GENERATED_COVER_MAX_HEIGHT,
    });
  });

  it('changes the derivation fingerprint when the source or page changes', () => {
    const current = generatedPdfCoverFingerprint('source-a', 'page-a');
    expect(generatedPdfCoverFingerprint('source-a', 'page-a')).toBe(current);
    expect(generatedPdfCoverFingerprint('source-b', 'page-a')).not.toBe(current);
    expect(generatedPdfCoverFingerprint('source-a', 'page-b')).not.toBe(current);
  });
});
