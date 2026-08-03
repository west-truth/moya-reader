export interface OcrPageInput {
  readonly image: Blob;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly language: string;
  readonly onProgress?: (progress: number, status: string) => void;
}

export interface OcrTextBlock {
  readonly text: string;
  readonly confidence: number;
  readonly bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrPageResult {
  readonly providerId: string;
  readonly engineVersion: string;
  readonly language: string;
  readonly confidence: number;
  readonly blocks: readonly OcrTextBlock[];
}

export interface OcrProvider {
  readonly id: string;
  readonly capabilities: { readonly local: boolean; readonly languages: readonly string[]; readonly boxes: boolean };
  recognize(input: OcrPageInput, signal?: AbortSignal): Promise<OcrPageResult>;
  dispose(): Promise<void>;
}
