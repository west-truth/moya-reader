import { stableId } from '../../domain/hash';
import { ContentRevisionConflictError } from '../../storage/content-revisions';
import {
  ArchiveImportError,
  ImportController,
  ImportFileInput,
  ImportProgress,
  ImportResult,
  ImportService,
} from './import-service';

type WorkerMessage =
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'complete'; result: ImportResult }
  | { type: 'error'; message: string; name?: string; code?: string };

const LOCAL_IMPORT_FIXED_HEADROOM = 8 * 1024 * 1024;
const LOCAL_IMPORT_SIZE_MULTIPLIER = 3;

export function estimatedLocalImportBytes(fileSize: number): number {
  return Math.max(0, fileSize) * LOCAL_IMPORT_SIZE_MULTIPLIER + LOCAL_IMPORT_FIXED_HEADROOM;
}

export async function assertLocalImportCapacity(fileSize: number): Promise<void> {
  const estimate = await globalThis.navigator?.storage?.estimate?.();
  if (!estimate || estimate.quota === undefined || estimate.usage === undefined) return;
  const available = Math.max(0, estimate.quota - estimate.usage);
  const required = estimatedLocalImportBytes(fileSize);
  if (available < required) {
    const requiredMiB = Math.ceil(required / (1024 * 1024));
    const availableMiB = Math.floor(available / (1024 * 1024));
    throw new Error(
      `저장공간이 부족합니다. 약 ${requiredMiB} MiB가 필요하며 ${availableMiB} MiB를 사용할 수 있습니다.`,
    );
  }
}

export class BrowserImportService implements ImportService {
  readonly supportsExpectedBase = true;
  readonly supportsArchivePassword = true;
  readonly supportsExpectedNormalizedTextHash = true;
  readonly supportsExpectedSourceContentHash = true;
  readonly supportsIncrementalImageSeriesAppend = true;

  importFile(input: ImportFileInput, onProgress: (progress: ImportProgress) => void): ImportController {
    const jobId = stableId('import', `${input.file.name}:${input.file.size}:${Date.now()}`, 12);
    let worker: Worker | undefined;
    let settled = false;
    let cancelRequested = false;
    let rejectPromise: ((reason?: unknown) => void) | undefined;
    let lastProgress: ImportProgress = {
      jobId,
      status: 'queued',
      subphase: 'queued',
      bytesRead: 0,
      totalBytes: input.file.size,
      chaptersDetected: 0,
      paragraphsWritten: 0,
      message: '가져오기를 준비하고 있습니다.',
    };
    const emitProgress = (progress: ImportProgress) => {
      lastProgress = progress;
      onProgress(progress);
    };

    const promise = new Promise<ImportResult>((resolve, reject) => {
      rejectPromise = reject;
      void assertLocalImportCapacity(input.file.size)
        .then(() => {
          if (cancelRequested) return;
          if (input.expectedBase && (!input.clientBookId || input.importMode === 'append_image_series')) {
            throw new Error('expectedBase requires clientBookId and replace_book');
          }
          worker = new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' });
          worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
            const message = event.data;
            if (message.type === 'progress') {
              emitProgress(message.progress);
              return;
            }

            settled = true;
            worker?.terminate();
            if (message.type === 'complete') {
              resolve(message.result);
              return;
            }
            if (
              message.code === 'password_required' ||
              message.code === 'wrong_password' ||
              message.code === 'unsupported_archive'
            ) {
              reject(new ArchiveImportError(message.message, message.code));
            } else {
              reject(
                message.name === 'AbortError'
                  ? (new DOMException(message.message, 'AbortError') as Error)
                  : message.name === 'ContentRevisionConflictError'
                    ? new ContentRevisionConflictError(message.message)
                    : new Error(message.message),
              );
            }
          };
          worker.onerror = (event) => {
            settled = true;
            worker?.terminate();
            const workerError = event.error;
            const detail =
              workerError instanceof Error ? workerError.message.trim() || workerError.name : event.message.trim();
            const location = event.filename
              ? ` (${event.filename}${event.lineno ? `:${event.lineno}:${event.colno}` : ''})`
              : '';
            reject(new Error(`${detail || 'Import worker failed'}${location}`));
          };
          worker.postMessage({
            type: 'start',
            jobId,
            file: input.file,
            encoding: input.encoding,
            chapterSplitMode: input.chapterSplitMode ?? 'auto',
            clientBookId: input.clientBookId,
            expectedBase: input.expectedBase,
            importMode: input.importMode,
            baseActiveContentRevisionId: input.baseActiveContentRevisionId,
            expectedSourceContentHash: input.expectedSourceContentHash,
            expectedNormalizedTextHash: input.expectedNormalizedTextHash,
            archivePassword: input.archivePassword,
          });
        })
        .catch((error) => {
          settled = true;
          reject(error);
        });
    });

    emitProgress(lastProgress);

    return {
      jobId,
      promise,
      cancel: () => {
        if (settled || cancelRequested) return;
        cancelRequested = true;
        if (worker) {
          worker.postMessage({ type: 'cancel', jobId });
        } else {
          settled = true;
          rejectPromise?.(new DOMException('Import cancelled', 'AbortError'));
        }
        emitProgress({
          ...lastProgress,
          status: 'cancelling',
          subphase: 'cancelling_cleanup',
          message: '가져오기를 취소하고 임시 저장을 정리하는 중입니다.',
        });
      },
    };
  }
}
