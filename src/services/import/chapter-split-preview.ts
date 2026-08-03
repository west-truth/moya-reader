import { stableId } from '../../domain/hash';
import { ChapterSplitMode, EncodingMode } from '../../domain/types';
import type { ChapterSplitPreview } from '../../domain/parser';

export interface ChapterSplitPreviewInput {
  file: File;
  encoding: EncodingMode;
  chapterSplitMode: ChapterSplitMode;
  onProgress?: (progress: ChapterSplitPreviewProgress) => void;
}

export interface ChapterSplitPreviewProgress {
  jobId: string;
  status: 'reading' | 'parsing';
  bytesRead: number;
  totalBytes: number;
  message: string;
}

export interface ChapterSplitPreviewController {
  jobId: string;
  promise: Promise<ChapterSplitPreview>;
  cancel(): void;
}

type WorkerMessage =
  | { type: 'progress'; progress: ChapterSplitPreviewProgress }
  | { type: 'complete'; result: ChapterSplitPreview }
  | { type: 'error'; message: string; name?: string };

export function previewChapterSplit(input: ChapterSplitPreviewInput): ChapterSplitPreviewController {
  const jobId = stableId('split_preview', `${input.file.name}:${input.file.size}:${Date.now()}`, 12);
  const worker = new Worker(new URL('./chapter-split-preview-worker.ts', import.meta.url), { type: 'module' });
  let settled = false;

  const promise = new Promise<ChapterSplitPreview>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'progress') {
        input.onProgress?.(message.progress);
        return;
      }

      settled = true;
      worker.terminate();
      if (message.type === 'complete') {
        resolve(message.result);
        return;
      }
      reject(message.name === 'AbortError'
        ? new DOMException(message.message, 'AbortError') as Error
        : new Error(message.message));
    };
    worker.onerror = (event) => {
      settled = true;
      worker.terminate();
      reject(new Error(event.message || 'Chapter split preview worker failed'));
    };
  });

  worker.postMessage({
    type: 'start',
    jobId,
    file: input.file,
    encoding: input.encoding,
    chapterSplitMode: input.chapterSplitMode,
  });

  return {
    jobId,
    promise,
    cancel: () => {
      if (settled) return;
      worker.postMessage({ type: 'cancel', jobId });
    },
  };
}
