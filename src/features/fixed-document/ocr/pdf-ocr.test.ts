import { describe, expect, it } from 'vitest';
import { buildOcrDocumentText } from './pdf-ocr';

describe('buildOcrDocumentText', () => {
  it('normalizes OCR boxes and makes a deterministic searchable revision', () => {
    const built = buildOcrDocumentText({
      bookId: 'book',
      pageIndex: 2,
      pageHash: 'sha256:page',
      pixelWidth: 1000,
      pixelHeight: 2000,
      dpi: 216,
      now: '2026-08-01T00:00:00.000Z',
      result: {
        providerId: 'local-tesseract-v7',
        engineVersion: '7.0.0',
        language: 'kor+eng',
        confidence: 88,
        blocks: [
          { text: '두 번째', confidence: 80, bbox: { x0: 100, y0: 400, x1: 500, y1: 460 } },
          { text: '첫 번째', confidence: 90, bbox: { x0: 100, y0: 200, x1: 500, y1: 260 } },
        ],
      },
    });

    expect(built.blocks.map((block) => block.text)).toEqual(['첫 번째', '두 번째']);
    expect(built.blocks[0].quads[0]).toEqual({ x: 0.1, y: 0.1, width: 0.4, height: 0.03 });
    expect(built.revision).toMatchObject({ source: 'ocr', qualityScore: 0.88, status: 'ready' });
  });
});
