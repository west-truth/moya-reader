import type { OcrPageInput, OcrPageResult, OcrProvider } from './ocr-provider';

interface TesseractBlock {
  readonly text: string;
  readonly confidence: number;
  readonly bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface TesseractWorker {
  recognize(
    image: Blob,
    options?: Record<string, unknown>,
    output?: { blocks?: boolean },
  ): Promise<{
    data: { blocks: TesseractBlock[] | null; confidence: number; text: string; version: string };
  }>;
  terminate(): Promise<unknown>;
}

export class LocalTesseractOcrProvider implements OcrProvider {
  readonly id = 'local-tesseract-v7';
  readonly capabilities = { local: true, languages: ['kor', 'jpn', 'eng'], boxes: true } as const;
  private worker?: { language: string; value: TesseractWorker };
  private progress?: OcrPageInput['onProgress'];

  private async getWorker(language: string): Promise<TesseractWorker> {
    if (this.worker?.language === language) return this.worker.value;
    if (this.worker) await this.worker.value.terminate();
    const { createWorker } = await import('tesseract.js');
    const value = (await createWorker(language, undefined, {
      logger: (message) => this.progress?.(message.progress, message.status),
    })) as TesseractWorker;
    this.worker = { language, value };
    return value;
  }

  async recognize(input: OcrPageInput, signal?: AbortSignal): Promise<OcrPageResult> {
    if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
    this.progress = input.onProgress;
    const worker = await this.getWorker(input.language);
    const abort = () => {
      if (this.worker?.value === worker) {
        const current = this.worker;
        this.worker = undefined;
        void current.value.terminate();
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await worker.recognize(input.image, {}, { blocks: true });
      if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
      const fallback = result.data.text.trim()
        ? [
            {
              text: result.data.text.trim(),
              confidence: result.data.confidence,
              bbox: { x0: 0, y0: 0, x1: input.pixelWidth, y1: input.pixelHeight },
            },
          ]
        : [];
      return {
        providerId: this.id,
        engineVersion: result.data.version || '7',
        language: input.language,
        confidence: result.data.confidence,
        blocks: result.data.blocks?.length ? result.data.blocks : fallback,
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      this.progress = undefined;
    }
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.value.terminate();
  }
}
