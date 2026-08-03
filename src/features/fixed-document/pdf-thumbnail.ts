import { persistentId128 } from '@noveldesk/text-core/hash';
import type { PDFPageProxy } from 'pdfjs-dist';

export const PDF_THUMBNAIL_VERSION = 'pdfjs-thumbnail-v1';
export const PDF_THUMBNAIL_MAX_WIDTH = 112;
export const PDF_THUMBNAIL_MAX_HEIGHT = 142;

export function pdfThumbnailFingerprint(): string {
  return persistentId128('pdf_thumbnail_renderer', [
    PDF_THUMBNAIL_VERSION,
    `${PDF_THUMBNAIL_MAX_WIDTH}x${PDF_THUMBNAIL_MAX_HEIGHT}`,
    'jpeg-0.78',
  ]);
}

export function pdfThumbnailDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('PDF 미리보기 크기를 확인할 수 없습니다.');
  }
  const scale = Math.min(PDF_THUMBNAIL_MAX_WIDTH / width, PDF_THUMBNAIL_MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function encodeJpeg(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Thumbnail cancelled.', 'AbortError'));
    canvas.toBlob(
      (blob) => {
        if (signal?.aborted) reject(new DOMException('Thumbnail cancelled.', 'AbortError'));
        else if (blob) resolve(blob);
        else reject(new Error('PDF 미리보기를 JPEG로 저장하지 못했습니다.'));
      },
      'image/jpeg',
      0.78,
    );
  });
}

export async function renderPdfThumbnail(page: PDFPageProxy, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const base = page.getViewport({ scale: 1, rotation: 0 });
  const dimensions = pdfThumbnailDimensions(base.width, base.height);
  const viewport = page.getViewport({ scale: dimensions.width / base.width, rotation: 0 });
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('PDF 미리보기 canvas를 만들 수 없습니다.');
  const task = page.render({ canvas, canvasContext: context, viewport });
  const cancel = () => task.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await task.promise;
    return {
      blob: await encodeJpeg(canvas, signal),
      contentType: 'image/jpeg' as const,
      pixelWidth: dimensions.width,
      pixelHeight: dimensions.height,
      renderFingerprint: pdfThumbnailFingerprint(),
    };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Thumbnail cancelled.', 'AbortError');
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
