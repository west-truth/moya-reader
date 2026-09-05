import { persistentId128 } from '@noveldesk/text-core/hash';

export const ARCHIVE_THUMBNAIL_VERSION = 'browser-image-thumbnail-v1';
export const ARCHIVE_THUMBNAIL_MAX_WIDTH = 112;
export const ARCHIVE_THUMBNAIL_MAX_HEIGHT = 142;

export function archiveThumbnailPageHash(assetId: string, pageIndex: number): string {
  // Document-page IDs include the immutable image/part hash. An append changes
  // the book manifest hash, but does not change the bytes of retained assets.
  return persistentId128('archive_thumbnail_asset_v2', [assetId, String(pageIndex)]);
}

export function archiveThumbnailFingerprint(): string {
  return persistentId128('archive_thumbnail_renderer', [
    ARCHIVE_THUMBNAIL_VERSION,
    `${ARCHIVE_THUMBNAIL_MAX_WIDTH}x${ARCHIVE_THUMBNAIL_MAX_HEIGHT}`,
    'jpeg-0.78',
    'background-white',
  ]);
}

export function archiveThumbnailDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('이미지 미리보기 크기를 확인할 수 없습니다.');
  }
  const scale = Math.min(ARCHIVE_THUMBNAIL_MAX_WIDTH / width, ARCHIVE_THUMBNAIL_MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function archiveFullImageWindow(
  displayedPages: readonly number[],
  currentPage: number,
  totalPages: number,
  radius = 2,
): number[] {
  const indexes = new Set(displayedPages.filter((index) => index >= 0 && index < totalPages));
  const safeRadius = Math.max(0, Math.floor(radius));
  for (let delta = -safeRadius; delta <= safeRadius; delta += 1) {
    const index = currentPage + delta;
    if (index >= 0 && index < totalPages) indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
}

function encodeJpeg(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Thumbnail cancelled.', 'AbortError'));
    canvas.toBlob(
      (blob) => {
        if (signal?.aborted) reject(new DOMException('Thumbnail cancelled.', 'AbortError'));
        else if (blob) resolve(blob);
        else reject(new Error('이미지 미리보기를 JPEG로 저장하지 못했습니다.'));
      },
      'image/jpeg',
      0.78,
    );
  });
}

export async function renderArchiveThumbnail(source: Blob, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(source);
  try {
    signal?.throwIfAborted();
    const dimensions = archiveThumbnailDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('이미지 미리보기 canvas를 만들 수 없습니다.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, dimensions.width, dimensions.height);
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
    return {
      blob: await encodeJpeg(canvas, signal),
      contentType: 'image/jpeg' as const,
      pixelWidth: dimensions.width,
      pixelHeight: dimensions.height,
      renderFingerprint: archiveThumbnailFingerprint(),
    };
  } finally {
    bitmap.close();
  }
}
