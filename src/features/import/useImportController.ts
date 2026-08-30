import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chapter, ChapterSplitMode, EncodingMode, Novel } from '../../domain/types';
import type { ImportProgress, ImportService } from '../../services/import/import-service';
import { hashBlobInChunks } from '../../services/import/chunked-file-reader';
import type { PlatformDocumentIo } from '../../platform/document-io';
import type { StoredUploadSessionEntry } from '../../services/import/server-upload-import-service';
import type { ToastTone } from '../../shared/ui/ToastHost';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
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
import {
  buildLocalSeriesImportFile,
  inspectLocalSeriesImport,
  planLocalSeriesImport,
  type LocalSeriesImportInspection,
  type LocalSeriesImportPlan,
} from './local-series-import';
import {
  buildLocalDocumentSeriesImportFile,
  inspectLocalDocumentSeriesImport,
  planLocalDocumentSeriesImport,
  type LocalDocumentSeriesInspection,
  type LocalDocumentSeriesPlan,
} from './local-document-series-import';

export { LOCAL_IMPORT_TARGET_BYTES } from './import-notice-policy';

export interface UseImportControllerOptions {
  importService: ImportService;
  documentIo?: PlatformDocumentIo;
  getNovel(id: string): Promise<Novel | undefined>;
  listNovels(): Promise<Novel[]>;
  listChapters(novelId: string): Promise<Chapter[]>;
  assets?: BookAssetRepository;
  onImportCommitted(novel?: Novel): Promise<void>;
  notify(message: string, tone?: ToastTone): void;
  previewFactory?: ImportPreviewFactory;
}

export type { ImportDuplicateConflict, ImportDuplicatePolicy } from './import-duplicate-inspection';

function supportsIncrementalLocalSeriesAppend(
  importService: ImportService,
  targetNovel: Novel | undefined,
  chapters: readonly Chapter[],
): boolean {
  if (
    !importService.supportsIncrementalImageSeriesAppend ||
    targetNovel?.format !== 'image_archive' ||
    !targetNovel.activeContentRevisionId ||
    !targetNovel.sourceAssetId ||
    !targetNovel.documentSectionCount
  ) {
    return false;
  }
  const sectionIds = new Set(
    chapters.map((chapter) => chapter.documentSectionId).filter((id): id is string => Boolean(id)),
  );
  return (
    sectionIds.size === targetNovel.documentSectionCount &&
    [...sectionIds].every((id) => id.startsWith('local_series_release_'))
  );
}

async function planLocalSeriesForRuntime(
  inspection: LocalSeriesImportInspection,
  targetNovel: Novel | undefined,
  options: Pick<UseImportControllerOptions, 'assets' | 'importService' | 'listChapters'>,
): Promise<LocalSeriesImportPlan> {
  const canInspectIncrementalSections = Boolean(
    options.importService.supportsIncrementalImageSeriesAppend &&
    targetNovel?.format === 'image_archive' &&
    targetNovel.activeContentRevisionId &&
    targetNovel.sourceAssetId &&
    targetNovel.documentSectionCount,
  );
  const existingChapters = canInspectIncrementalSections ? await options.listChapters(targetNovel!.id) : [];
  const incrementalAppend = supportsIncrementalLocalSeriesAppend(options.importService, targetNovel, existingChapters);
  return planLocalSeriesImport(inspection, targetNovel, options.assets, {
    incrementalAppend,
    existingChapters: incrementalAppend ? existingChapters : undefined,
  });
}

function filesMatchAppendTarget(files: readonly File[], novel: Novel): boolean {
  if (novel.format === 'image_archive') return files.every((file) => /\.(?:zip|cbz|rar|cbr|7z|cb7)$/iu.test(file.name));
  if (novel.format === 'epub') return files.every((file) => /\.(?:epub|zip)$/iu.test(file.name));
  if (novel.format === 'txt' || novel.format === 'markdown') {
    return files.every((file) => /\.(?:txt|md|markdown|zip)$/iu.test(file.name));
  }
  return false;
}

export interface ImportFeatureController {
  isOpen: boolean;
  busy: boolean;
  pendingFiles: readonly File[];
  duplicateBusy: boolean;
  duplicateConflicts: readonly ImportDuplicateConflict[];
  seriesBusy: boolean;
  seriesInspection?: LocalSeriesImportInspection;
  seriesPlan?: LocalSeriesImportPlan;
  documentSeriesInspection?: LocalDocumentSeriesInspection;
  documentSeriesPlan?: LocalDocumentSeriesPlan;
  seriesTargetNovelId?: string;
  seriesTargetLocked: boolean;
  seriesError?: string;
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
  openChapterAppend(novel: Novel): void;
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
  setSeriesTargetNovel(targetNovelId?: string): Promise<void>;
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
  const [seriesBusy, setSeriesBusy] = useState(false);
  const [seriesInspection, setSeriesInspection] = useState<LocalSeriesImportInspection>();
  const [seriesPlan, setSeriesPlan] = useState<LocalSeriesImportPlan>();
  const [documentSeriesInspection, setDocumentSeriesInspection] = useState<LocalDocumentSeriesInspection>();
  const [documentSeriesPlan, setDocumentSeriesPlan] = useState<LocalDocumentSeriesPlan>();
  const [seriesTargetNovelId, setSeriesTargetNovelId] = useState<string>();
  const [seriesError, setSeriesError] = useState<string>();
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
  const explicitSeriesTargetRef = useRef<Novel>();
  const seriesBuildAbortRef = useRef<AbortController>();
  const seriesAnalysisGenerationRef = useRef(0);
  const queuedSeriesPlanRef = useRef<LocalSeriesImportPlan>();
  const queuedDocumentSeriesPlanRef = useRef<LocalDocumentSeriesPlan>();
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
    setSeriesBusy(false);
    setSeriesInspection(undefined);
    setSeriesPlan(undefined);
    setDocumentSeriesInspection(undefined);
    setDocumentSeriesPlan(undefined);
    setSeriesError(undefined);
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
    clearDraft();
    explicitSeriesTargetRef.current = undefined;
    setSeriesTargetNovelId(undefined);
    setIsOpen(true);
    refreshUploadSessions();
  }, [clearDraft, refreshUploadSessions]);

  const openChapterAppend = useCallback(
    (novel: Novel) => {
      if (busyRef.current) return;
      clearDraft();
      explicitSeriesTargetRef.current = novel;
      setSeriesTargetNovelId(novel.id);
      setIsOpen(true);
      refreshUploadSessions();
    },
    [clearDraft, refreshUploadSessions],
  );

  const close = useCallback(() => {
    if (busyRef.current) return;
    clearDraft();
    explicitSeriesTargetRef.current = undefined;
    setSeriesTargetNovelId(undefined);
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
      const explicitTarget = explicitSeriesTargetRef.current;
      if (explicitTarget && !filesMatchAppendTarget(supportedFiles, explicitTarget)) {
        optionsRef.current.notify('기존 작품과 같은 형식의 회차 파일을 선택해 주세요.', 'warning');
        return;
      }
      clearDraft();
      if (!explicitSeriesTargetRef.current) setSeriesTargetNovelId(undefined);
      setPendingFiles(supportedFiles);
      setIsOpen(true);
      refreshUploadSessions();
    },
    [clearDraft, refreshUploadSessions],
  );

  useEffect(() => {
    if (!pendingFiles.length) return;
    const generation = ++seriesAnalysisGenerationRef.current;
    duplicateGenerationRef.current = generation;
    setDuplicateBusy(true);
    setSeriesBusy(true);
    setSeriesError(undefined);
    const inspection = (async () => {
      const novels = await optionsRef.current.listNovels();
      let localSeriesError: string | undefined;
      let localDocumentSeriesError: string | undefined;
      const [conflicts, localSeries, localDocumentSeries] = await Promise.all([
        inspectImportDuplicates(pendingFiles, novels),
        inspectLocalSeriesImport(pendingFiles, novels, {
          password: archivePassword || undefined,
          targetNovel: explicitSeriesTargetRef.current,
        }).catch((error) => {
          localSeriesError = error instanceof Error ? error.message : '연재 작품 구조를 확인하지 못했습니다.';
          return undefined;
        }),
        inspectLocalDocumentSeriesImport(pendingFiles, novels, {
          targetNovel: explicitSeriesTargetRef.current,
          encoding,
          chapterSplitMode,
          password: archivePassword || undefined,
        }).catch((error) => {
          localDocumentSeriesError = error instanceof Error ? error.message : '문서 회차 구조를 확인하지 못했습니다.';
          return undefined;
        }),
      ]);
      if (generation !== seriesAnalysisGenerationRef.current) return;
      setSeriesError(localSeries || localDocumentSeries ? undefined : (localDocumentSeriesError ?? localSeriesError));
      if (!localSeries && !localDocumentSeries) {
        setDuplicateConflicts(conflicts);
        setSeriesInspection(undefined);
        setSeriesPlan(undefined);
        setDocumentSeriesInspection(undefined);
        setDocumentSeriesPlan(undefined);
        return;
      }
      setDuplicateConflicts([]);
      setSeriesInspection(localSeries);
      setDocumentSeriesInspection(localDocumentSeries);
      const candidates = localSeries?.candidateNovels ?? localDocumentSeries?.candidateNovels ?? [];
      const target = explicitSeriesTargetRef.current ?? candidates[0];
      setSeriesTargetNovelId(target?.id);
      try {
        if (localSeries) {
          setSeriesPlan(await planLocalSeriesForRuntime(localSeries, target, optionsRef.current));
          setDocumentSeriesPlan(undefined);
        } else if (localDocumentSeries) {
          const targetChapters = target ? await optionsRef.current.listChapters(target.id) : [];
          setDocumentSeriesPlan(
            await planLocalDocumentSeriesImport(localDocumentSeries, target, targetChapters, optionsRef.current.assets),
          );
          setSeriesPlan(undefined);
        }
      } catch (error) {
        setSeriesPlan(undefined);
        setDocumentSeriesPlan(undefined);
        setSeriesError(error instanceof Error ? error.message : '회차 추가 계획을 만들지 못했습니다.');
      }
    })()
      .catch(() => {
        if (generation === seriesAnalysisGenerationRef.current) {
          optionsRef.current.notify('중복 파일 확인을 완료하지 못했습니다.', 'warning');
        }
      })
      .finally(() => {
        if (generation === seriesAnalysisGenerationRef.current) {
          setDuplicateBusy(false);
          setSeriesBusy(false);
        }
      });
    duplicateInspectionRef.current = inspection;
    return () => {
      seriesAnalysisGenerationRef.current += 1;
    };
  }, [archivePassword, chapterSplitMode, encoding, pendingFiles]);

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
      const queuedSeriesPlan = queuedSeriesPlanRef.current;
      queuedSeriesPlanRef.current = undefined;
      const queuedDocumentSeriesPlan = queuedDocumentSeriesPlanRef.current;
      queuedDocumentSeriesPlanRef.current = undefined;
      let resolution = queuedResolutionRef.current;
      queuedResolutionRef.current = undefined;
      if (!resolution && !queuedSeriesPlan && !queuedDocumentSeriesPlan) {
        const novels = await optionsRef.current.listNovels();
        const localSeries = await inspectLocalSeriesImport(supportedFiles, novels, {
          password: archivePassword || undefined,
          targetNovel: explicitSeriesTargetRef.current,
        }).catch(() => undefined);
        if (localSeries) {
          selectFiles(supportedFiles);
          return;
        }
        const localDocumentSeries = await inspectLocalDocumentSeriesImport(supportedFiles, novels, {
          targetNovel: explicitSeriesTargetRef.current,
          encoding,
          chapterSplitMode,
          password: archivePassword || undefined,
        }).catch(() => undefined);
        if (localDocumentSeries) {
          selectFiles(supportedFiles);
          return;
        }
        const conflicts = await inspectImportDuplicates(supportedFiles, novels);
        resolution = { policies: new Map(conflicts.map((conflict) => [conflict.fileKey, conflict])) };
      }
      const preparedFiles: Array<{
        file: File;
        clientBookId?: string;
        importMode?: 'replace_book' | 'append_image_series';
        baseActiveContentRevisionId?: string;
        expectedSourceContentHash?: string;
      }> = [];
      let duplicateSkipped = 0;
      let openExisting = resolution?.openExisting;
      if (!queuedSeriesPlan && !queuedDocumentSeriesPlan) {
        for (const file of supportedFiles) {
          const conflict = resolution?.policies.get(importFileKey(file));
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
      }
      const skipped =
        unsupportedSkipped +
        duplicateSkipped +
        (queuedSeriesPlan
          ? queuedSeriesPlan.duplicateCount + queuedSeriesPlan.conflictCount
          : queuedDocumentSeriesPlan
            ? queuedDocumentSeriesPlan.duplicateCount + queuedDocumentSeriesPlan.conflictCount
            : 0);
      const queuedMergePlan = queuedSeriesPlan ?? queuedDocumentSeriesPlan;
      if (queuedMergePlan && queuedMergePlan.addCount === 0) {
        await optionsRef.current.onImportCommitted(queuedMergePlan.targetNovel);
        optionsRef.current.notify(
          queuedMergePlan.conflictCount > 0
            ? `추가할 새 회차가 없습니다. 내용이 다른 기존 회차 ${queuedMergePlan.conflictCount}개는 보존했습니다.`
            : '모든 회차가 이미 작품에 들어 있습니다.',
          'info',
        );
        setIsOpen(false);
        return;
      }
      if (!queuedMergePlan && preparedFiles.length === 0) {
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
        if (queuedSeriesPlan) {
          const abort = new AbortController();
          seriesBuildAbortRef.current = abort;
          setProgress({
            jobId: 'local-series-build',
            status: 'writing',
            subphase: 'staging_chapters',
            bytesRead: 0,
            totalBytes: Math.max(
              1,
              supportedFiles.reduce((sum, file) => sum + file.size, 0),
            ),
            chaptersDetected: queuedSeriesPlan.addCount,
            paragraphsWritten: 0,
            message: `새 회차 ${queuedSeriesPlan.addCount}개를 작품으로 구성하고 있습니다.`,
          });
          const aggregate = await buildLocalSeriesImportFile(
            queuedSeriesPlan,
            abort.signal,
            archivePassword || undefined,
          );
          seriesBuildAbortRef.current = undefined;
          if (!aggregate) throw new Error('추가할 새 회차가 없습니다.');
          const expectedSourceContentHash = queuedSeriesPlan.incrementalAppend
            ? await hashBlobInChunks(aggregate, { shouldCancel: () => abort.signal.aborted })
            : undefined;
          preparedFiles.push({
            file: aggregate,
            clientBookId: queuedSeriesPlan.targetNovel?.id,
            importMode: queuedSeriesPlan.incrementalAppend ? 'append_image_series' : undefined,
            baseActiveContentRevisionId: queuedSeriesPlan.incrementalAppend
              ? queuedSeriesPlan.targetNovel?.activeContentRevisionId
              : undefined,
            expectedSourceContentHash,
          });
        } else if (queuedDocumentSeriesPlan) {
          const abort = new AbortController();
          seriesBuildAbortRef.current = abort;
          setProgress({
            jobId: 'local-document-series-build',
            status: 'writing',
            subphase: 'staging_chapters',
            bytesRead: 0,
            totalBytes: Math.max(
              1,
              supportedFiles.reduce((sum, file) => sum + file.size, 0),
            ),
            chaptersDetected: queuedDocumentSeriesPlan.addCount,
            paragraphsWritten: 0,
            message: `새 회차 ${queuedDocumentSeriesPlan.addCount}개와 원본 파일을 작품으로 구성하고 있습니다.`,
          });
          const aggregate = await buildLocalDocumentSeriesImportFile(queuedDocumentSeriesPlan, abort.signal);
          seriesBuildAbortRef.current = undefined;
          if (!aggregate) throw new Error('추가할 새 회차가 없습니다.');
          preparedFiles.push({ file: aggregate, clientBookId: queuedDocumentSeriesPlan.targetNovel?.id });
        }
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

        if (queuedMergePlan && !outcome.aborted && outcome.failed === 0) {
          optionsRef.current.notify(
            queuedMergePlan.targetNovel
              ? `“${queuedMergePlan.targetNovel.title}”에 새 회차 ${queuedMergePlan.addCount}개를 추가했습니다.`
              : `“${queuedMergePlan.inspection.workTitle}”을(를) ${queuedMergePlan.addCount}개 회차로 추가했습니다.`,
            'success',
          );
        } else {
          const completionNotice = completedImportNotice(outcome, supportedFiles);
          optionsRef.current.notify(completionNotice.message, completionNotice.tone);
        }
        if (!outcome.aborted && outcome.failed === 0) setIsOpen(false);
        lastImportFailedRef.current = outcome.failed > 0 || outcome.aborted;
        resetDelay = outcome.failed > 0 || outcome.aborted ? 12_000 : supportedFiles.length > 1 ? 1400 : 400;
      } catch (error) {
        if (mountedRef.current && runGenerationRef.current === generation) {
          lastImportFailedRef.current = true;
          const cancelled = error instanceof DOMException && error.name === 'AbortError';
          const message = cancelled
            ? '가져오기를 취소했습니다.'
            : error instanceof Error
              ? error.message
              : '가져온 책 목록을 새로고침하지 못했습니다.';
          setProgress((current) =>
            current
              ? {
                  ...current,
                  status: 'failed',
                  message,
                }
              : current,
          );
          optionsRef.current.notify(message, cancelled ? 'info' : 'danger');
          resetDelay = 12_000;
        }
      } finally {
        seriesBuildAbortRef.current = undefined;
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
    [archivePassword, chapterSplitMode, encoding, refreshUploadSessions, selectFiles],
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
    queuedSeriesPlanRef.current = seriesPlan;
    queuedDocumentSeriesPlanRef.current = documentSeriesPlan;
    cancelPreview();
    await importFiles(files);
    if (!mountedRef.current) return;
    if (!lastImportFailedRef.current) {
      setPendingFiles([]);
      setArchivePasswordState('');
      clearPreview();
    }
  }, [cancelPreview, clearPreview, documentSeriesPlan, duplicateConflicts, importFiles, pendingFiles, seriesPlan]);

  const previewPendingImport = useCallback(async () => {
    const file = pendingFiles[0];
    if (!file) return;
    await startPreview(file, encoding, chapterSplitMode, busyRef.current);
  }, [chapterSplitMode, encoding, pendingFiles, startPreview]);

  const cancelImport = useCallback(() => {
    seriesBuildAbortRef.current?.abort();
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

  const setSeriesTargetNovel = useCallback(
    async (targetNovelId?: string) => {
      if ((!seriesInspection && !documentSeriesInspection) || seriesBusy || explicitSeriesTargetRef.current) return;
      const candidates = seriesInspection?.candidateNovels ?? documentSeriesInspection?.candidateNovels ?? [];
      const target = candidates.find((novel) => novel.id === targetNovelId);
      setSeriesTargetNovelId(target?.id);
      setSeriesBusy(true);
      setSeriesError(undefined);
      try {
        if (seriesInspection) {
          setSeriesPlan(await planLocalSeriesForRuntime(seriesInspection, target, optionsRef.current));
          setDocumentSeriesPlan(undefined);
        } else if (documentSeriesInspection) {
          const targetChapters = target ? await optionsRef.current.listChapters(target.id) : [];
          setDocumentSeriesPlan(
            await planLocalDocumentSeriesImport(
              documentSeriesInspection,
              target,
              targetChapters,
              optionsRef.current.assets,
            ),
          );
          setSeriesPlan(undefined);
        }
      } catch (error) {
        setSeriesPlan(undefined);
        setDocumentSeriesPlan(undefined);
        setSeriesError(error instanceof Error ? error.message : '회차 추가 계획을 만들지 못했습니다.');
      } finally {
        setSeriesBusy(false);
      }
    },
    [documentSeriesInspection, seriesBusy, seriesInspection],
  );

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
    seriesBusy,
    seriesInspection,
    seriesPlan,
    documentSeriesInspection,
    documentSeriesPlan,
    seriesTargetNovelId,
    seriesTargetLocked: Boolean(explicitSeriesTargetRef.current),
    seriesError,
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
    openChapterAppend,
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
    setSeriesTargetNovel,
    setArchivePassword,
    forgetUploadSession,
  };
}
