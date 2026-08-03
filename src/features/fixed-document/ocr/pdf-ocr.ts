import { persistentId128 } from '@noveldesk/text-core/hash';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { DocumentTextBlock, DocumentTextRevision, TextQuad } from '../../../domain/types';
import type { OcrPageResult } from '../../../providers/ocr-provider';

const DEFAULT_DPI = 216;
const MAX_RASTER_PIXELS = 12_000_000;

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('OCR page raster could not be encoded.'))),
      'image/png',
    );
  });
}

export async function rasterizePdfPageForOcr(page: PDFPageProxy, dpi = DEFAULT_DPI) {
  const base = page.getViewport({ scale: 1, rotation: 0 });
  let scale = Math.max(1, dpi / 72);
  const pixels = base.width * base.height * scale * scale;
  if (pixels > MAX_RASTER_PIXELS) scale *= Math.sqrt(MAX_RASTER_PIXELS / pixels);
  const viewport = page.getViewport({ scale, rotation: 0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('OCR page canvas is unavailable.');
  const task = page.render({ canvas, canvasContext: context, viewport });
  await task.promise;
  const image = await canvasBlob(canvas);
  canvas.width = 1;
  canvas.height = 1;
  return { image, pixelWidth: Math.floor(viewport.width), pixelHeight: Math.floor(viewport.height), dpi: scale * 72 };
}

function normalizedQuad(
  bbox: OcrPageResult['blocks'][number]['bbox'],
  pixelWidth: number,
  pixelHeight: number,
): TextQuad {
  return {
    x: Math.max(0, Math.min(1, bbox.x0 / pixelWidth)),
    y: Math.max(0, Math.min(1, bbox.y0 / pixelHeight)),
    width: Math.max(0, Math.min(1, (bbox.x1 - bbox.x0) / pixelWidth)),
    height: Math.max(0, Math.min(1, (bbox.y1 - bbox.y0) / pixelHeight)),
  };
}

export function buildOcrDocumentText(input: {
  result: OcrPageResult;
  bookId: string;
  pageIndex: number;
  pageHash: string;
  pixelWidth: number;
  pixelHeight: number;
  dpi: number;
  now?: string;
}): { revision: DocumentTextRevision; blocks: DocumentTextBlock[] } {
  const revisionId = persistentId128('document_text_revision', [
    input.bookId,
    input.pageHash,
    'ocr',
    input.result.providerId,
    input.result.engineVersion,
    input.result.language,
    String(Math.round(input.dpi)),
    'reading-order-v1',
  ]);
  const timestamp = input.now ?? new Date().toISOString();
  const blocks: DocumentTextBlock[] = input.result.blocks
    .map((block) => ({ ...block, text: block.text.replace(/\s+/g, ' ').trim() }))
    .filter((block) => block.text)
    .sort((left, right) => left.bbox.y0 - right.bbox.y0 || left.bbox.x0 - right.bbox.x0)
    .map((block, order) => ({
      id: persistentId128('document_text_block', [revisionId, String(order), block.text]),
      revisionId,
      bookId: input.bookId,
      pageIndex: input.pageIndex,
      order,
      role: 'paragraph',
      text: block.text,
      normalizedText: block.text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim(),
      quads: [normalizedQuad(block.bbox, input.pixelWidth, input.pixelHeight)],
      direction: 'ltr',
    }));
  return {
    revision: {
      id: revisionId,
      bookId: input.bookId,
      pageIndex: input.pageIndex,
      pageHash: input.pageHash,
      source: 'ocr',
      engine: input.result.providerId,
      engineVersion: input.result.engineVersion,
      language: input.result.language,
      status: 'ready',
      qualityScore: Math.max(0, Math.min(1, input.result.confidence / 100)),
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    blocks,
  };
}
