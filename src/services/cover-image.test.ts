import { describe, expect, it, vi } from 'vitest';
import { boundedCoverDimensions, detectCoverContentType, normalizeCoverImage } from './cover-image';

describe('cover image normalization', () => {
  it('detects supported formats by magic bytes and bounds dimensions', () => {
    expect(detectCoverContentType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(detectCoverContentType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe('image/png');
    expect(detectCoverContentType(new TextEncoder().encode('RIFFxxxxWEBP'))).toBe('image/webp');
    expect(boundedCoverDimensions(2400, 3600)).toEqual({ width: 1200, height: 1800 });
    expect(boundedCoverDimensions(600, 900)).toEqual({ width: 600, height: 900 });
  });

  it('normalizes decoded pixels and returns a content-addressed cover input', async () => {
    const file = new File([Uint8Array.from([0xff, 0xd8, 0xff, 0x00])], 'cover.jpg', { type: 'text/plain' });
    const close = vi.fn();
    const encoded = new Blob(['normalized'], { type: 'image/jpeg' });
    const result = await normalizeCoverImage(
      file,
      { fit: 'contain', positionX: 30, positionY: 80 },
      {
        decode: vi.fn(async () => ({ source: {} as CanvasImageSource, width: 2400, height: 3000, close })),
        encode: vi.fn(async (_source, width, height) => {
          expect({ width, height }).toEqual({ width: 1200, height: 1500 });
          return encoded;
        }),
      },
    );
    expect(result).toMatchObject({
      contentType: 'image/jpeg',
      pixelWidth: 1200,
      pixelHeight: 1500,
      fit: 'contain',
      positionX: 30,
      positionY: 80,
    });
    expect(result.contentHash).toMatch(/^sha256:/);
    expect(close).toHaveBeenCalledOnce();
  });
});
