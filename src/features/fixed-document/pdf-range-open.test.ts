import { describe, expect, it, vi } from 'vitest';

class TestDomMatrix {
  readonly a = 1;
  readonly b = 0;
  readonly c = 0;
  readonly d = 1;
  readonly e = 0;
  readonly f = 0;
}

Object.assign(globalThis, {
  DOMMatrix: TestDomMatrix,
  ImageData: class TestImageData {},
  Path2D: class TestPath2D {},
});
Object.assign(Promise, {
  try: <Args extends unknown[], T>(callback: (...args: Args) => T | PromiseLike<T>, ...args: Args) =>
    Promise.resolve().then(() => callback(...args)),
});
Object.defineProperty(Uint8Array.prototype, 'toHex', {
  configurable: true,
  value(this: Uint8Array) {
    return [...this].map((value) => value.toString(16).padStart(2, '0')).join('');
  },
});

function tinyRangePdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 43 >>\nstream\nBT /F1 12 Tf 72 120 Td (Range PDF) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  source += `%${'x'.repeat(70_000)}\n`;
  const xrefOffset = source.length;
  source += `xref\n0 ${objects.length + 1}\n`;
  source += '0000000000 65535 f \n';
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

describe('PDF.js private Range source', () => {
  it('opens the first page while requesting only bounded source ranges', async () => {
    const [{ getDocument }, { BookSourcePdfRangeTransport }] = await Promise.all([
      import('pdfjs-dist'),
      import('./pdf-range-transport'),
    ]);
    const bytes = tinyRangePdf();
    const readRange = vi.fn(async (start: number, end: number) => bytes.slice(start, end));
    const close = vi.fn(async () => undefined);
    const transport = await BookSourcePdfRangeTransport.open(
      {
        byteLength: bytes.length,
        contentType: 'application/pdf',
        contentHash: 'sha256:range-pdf',
        readRange,
        close,
      },
      1_024,
    );
    const task = getDocument({
      range: transport,
      disableAutoFetch: true,
      disableStream: true,
    });

    try {
      const pdf = await task.promise;
      expect(pdf.numPages).toBe(1);
      const page = await pdf.getPage(1);
      expect(page.getViewport({ scale: 1 })).toMatchObject({ width: 200, height: 200 });
      expect(readRange.mock.calls[0]).toEqual([0, 1_024]);
      expect(readRange.mock.calls.some(([start]) => start > 0)).toBe(true);
      expect(readRange.mock.calls.every(([start, end]) => end - start < bytes.length)).toBe(true);
      await pdf.destroy();
    } finally {
      transport.abort();
    }

    expect(close).toHaveBeenCalledOnce();
  });
});
