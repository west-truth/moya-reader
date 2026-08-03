import { persistentId128 } from '@noveldesk/text-core/hash';
import type { PDFPageProxy } from 'pdfjs-dist';
import { integrityHash } from '../../domain/id-hash-contract';
import type { GeneratedBookCoverInput } from '../../repositories/book-asset-repository';

export const PDF_GENERATED_COVER_VERSION = 'pdfjs-cover-v1';
export const PDF_GENERATED_COVER_MAX_WIDTH = 480;
export const PDF_GENERATED_COVER_MAX_HEIGHT = 720;

export function generatedPdfCoverDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('PDF 표지 크기를 확인할 수 없습니다.');
  }
  const scale = Math.min(PDF_GENERATED_COVER_MAX_WIDTH / width, PDF_GENERATED_COVER_MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function generatedPdfCoverFingerprint(sourceHash: string, pageHash: string): string {
  return persistentId128('pdf_generated_cover', [
    sourceHash,
    pageHash,
    PDF_GENERATED_COVER_VERSION,
    `${PDF_GENERATED_COVER_MAX_WIDTH}x${PDF_GENERATED_COVER_MAX_HEIGHT}`,
  ]);
}

function encodeJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PDF 표지를 JPEG로 저장하지 못했습니다.'))),
      'image/jpeg',
      0.84,
    );
  });
}

export async function renderPdfGeneratedCover(input: {
  readonly page: PDFPageProxy;
  readonly sourceHash: string;
  readonly pageHash: string;
}): Promise<GeneratedBookCoverInput> {
  const base = input.page.getViewport({ scale: 1, rotation: 0 });
  const dimensions = generatedPdfCoverDimensions(base.width, base.height);
  const viewport = input.page.getViewport({ scale: dimensions.width / base.width, rotation: 0 });
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('PDF 표지 canvas를 만들 수 없습니다.');
  await input.page.render({ canvas, canvasContext: context, viewport }).promise;
  const blob = await encodeJpeg(canvas);
  return {
    blob,
    fileName: 'generated-pdf-cover.jpg',
    contentType: 'image/jpeg',
    contentHash: integrityHash(await blob.arrayBuffer()),
    pixelWidth: dimensions.width,
    pixelHeight: dimensions.height,
    fit: 'contain',
    positionX: 50,
    positionY: 50,
    derivationFingerprint: generatedPdfCoverFingerprint(input.sourceHash, input.pageHash),
  };
}
