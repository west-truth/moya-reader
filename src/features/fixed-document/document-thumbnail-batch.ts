export interface DocumentThumbnailBatchProgress {
  readonly current: number;
  readonly total: number;
  readonly rendered: number;
  readonly failed: number;
}

export async function runDocumentThumbnailBatch(input: {
  readonly totalPages: number;
  readonly signal: AbortSignal;
  readonly isCached: (pageIndex: number) => Promise<boolean>;
  readonly renderPage: (pageIndex: number, signal: AbortSignal) => Promise<void>;
  readonly onProgress?: (progress: DocumentThumbnailBatchProgress) => void;
}): Promise<DocumentThumbnailBatchProgress & { readonly cancelled: boolean }> {
  const total = Math.max(0, Math.floor(input.totalPages));
  let current = 0;
  let rendered = 0;
  let failed = 0;
  for (let pageIndex = 0; pageIndex < total; pageIndex += 1) {
    if (input.signal.aborted) break;
    try {
      if (!(await input.isCached(pageIndex))) {
        await input.renderPage(pageIndex, input.signal);
        rendered += 1;
      }
    } catch (error) {
      if (input.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) break;
      failed += 1;
    }
    current = pageIndex + 1;
    input.onProgress?.({ current, total, rendered, failed });
  }
  return { current, total, rendered, failed, cancelled: input.signal.aborted };
}
