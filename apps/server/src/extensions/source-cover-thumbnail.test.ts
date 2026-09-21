import { expect, it } from 'vitest';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { sourceCoverThumbnail, thumbnailCoverAsset } from './source-cover-thumbnail.js';

it('reduces a real large cover without cropping and hashes the transformed bytes', async () => {
  const bytes = await sharp({ create: { width: 1600, height: 2400, channels: 3, background: '#234567' } })
    .png()
    .toBuffer();
  const original = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
  const result = await thumbnailCoverAsset({ blob: original, sha256: 'original' }, new AbortController().signal);
  const output = Buffer.from(await result.blob.arrayBuffer());
  expect(await sharp(output).metadata()).toMatchObject({ width: 480, height: 720, format: 'webp' });
  expect(output.length).toBeLessThan(bytes.length);
  expect(result.sha256).toBe(createHash('sha256').update(output).digest('hex'));
  expect(original.size).toBe(bytes.length);
});

it('keeps small originals and returns original bytes when conversion fails', async () => {
  const bytes = await sharp({ create: { width: 120, height: 180, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
  const small = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
  expect(await sourceCoverThumbnail(small, new AbortController().signal)).toBe(small);
  const invalid = new Blob(['invalid'], { type: 'image/jpeg' });
  expect(await sourceCoverThumbnail(invalid, new AbortController().signal)).toBe(invalid);
});
