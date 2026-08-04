import { describe, expect, it, vi } from 'vitest';

vi.mock('pdfjs-dist', () => ({
  PDFDataRangeTransport: class {
    private listener?: (event: { type: string; begin: number; chunk: Uint8Array }) => void;

    transportReady(listener: (event: { type: string; begin: number; chunk: Uint8Array }) => void) {
      this.listener = listener;
    }

    onDataRange(begin: number, chunk: Uint8Array) {
      this.listener?.({ type: 'range', begin, chunk });
    }
  },
}));

import { BookSourcePdfRangeTransport } from './pdf-range-transport';

describe('BookSourcePdfRangeTransport', () => {
  it('loads a bounded header and forwards PDF.js range requests', async () => {
    const bytes = new Uint8Array(200_000).map((_, index) => index % 251);
    const readRange = vi.fn(async (start: number, end: number) => bytes.slice(start, end));
    const close = vi.fn(async () => undefined);
    const transport = await BookSourcePdfRangeTransport.open({
      byteLength: bytes.length,
      contentType: 'application/pdf',
      contentHash: 'sha256:pdf',
      readRange,
      close,
    });
    const received = new Promise<{ begin: number; bytes: Uint8Array }>((resolve) => {
      transport.transportReady((event: { type: string; begin: number; chunk: Uint8Array }) => {
        if (event.type === 'range') resolve({ begin: event.begin, bytes: event.chunk });
      });
    });

    transport.requestDataRange(100_000, 110_000);

    await expect(received).resolves.toMatchObject({ begin: 100_000, bytes: bytes.slice(100_000, 110_000) });
    expect(readRange.mock.calls[0]).toEqual([0, 65_536]);
    transport.abort();
    expect(close).toHaveBeenCalledOnce();
  });
});
