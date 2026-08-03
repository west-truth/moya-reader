import { PDFDataRangeTransport } from 'pdfjs-dist';
import type { RandomAccessBookSource } from '../../repositories/book-asset-repository';

const DEFAULT_INITIAL_BYTES = 64 * 1024;

export class BookSourcePdfRangeTransport extends PDFDataRangeTransport {
  private readonly controller = new AbortController();
  private closed = false;

  private constructor(
    private readonly source: RandomAccessBookSource,
    initialData: Uint8Array,
  ) {
    super(source.byteLength, initialData, true);
  }

  static async open(source: RandomAccessBookSource, initialBytes = DEFAULT_INITIAL_BYTES) {
    const initialData = await source.readRange(0, Math.min(source.byteLength, initialBytes));
    return new BookSourcePdfRangeTransport(source, initialData);
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.closed) return;
    const start = Math.max(0, Math.floor(begin));
    const limit = Math.min(this.source.byteLength, Math.max(start, Math.floor(end)));
    void this.source
      .readRange(start, limit, this.controller.signal)
      .then((bytes) => {
        if (!this.closed) this.onDataRange(start, bytes);
      })
      .catch((error) => {
        if (!this.closed && (!(error instanceof DOMException) || error.name !== 'AbortError')) {
          this.abort();
        }
      });
  }

  override abort(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    void this.source.close();
  }
}
