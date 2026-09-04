import type { EncodingMode, ChapterSplitMode, Novel } from '../../domain/types';
import type {
  ImportController,
  ImportFileInput,
  ImportProgress,
  ImportService,
} from '../../services/import/import-service';

export type ImportBatchFile = Pick<
  ImportFileInput,
  'file' | 'clientBookId' | 'importMode' | 'baseActiveContentRevisionId' | 'expectedSourceContentHash'
>;

export interface ImportBatchState {
  total: number;
  current: number;
  completed: number;
  failed: number;
  skipped: number;
  currentFileName?: string;
}

export interface ImportBatchOutcome {
  completed: number;
  failed: number;
  skipped: number;
  aborted: boolean;
  lastImportedNovel?: Novel;
}

export interface ImportBatchCallbacks {
  onBatchChange(state: ImportBatchState): void;
  onProgress(progress: ImportProgress): void;
  onFileStarted?(file: File): void;
  onFileProgress?(file: File, progress: ImportProgress): void;
  onFileCommitted?(file: File, novel: Novel): void | Promise<void>;
  onFileFailed(file: File, error: unknown): void;
  onCancelled(file?: File): void;
}

export interface RunImportBatchInput {
  files: readonly ImportBatchFile[];
  skipped: number;
  encoding: EncodingMode;
  chapterSplitMode: ChapterSplitMode;
  importService: ImportService;
  getNovel(id: string): Promise<Novel | undefined>;
  archivePassword?: string;
}

export class ImportRunCancellation {
  private requested = false;
  private activeController?: ImportController;

  get isRequested(): boolean {
    return this.requested;
  }

  start(): void {
    this.requested = false;
    this.activeController = undefined;
  }

  bind(controller: ImportController): void {
    this.activeController = controller;
    if (this.requested) controller.cancel();
  }

  release(controller: ImportController): void {
    if (this.activeController === controller) this.activeController = undefined;
  }

  cancel(): void {
    this.requested = true;
    this.activeController?.cancel();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function runImportBatch(
  input: RunImportBatchInput,
  cancellation: ImportRunCancellation,
  callbacks: ImportBatchCallbacks,
): Promise<ImportBatchOutcome> {
  cancellation.start();
  let completed = 0;
  let failed = 0;
  let aborted = false;
  let lastImportedNovel: Novel | undefined;

  callbacks.onBatchChange({
    total: input.files.length,
    current: 0,
    completed,
    failed,
    skipped: input.skipped,
    currentFileName: input.files[0]?.file.name,
  });

  for (let index = 0; index < input.files.length; index += 1) {
    if (cancellation.isRequested) {
      aborted = true;
      break;
    }

    const { file, clientBookId, importMode, baseActiveContentRevisionId, expectedSourceContentHash } =
      input.files[index];
    callbacks.onBatchChange({
      total: input.files.length,
      current: index + 1,
      completed,
      failed,
      skipped: input.skipped,
      currentFileName: file.name,
    });

    let controller: ImportController | undefined;
    try {
      callbacks.onFileStarted?.(file);
      controller = input.importService.importFile(
        {
          file,
          encoding: input.encoding,
          chapterSplitMode: input.chapterSplitMode,
          clientBookId,
          importMode,
          baseActiveContentRevisionId,
          expectedSourceContentHash,
          archivePassword: input.importService.supportsArchivePassword ? input.archivePassword : undefined,
        },
        (progress) => {
          callbacks.onProgress(progress);
          callbacks.onFileProgress?.(file, progress);
        },
      );
      cancellation.bind(controller);
      const result = await controller.promise;
      lastImportedNovel = (await input.getNovel(result.novel.id)) ?? result.novel;
      completed += 1;
      await callbacks.onFileCommitted?.(file, lastImportedNovel);
    } catch (error) {
      if (cancellation.isRequested || isAbortError(error)) {
        aborted = true;
        callbacks.onCancelled(file);
        break;
      }
      failed += 1;
      callbacks.onFileFailed(file, error);
    } finally {
      if (controller) cancellation.release(controller);
    }

    callbacks.onBatchChange({
      total: input.files.length,
      current: index + 1,
      completed,
      failed,
      skipped: input.skipped,
      currentFileName: file.name,
    });
  }

  return { completed, failed, skipped: input.skipped, aborted, lastImportedNovel };
}
