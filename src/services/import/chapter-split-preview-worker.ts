import { previewNovelChapterSplit } from '../../domain/parser';
import { ChapterSplitMode, EncodingMode } from '../../domain/types';
import { readFileAsArrayBufferInChunks } from './chunked-file-reader';

interface StartMessage {
  type: 'start';
  jobId: string;
  file: File;
  encoding: EncodingMode;
  chapterSplitMode: ChapterSplitMode;
}

interface CancelMessage {
  type: 'cancel';
  jobId: string;
}

type WorkerCommand = StartMessage | CancelMessage;

let activeJobId: string | undefined;
let cancelled = false;

function postProgress(jobId: string, file: File, bytesRead: number, message: string): void {
  self.postMessage({
    type: 'progress',
    progress: {
      jobId,
      status: bytesRead >= file.size ? 'parsing' : 'reading',
      bytesRead,
      totalBytes: file.size,
      message,
    },
  });
}

function importAbortError(): Error {
  return new DOMException('Preview cancelled', 'AbortError') as Error;
}

function throwIfCancelled(jobId: string): void {
  if (cancelled && activeJobId === jobId) throw importAbortError();
}

async function runPreview(message: StartMessage): Promise<void> {
  activeJobId = message.jobId;
  cancelled = false;
  const { jobId, file, encoding, chapterSplitMode } = message;

  try {
    postProgress(jobId, file, 0, '파일을 읽는 중입니다.');
    const buffer = await readFileAsArrayBufferInChunks(file, {
      shouldCancel: () => cancelled && activeJobId === jobId,
      onProgress: (progress) => {
        postProgress(
          jobId,
          file,
          progress.bytesRead,
          `파일을 읽는 중입니다. ${progress.bytesRead.toLocaleString()} / ${progress.totalBytes.toLocaleString()} 바이트`,
        );
      },
    });
    throwIfCancelled(jobId);
    postProgress(jobId, file, file.size, '화 분리 규칙을 적용하는 중입니다.');
    const result = await previewNovelChapterSplit(file.name, buffer, encoding, { chapterSplitMode });
    throwIfCancelled(jobId);
    self.postMessage({ type: 'complete', result });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : '화 분리 미리보기에 실패했습니다.';
    const name = error instanceof Error ? error.name : undefined;
    self.postMessage({ type: 'error', message: messageText, name });
  } finally {
    if (activeJobId === jobId) {
      activeJobId = undefined;
      cancelled = false;
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (!activeJobId || activeJobId === message.jobId) cancelled = true;
    return;
  }
  void runPreview(message);
};
