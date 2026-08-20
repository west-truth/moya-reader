import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChapterSplitMode, EncodingMode, Novel } from '../../domain/types';
import type { ImportProgress, ImportService } from '../../services/import/import-service';
import type { PlatformDocumentIo } from '../../platform/document-io';
import type { StoredUploadSessionEntry } from '../../services/import/server-upload-import-service';
import type { ToastTone } from '../../shared/ui/ToastHost';
import { type ImportBatchState, ImportRunCancellation, runImportBatch } from './import-controller';
import {
  importFileKey,
  inspectImportDuplicates,
  type ImportDuplicateConflict,
  type ImportDuplicatePolicy,
} from './import-duplicate-inspection';
import { importFailureMessage } from './import-failure-message';
import { completedImportNotice, oversizedImportNotice, selectSupportedImportFiles } from './import-notice-policy';
import { type ImportDropTarget, useImportDropTarget } from './useImportDropTarget';
import { type ImportPreviewFactory, type ImportPreviewState, useImportPreview } from './useImportPreview';
import { useImportUploadSessions } from './useImportUploadSessions';

export { LOCAL_IMPORT_TARGET_BYTES } from './import-notice-policy';

export interface UseImportControllerOptions {
  importService: ImportService;
  documentIo?: PlatformDocumentIo;
  getNovel(id: string): Promise<Novel | undefined>;
  listNovels(): Promise<Novel[]>;
  onImportCommitted(novel?: Novel): Promise<void>;
  notify(message: string, tone?: ToastTone): void;
  previewFactory?: ImportPreviewFactory;
}

export type { ImportDuplicateConflict, ImportDuplicatePolicy } from './import-duplicate-inspection';

export interface ImportFeatureController {
  isOpen: boolean;
  busy: boolean;
  pendingFiles: readonly File[];
  duplicateBusy: boolean;
  duplicateConflicts: readonly ImportDuplicateConflict[];
  encoding: EncodingMode;
  chapterSplitMode: ChapterSplitMode;
  preview?: ImportPreviewState;
  progress?: ImportProgress;
  batch?: ImportBatchState;
  uploadSessions: readonly StoredUploadSessionEntry[];
  libraryDrop: ImportDropTarget;
  usesPlatformPicker: boolean;
  supportsArchivePassword: boolean;
  archivePassword: string;
  open(): void;
  close(): void;
  selectFiles(files: readonly File[]): void;
  pickFiles(): Promise<void>;
  importFiles(files: readonly File[]): Promise<void>;
  startPendingImport(): Promise<void>;
  previewPendingImport(): Promise<void>;
  cancelImport(): void;
  setEncoding(encoding: EncodingMode): void;
  setChapterSplitMode(mode: ChapterSplitMode): void;
  setDuplicatePolicy(fileKey: string, policy: ImportDuplicatePolicy): void;
  setArchivePassword(password: string): void;
  forgetUploadSession(key: string): Promise<void>;
}

export function useImportController(options: UseImportControllerOptions): ImportFeatureController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [isOpen, setIsOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [duplicateConflicts, setDuplicateConflicts] = useState<ImportDuplicateConflict[]>([]);
  const [encoding, setEncodingState] = useState<EncodingMode>('auto');
  const [chapterSplitMode, setChapterSplitModeState] = useState<ChapterSplitMode>('auto');
  const [archivePassword, setArchivePasswordState] = useState('');
  const [progress, setProgress] = useState<ImportProgress>();
  const [batch, setBatch] = useState<ImportBatchState>();
  const [queueBusy, setQueueBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const runGenerationRef = useRef(0);
  const cancellationRef = useRef(new ImportRunCancellation());
  const resetTimerRef = useRef<number>();
  const duplicateGenerationRef = useRef(0);
  const duplicateInspectionRef = useRef<Promise<void>>();
  const queuedResolutionRef = useRef<{
    readonly policies: ReadonlyMap<string, ImportDuplicateConflict>;
    readonly openExisting?: Novel;
  }>();
  const lastImportFailedRef = useRef(false);
  const {
    preview,
    start: startPreview,
    cancel: cancelPreview,
    clear: clearPreview,
  } = useImportPreview(options.previewFactory);
  const {
    sessions: uploadSessions,
    refresh: refreshUploadSessions,
    forget: forgetUploadSession,
  } = useImportUploadSessions(options.importService, options.notify);

  const clearDraft = useCallback(() => {
    duplicateGenerationRef.current += 1;
    setDuplicateBusy(false);
    setDuplicateConflicts([]);
    clearPreview();
    setPendingFiles([]);
    setArchivePasswordState('');
  }, [clearPreview]);

  useEffect(() => {
    const cancellation = cancellationRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runGenerationRef.current += 1;
      cancellation.cancel();
      if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  const open = useCallback(() => {
    setIsOpen(true);
    refreshUploadSessions();
  }, [refreshUploadSessions]);

  const close = useCallback(() => {
    if (busyRef.current) return;
    clearDraft();
    setIsOpen(false);
  }, [clearDraft]);

  const selectFiles = useCallback(
    (files: readonly File[]) => {
      if (busyRef.current) {
        optionsRef.current.notify('가져오기가 진행 중입니다.', 'warning');
        return;
      }
      const { supportedFiles, notice } = selectSupportedImportFiles(files);
      if (notice) optionsRef.current.notify(notice.message, notice.tone);
      if (supportedFiles.length === 0) return;
      clearDraft();
      setPendingFiles(supportedFiles);
      setIsOpen(true);
      refreshUploadSessions();
      const generation = duplicateGenerationRef.current + 1;
      duplicateGenerationRef.current = generation;
      setDuplicateBusy(true);
      const inspection = optionsRef.current
        .listNovels()
        .then((novels) => inspectImportDuplicates(supportedFiles, novels))
        .then((conflicts) => {
          if (duplicateGenerationRef.current === generation) setDuplicateConflicts(conflicts);
        })
        .catch(() => {
          if (duplicateGenerationRef.current === generation) {
            optionsRef.current.notify('중복 파일 확인을 완료하지 못했습니다.', 'warning');
          }
        })
        .finally(() => {
          if (duplicateGenerationRef.current === generation) setDuplicateBusy(false);
        });
      duplicateInspectionRef.current = inspection;
    },
    [clearDraft, refreshUploadSessions],
  );

  const pickFiles = useCallback(async () => {
    const documentIo = optionsRef.current.documentIo;
    if (!documentIo?.usesNativePicker || busyRef.current) return;
    try {
      const files = await documentIo.pickDocuments({
        multiple: true,
        mimeTypes: [
          'text/plain',
          'text/markdown',
          'application/epub+zip',
          'application/pdf',
          'application/zip',
          'application/vnd.comicbook+zip',
          'application/vnd.comicbook-rar',
          'application/x-7z-compressed',
          'application/octet-stream',
        ],
        extensions: ['txt', 'md', 'markdown', 'epub', 'pdf', 'zip', 'cbz', 'rar', 'cbr', '7z', 'cb7'],
      });
      if (files?.length) selectFiles(files);
    } catch (error) {
      optionsRef.current.notify(
        error instanceof Error ? error.message : 'Android에서 파일을 선택하지 못했습니다.',
        'danger',
      );
    }
  }, [selectFiles]);

  const importFiles = useCallback(
    async (files: readonly File[]) => {
      if (busyRef.current) return;
      const { supportedFiles, skipped: unsupportedSkipped, notice } = selectSupportedImportFiles(files);
      if (notice) optionsRef.current.notify(notice.message, notice.tone);
      if (supportedFiles.length === 0) return;
      let resolution = queuedResolutionRef.current;
      queuedResolutionRef.current = undefined;
      if (!resolution) {
        const conflicts = await inspectImportDuplicates(supportedFiles, await optionsRef.current.listNovels());
        resolution = { policies: new Map(conflicts.map((conflict) => [conflict.fileKey, conflict])) };
      }
      const preparedFiles: Array<{ file: File; clientBookId?: string }> = [];
      let duplicateSkipped = 0;
      let openExisting = resolution.openExisting;
      for (const file of supportedFiles) {
        const conflict = resolution.policies.get(importFileKey(file));
        if (!conflict || conflict.policy === 'new') {
          preparedFiles.push({ file });
        } else if (conflict.policy === 'replace') {
          preparedFiles.push({ file, clientBookId: conflict.existingBook.id });
        } else if (conflict.policy === 'copy') {
          const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          preparedFiles.push({ file, clientBookId: `book_copy_${suffix.split('-').join('')}` });
        } else {
          duplicateSkipped += 1;
          if (conflict.policy === 'open_existing') openExisting = conflict.existingBook;
        }
      }
      const skipped = unsupportedSkipped + duplicateSkipped;
      if (preparedFiles.length === 0) {
        await optionsRef.current.onImportCommitted(openExisting);
        optionsRef.current.notify(
          openExisting ? '이미 가져온 책을 열었습니다.' : `${skipped}개 파일을 건너뛰었습니다.`,
          'info',
        );
        setIsOpen(false);
        return;
      }
      const sizeNotice = oversizedImportNotice(supportedFiles);
      if (sizeNotice) optionsRef.current.notify(sizeNotice.message, sizeNotice.tone);

      if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current);
      const generation = runGenerationRef.current + 1;
      runGenerationRef.current = generation;
      busyRef.current = true;
      setQueueBusy(true);

      let resetDelay = 400;
      lastImportFailedRef.current = false;
      try {
        const outcome = await runImportBatch(
          {
            files: preparedFiles,
            skipped,
            encoding,
            chapterSplitMode,
            archivePassword,
            importService: optionsRef.current.importService,
            getNovel: (id) => optionsRef.current.getNovel(id),
          },
          cancellationRef.current,
          {
            onBatchChange: (state) => {
              if (runGenerationRef.current === generation) setBatch(state);
            },
            onProgress: (nextProgress) => {
              if (runGenerationRef.current === generation) setProgress(nextProgress);
            },
            onFileFailed: (file, error) => {
              if (runGenerationRef.current !== generation) return;
              const detail = importFailureMessage(file.name, error);
              setProgress((current) =>
                current
                  ? {
                      ...current,
                      status: 'failed',
                      message: detail,
                    }
                  : current,
              );
              optionsRef.current.notify(detail, 'danger');
            },
            onCancelled: () => {
              if (runGenerationRef.current !== generation) return;
              setProgress((current) =>
                current
                  ? {
                      ...current,
                      status: 'failed',
                      message: '가져오기를 취소했습니다.',
                    }
                  : current,
              );
            },
          },
        );
        if (!mountedRef.current || runGenerationRef.current !== generation) return;

        await optionsRef.current.onImportCommitted(outcome.lastImportedNovel ?? openExisting);
        if (!mountedRef.current || runGenerationRef.current !== generation) return;

        const completionNotice = completedImportNotice(outcome, supportedFiles);
        optionsRef.current.notify(completionNotice.message, completionNotice.tone);
        if (!outcome.aborted && outcome.failed === 0) setIsOpen(false);
        lastImportFailedRef.current = outcome.failed > 0 || outcome.aborted;
        resetDelay = outcome.failed > 0 || outcome.aborted ? 12_000 : supportedFiles.length > 1 ? 1400 : 400;
      } catch {
        if (mountedRef.current && runGenerationRef.current === generation) {
          lastImportFailedRef.current = true;
          setProgress((current) =>
            current
              ? {
                  ...current,
                  status: 'failed',
                  message: '가져온 책 목록을 새로고침하지 못했습니다.',
                }
              : current,
          );
          optionsRef.current.notify('가져온 책 목록을 새로고침하지 못했습니다.', 'danger');
          resetDelay = 12_000;
        }
      } finally {
        if (mountedRef.current && runGenerationRef.current === generation) {
          busyRef.current = false;
          setQueueBusy(false);
          refreshUploadSessions();
          resetTimerRef.current = window.setTimeout(() => {
            setProgress(undefined);
            setBatch(undefined);
          }, resetDelay);
        }
      }
    },
    [archivePassword, chapterSplitMode, encoding, refreshUploadSessions],
  );

  const startPendingImport = useCallback(async () => {
    if (pendingFiles.length === 0 || busyRef.current) return;
    await duplicateInspectionRef.current;
    const files = [...pendingFiles];
    const policies = new Map(duplicateConflicts.map((conflict) => [conflict.fileKey, conflict]));
    queuedResolutionRef.current = {
      policies,
      openExisting: duplicateConflicts.find((conflict) => conflict.policy === 'open_existing')?.existingBook,
    };
    cancelPreview();
    await importFiles(files);
    if (!mountedRef.current) return;
    if (!lastImportFailedRef.current) {
      setPendingFiles([]);
      setArchivePasswordState('');
      clearPreview();
    }
  }, [cancelPreview, clearPreview, duplicateConflicts, importFiles, pendingFiles]);

  const previewPendingImport = useCallback(async () => {
    const file = pendingFiles[0];
    if (!file) return;
    await startPreview(file, encoding, chapterSplitMode, busyRef.current);
  }, [chapterSplitMode, encoding, pendingFiles, startPreview]);

  const cancelImport = useCallback(() => {
    cancellationRef.current.cancel();
    setProgress((current) =>
      current
        ? {
            ...current,
            status: 'cancelling',
            message: '가져오기를 취소하는 중입니다.',
          }
        : current,
    );
  }, []);

  const setEncoding = useCallback(
    (nextEncoding: EncodingMode) => {
      clearPreview();
      setEncodingState(nextEncoding);
    },
    [clearPreview],
  );

  const setChapterSplitMode = useCallback(
    (mode: ChapterSplitMode) => {
      clearPreview();
      setChapterSplitModeState(mode);
    },
    [clearPreview],
  );

  const setDuplicatePolicy = useCallback((fileKey: string, policy: ImportDuplicatePolicy) => {
    setDuplicateConflicts((current) =>
      current.map((conflict) => (conflict.fileKey === fileKey ? { ...conflict, policy } : conflict)),
    );
  }, []);

  const setArchivePassword = useCallback((password: string) => setArchivePasswordState(password), []);

  const busy = queueBusy || (progress !== undefined && progress.status !== 'ready' && progress.status !== 'failed');
  const libraryDrop = useImportDropTarget({
    busy,
    selectFiles,
    importFiles,
    notify: options.notify,
  });
  return {
    isOpen,
    busy,
    pendingFiles,
    duplicateBusy,
    duplicateConflicts,
    encoding,
    chapterSplitMode,
    preview,
    progress,
    batch,
    uploadSessions,
    libraryDrop,
    usesPlatformPicker: Boolean(options.documentIo?.usesNativePicker),
    supportsArchivePassword: Boolean(options.importService.supportsArchivePassword),
    archivePassword,
    open,
    close,
    selectFiles,
    pickFiles,
    importFiles,
    startPendingImport,
    previewPendingImport,
    cancelImport,
    setEncoding,
    setChapterSplitMode,
    setDuplicatePolicy,
    setArchivePassword,
    forgetUploadSession,
  };
}
