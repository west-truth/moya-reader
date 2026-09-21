import { createHash } from 'node:crypto';
import sharp from 'sharp';

let running = 0;
const waiting: Array<() => void> = [];

/** Only display covers enter this path; chapter assets keep their original bytes. */
export async function sourceCoverThumbnail(blob: Blob, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  if (running >= 2) {
    if (waiting.length >= 8) return blob;
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else running++;
  try {
    signal.throwIfAborted();
    const image = sharp(Buffer.from(await blob.arrayBuffer()), { limitInputPixels: 24_000_000, pages: 1 });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format ?? '')) return blob;
    if (!metadata.width || !metadata.height) return blob;
    if (metadata.width <= 480 && metadata.height <= 720 && blob.size <= 256 * 1024) return blob;
    const bytes = await image
      .rotate()
      .resize(480, 720, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .timeout({ seconds: 5 })
      .toBuffer();
    signal.throwIfAborted();
    return bytes.length < blob.size ? new Blob([new Uint8Array(bytes)], { type: 'image/webp' }) : blob;
  } catch {
    signal.throwIfAborted();
    // A decoder/encoder failure must not hide a cover that the browser can display.
    return blob;
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

export async function thumbnailCoverAsset(image: { blob: Blob; sha256: string }, signal: AbortSignal) {
  const blob = await sourceCoverThumbnail(image.blob, signal);
  return blob === image.blob
    ? image
    : {
        blob,
        sha256: createHash('sha256')
          .update(Buffer.from(await blob.arrayBuffer()))
          .digest('hex'),
      };
}
