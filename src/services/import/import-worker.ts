import { ChapterSplitMode, EncodingMode } from '../../domain/types';
import {
  runBrowserEpubImportPipeline,
  runBrowserFixedDocumentImportPipeline,
  runBrowserImportPipeline,
} from './browser-import-pipeline';
import { readFileAsArrayBufferInChunks } from './chunked-file-reader';
import { ImportProgress } from './import-service';

interface StartMessage {
  type: 'start';
  jobId: string;
  file: File;
  encoding: EncodingMode;
  chapterSplitMode?: ChapterSplitMode;
  clientBookId?: string;
  importMode?: 'replace_book' | 'append_image_series';
  baseActiveContentRevisionId?: string;
  expectedSourceContentHash?: string;
  expectedNormalizedTextHash?: string;
  archivePassword?: string;
}

interface CancelMessage {
  type: 'cancel';
  jobId: string;
}

type WorkerCommand = StartMessage | CancelMessage;

let activeJobId: string | undefined;
let cancelled = false;

function postProgress(progress: ImportProgress): void {
  self.postMessage({ type: 'progress', progress });
}

function importAbortError(): Error {
  return new DOMException('Import cancelled', 'AbortError') as Error;
}

function throwIfCancelled(jobId: string): void {
  if (cancelled && activeJobId === jobId) throw importAbortError();
}

function postImportError(error: unknown, fallback = '파일 가져오기에 실패했습니다.'): void {
  const messageText =
    error instanceof Error
      ? error.message.trim() || error.name || fallback
      : String(error || fallback).trim() || fallback;
  const name = error instanceof Error ? error.name : undefined;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  self.postMessage({ type: 'error', message: messageText, name, code });
}

async function runImport(message: StartMessage): Promise<void> {
  activeJobId = message.jobId;
  cancelled = false;

  const { jobId, file, encoding } = message;
  try {
    throwIfCancelled(jobId);
    postProgress({
      jobId,
      status: 'reading',
      subphase: 'reading_chunks',
      bytesRead: 0,
      totalBytes: file.size,
      chaptersDetected: 0,
      paragraphsWritten: 0,
      message: '파일을 읽는 중입니다.',
    });

    const streamsArchiveEntries = /\.(zip|cbz|rar|cbr|7z|cb7)$/i.test(file.name);
    let buffer: ArrayBuffer | undefined = streamsArchiveEntries
      ? new ArrayBuffer(0)
      : await readFileAsArrayBufferInChunks(file, {
          shouldCancel: () => cancelled && activeJobId === jobId,
          onProgress: (readProgress) => {
            postProgress({
              jobId,
              status: 'reading',
              subphase: 'reading_chunks',
              bytesRead: readProgress.bytesRead,
              totalBytes: readProgress.totalBytes,
              chaptersDetected: 0,
              paragraphsWritten: 0,
              message: `파일을 읽는 중입니다. ${readProgress.bytesRead.toLocaleString()} / ${readProgress.totalBytes.toLocaleString()} 바이트`,
            });
          },
        });
    throwIfCancelled(jobId);
    const pipelineInput = {
      jobId,
      fileName: file.name,
      buffer,
      sourceBlob: file,
      totalBytes: file.size,
      encoding,
      chapterSplitMode: message.chapterSplitMode ?? 'auto',
      clientBookId: message.clientBookId,
      importMode: message.importMode,
      baseActiveContentRevisionId: message.baseActiveContentRevisionId,
      expectedSourceContentHash: message.expectedSourceContentHash,
      expectedNormalizedTextHash: message.expectedNormalizedTextHash,
      archivePassword: message.archivePassword,
      shouldCancel: () => cancelled && activeJobId === jobId,
      onProgress: postProgress,
    };
    const pipeline = /\.epub$/i.test(file.name)
      ? runBrowserEpubImportPipeline(pipelineInput)
      : /\.(pdf|zip|cbz|rar|cbr|7z|cb7)$/i.test(file.name)
        ? runBrowserFixedDocumentImportPipeline(pipelineInput)
        : runBrowserImportPipeline(pipelineInput);
    buffer = undefined;
    const result = await pipeline;

    self.postMessage({ type: 'complete', result });
  } catch (error) {
    postImportError(error);
  } finally {
    if (activeJobId === jobId) {
      activeJobId = undefined;
      cancelled = false;
    }
  }
}

self.addEventListener('error', (event) => {
  const location = event.filename ? ` (${event.filename}${event.lineno ? `:${event.lineno}:${event.colno}` : ''})` : '';
  postImportError(event.error ?? `${event.message || 'Import worker failed'}${location}`);
  event.preventDefault();
});

self.addEventListener('unhandledrejection', (event) => {
  postImportError(event.reason, 'Import worker promise failed');
  event.preventDefault();
});

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (!activeJobId || activeJobId === message.jobId) cancelled = true;
    return;
  }
  void runImport(message);
};
