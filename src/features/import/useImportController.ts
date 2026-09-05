import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chapter, ChapterSplitMode, EncodingMode, Novel } from '../../domain/types';
import type { ImportProgress, ImportService } from '../../services/import/import-service';
import type { PlatformDocumentIo } from '../../platform/document-io';
import type { StoredUploadSessionEntry } from '../../services/import/server-upload-import-service';
import type { ToastTone } from '../../shared/ui/ToastHost';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { extractWorkTitle } from '../../domain/work-title-extraction';
import {
  type ImportBatchState,
  type ImportBatchCallbacks,
  ImportRunCancellation,
  runImportBatch,
} from './import-controller';
import { runLocalSeriesImport } from './local-series-import-runner';
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
import { type ImportTaskView, projectImportProgress } from './import-task-projection';

export { LOCAL_IMPORT_TARGET_BYTES } from './import-notice-policy';

export interface UseImportControllerOptions {
  importService: ImportService;
  documentIo?: PlatformDocumentIo;
  getNovel(id: string): Promise<Novel | undefined>;
  listNovels(): Promise<Novel[]>;
  listChapters(novelId: string): Promise<Chapter[]>;
  assets?: BookAssetRepository;
  onImportCommitted(novel: Novel): Promise<void>;
  onImportSettled?(): Promise<void>;
  onOpenRequested?(novel: Novel): Promise<void>;
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

interface PreparedImportDraft {
  readonly generation: number;
  readonly files: readonly File[];
  readonly conflicts: readonly ImportDuplicateConflict[];
  readonly seriesPlan?: LocalSeriesImportPlan;
  readonly documentSeriesPlan?: LocalDocumentSeriesPlan;
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
  tasks: readonly ImportTaskView[];
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
  dismissTask(taskId: string): void;
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
  const [tasks, setTasks] = useState<ImportTaskView[]>([]);
  const [queueBusy, setQueueBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const runGenerationRef = useRef(0);
  const cancellationRef = useRef(new ImportRunCancellation());
  const resetTimerRef = useRef<number>();
  const duplicateInspectionRef = useRef<Promise<void>>();
  const explicitSeriesTargetRef = useRef<Novel>();
  const seriesBuildAbortRef = useRef<AbortController>();
  const seriesAnalysisGenerationRef = useRef(0);
  const preparedDraftRef = useRef<PreparedImportDraft>();
  const queuedSeriesPlanRef = useRef<LocalSeriesImportPlan>();
  const queuedDocumentSeriesPlanRef = useRef<LocalDocumentSeriesPlan>();
  const queuedResolutionRef = useRef<{
    readonly policies: ReadonlyMap<string, ImportDuplicateConflict>;
    readonly openExisting?: Novel;
  }>();
  const lastImportFailedRef = useRef(false);
  const backgroundedRunRef = useRef(false);
  const tasksRef = useRef<readonly ImportTaskView[]>(tasks);
  tasksRef.current = tasks;
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

  const invalidatePreparation = useCallback(() => {
    seriesAnalysisGenerationRef.current += 1;
    preparedDraftRef.current = undefined;
  }, []);

  const clearDraft = useCallback(() => {
    invalidatePreparation();
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
    setTasks([]);
  }, [clearPreview, invalidatePreparation]);

  useEffect(() => {
    const cancellation = cancellationRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runGenerationRef.current += 1;
      seriesAnalysisGenerationRef.current += 1;
      preparedDraftRef.current = undefined;
      cancellation.cancel();
      if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  const open = useCallback(() => {
    if (busyRef.current || tasksRef.current.some((task) => task.phase === 'failed')) {
      setIsOpen(true);
      refreshUploadSessions();
      return;
    }
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
    if (busyRef.current) {
      backgroundedRunRef.current = true;
      setIsOpen(false);
      optionsRef.current.notify('가져오기는 계속됩니다.');
      return;
    }
    if (tasksRef.current.some((task) => task.phase === 'failed')) {
      setIsOpen(false);
      return;
    }
    clearDraft();
    explicitSeriesTargetRef.current = undefined;
    setSeriesTargetNovelId(undefined);
    setIsOpen(false);
  }, [clearDraft]);

  const dismissTask = useCallback(
    (taskId: string) => {
      setTasks((current) => current.filter((task) => task.id !== taskId));
      if (!busyRef.current && tasksRef.current.filter((task) => task.id !== taskId).length === 0) clearDraft();
    },
    [clearDraft],
  );

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
    preparedDraftRef.current = undefined;
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
        preparedDraftRef.current = { generation, files: pendingFiles, conflicts };
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
        let nextSeriesPlan: LocalSeriesImportPlan | undefined;
        let nextDocumentSeriesPlan: LocalDocumentSeriesPlan | undefined;
        if (localSeries) {
          nextSeriesPlan = await planLocalSeriesForRuntime(localSeries, target, optionsRef.current);
        } else if (localDocumentSeries) {
          const targetChapters = target ? await optionsRef.current.listChapters(target.id) : [];
          if (generation !== seriesAnalysisGenerationRef.current) return;
          nextDocumentSeriesPlan = await planLocalDocumentSeriesImport(
            localDocumentSeries,
            target,
            targetChapters,
            optionsRef.current.assets,
          );
        }
        if (generation !== seriesAnalysisGenerationRef.current) return;
        preparedDraftRef.current = {
          generation,
          files: pendingFiles,
          conflicts: [],
          seriesPlan: nextSeriesPlan,
          documentSeriesPlan: nextDocumentSeriesPlan,
        };
        setSeriesPlan(nextSeriesPlan);
        setDocumentSeriesPlan(nextDocumentSeriesPlan);
      } catch (error) {
        if (generation !== seriesAnalysisGenerationRef.current) return;
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
        targetNovel?: Novel;
      }> = [];
      let duplicateSkipped = 0;
      let openExisting = resolution?.openExisting;
      if (!queuedSeriesPlan && !queuedDocumentSeriesPlan) {
        for (const file of supportedFiles) {
          const conflict = resolution?.policies.get(importFileKey(file));
          if (!conflict || conflict.policy === 'new') {
            preparedFiles.push({ file });
          } else if (conflict.policy === 'replace') {
            preparedFiles.push({ file, clientBookId: conflict.existingBook.id, targetNovel: conflict.existingBook });
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
        if (queuedMergePlan.targetNovel) await optionsRef.current.onOpenRequested?.(queuedMergePlan.targetNovel);
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
        if (openExisting) await optionsRef.current.onOpenRequested?.(openExisting);
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
      const batchId = `import-batch-${generation}-${Date.now()}`;
      const taskIdByFile = new Map<File, string>();
      const taskCompletedCount = new Map<string, number>();
      const nextTaskId = (suffix: string) => `${batchId}-${suffix}`;
      const queuedTasks: ImportTaskView[] = [];
      if (queuedMergePlan) {
        const taskId = nextTaskId('series');
        supportedFiles.forEach((file) => taskIdByFile.set(file, taskId));
        queuedSeriesPlan?.releases
          .filter((release) => release.disposition === 'add')
          .forEach((release) => taskIdByFile.set(release.file, taskId));
        queuedTasks.push({
          id: taskId,
          batchId,
          source: 'local_file',
          title: queuedMergePlan.targetNovel?.title ?? queuedMergePlan.inspection.workTitle,
          fileName: supportedFiles[0]?.name,
          targetBookId: queuedMergePlan.targetNovel?.id,
          phase: 'queued',
          current: 0,
          total: Math.max(1, queuedSeriesPlan ? queuedMergePlan.addCount : 1),
        });
      } else {
        preparedFiles.forEach((prepared, index) => {
          const taskId = nextTaskId(String(index));
          taskIdByFile.set(prepared.file, taskId);
          queuedTasks.push({
            id: taskId,
            batchId,
            source: 'local_file',
            title:
              prepared.targetNovel?.title ??
              extractWorkTitle(prepared.file.name, prepared.file.name).canonicalTitle ??
              prepared.file.name,
            fileName: prepared.file.name,
            targetBookId: prepared.targetNovel?.id,
            phase: 'queued',
            current: 0,
            total: 1,
          });
        });
      }
      setTasks(queuedTasks);
      backgroundedRunRef.current = false;
      runGenerationRef.current = generation;
      busyRef.current = true;
      setQueueBusy(true);

      let resetDelay = 400;
      lastImportFailedRef.current = false;
      try {
        if (queuedDocumentSeriesPlan) {
          const abort = new AbortController();
          seriesBuildAbortRef.current = abort;
          const taskId = queuedTasks[0]?.id;
          if (taskId) {
            setTasks((current) =>
              current.map((task) => (task.id === taskId ? { ...task, phase: 'preparing', percent: undefined } : task)),
            );
          }
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
          if (taskId) taskIdByFile.set(aggregate, taskId);
          preparedFiles.push({
            file: aggregate,
            clientBookId: queuedDocumentSeriesPlan.targetNovel?.id,
            targetNovel: queuedDocumentSeriesPlan.targetNovel,
          });
        }
        const batchInput = {
          skipped,
          encoding,
          chapterSplitMode,
          archivePassword,
          importService: optionsRef.current.importService,
          getNovel: (id: string) => optionsRef.current.getNovel(id),
        };
        const callbacks: ImportBatchCallbacks = {
          onBatchChange: (state) => {
            if (runGenerationRef.current === generation) setBatch(state);
          },
          onProgress: (nextProgress) => {
            if (runGenerationRef.current === generation) setProgress(nextProgress);
          },
          onFileStarted: (file) => {
            const taskId = taskIdByFile.get(file);
            if (!taskId || runGenerationRef.current !== generation) return;
            setTasks((current) =>
              current.map((task) =>
                task.id === taskId && task.phase !== 'failed'
                  ? {
                      ...task,
                      phase: 'preparing',
                      current: Math.min(task.total ?? 1, (taskCompletedCount.get(taskId) ?? 0) + 1),
                      percent: undefined,
                    }
                  : task,
              ),
            );
          },
          onFileProgress: (file, nextProgress) => {
            const taskId = taskIdByFile.get(file);
            if (!taskId || runGenerationRef.current !== generation) return;
            const projection = projectImportProgress(nextProgress);
            setTasks((current) =>
              current.map((task) =>
                task.id === taskId && task.phase !== 'failed' ? { ...task, ...projection, error: undefined } : task,
              ),
            );
          },
          onFileCommitted: async (file, novel) => {
            const taskId = taskIdByFile.get(file);
            if (!taskId || runGenerationRef.current !== generation) return;
            const task = queuedTasks.find((candidate) => candidate.id === taskId);
            const completed = (taskCompletedCount.get(taskId) ?? 0) + 1;
            taskCompletedCount.set(taskId, completed);
            setTasks((current) =>
              current.map((candidate) =>
                candidate.id === taskId
                  ? {
                      ...candidate,
                      targetBookId: novel.id,
                      current: completed,
                      phase: 'saving',
                      percent: undefined,
                    }
                  : candidate,
              ),
            );
            await optionsRef.current.onImportCommitted(novel).catch((error) => {
              optionsRef.current.notify(
                error instanceof Error
                  ? `작품은 저장했지만 목록을 새로고치지 못했습니다. ${error.message}`
                  : '작품은 저장했지만 목록을 새로고치지 못했습니다.',
                'warning',
              );
            });
            if (completed >= (task?.total ?? 1)) {
              setTasks((current) => current.filter((candidate) => candidate.id !== taskId));
            } else {
              setTasks((current) =>
                current.map((candidate) =>
                  candidate.id === taskId ? { ...candidate, phase: 'queued', percent: undefined } : candidate,
                ),
              );
            }
          },
          onFileFailed: (file, error) => {
            if (runGenerationRef.current !== generation) return;
            const detail = importFailureMessage(file.name, error);
            const taskId = taskIdByFile.get(file) ?? queuedTasks[0]?.id;
            if (taskId) {
              setTasks((current) =>
                current.map((task) =>
                  task.id === taskId ? { ...task, phase: 'failed', percent: undefined, error: detail } : task,
                ),
              );
            }
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
          onCancelled: (file) => {
            if (runGenerationRef.current !== generation) return;
            const taskId = (file && taskIdByFile.get(file)) ?? queuedTasks[0]?.id;
            if (taskId) {
              setTasks((current) =>
                current.map((task) =>
                  task.id === taskId
                    ? { ...task, phase: 'failed', percent: undefined, error: '가져오기를 취소했습니다.' }
                    : task,
                ),
              );
            }
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
        };
        const abort = new AbortController();
        if (queuedSeriesPlan) seriesBuildAbortRef.current = abort;
        const outcome = queuedSeriesPlan
          ? await runLocalSeriesImport(
              {
                ...batchInput,
                plan: queuedSeriesPlan,
                signal: abort.signal,
                replan: (novel) => planLocalSeriesForRuntime(queuedSeriesPlan.inspection, novel, optionsRef.current),
                onCommitted: (novel, releaseId) => {
                  if (!mountedRef.current || runGenerationRef.current !== generation) return;
                  // Retain the target and completed releases even if the next request
                  // fails, so retry cannot accidentally create another Library book.
                  explicitSeriesTargetRef.current = novel;
                  setSeriesTargetNovelId(novel.id);
                  const updatePlan = (current: LocalSeriesImportPlan | undefined): LocalSeriesImportPlan | undefined =>
                    current
                      ? {
                          ...current,
                          targetNovel: novel,
                          releases: current.releases.map((release) =>
                            release.id === releaseId ? { ...release, disposition: 'duplicate' as const } : release,
                          ),
                          addCount: Math.max(0, current.addCount - 1),
                          duplicateCount: current.duplicateCount + 1,
                        }
                      : current;
                  if (preparedDraftRef.current) {
                    preparedDraftRef.current = {
                      ...preparedDraftRef.current,
                      seriesPlan: updatePlan(preparedDraftRef.current.seriesPlan),
                    };
                  }
                  setSeriesPlan(updatePlan);
                },
              },
              cancellationRef.current,
              callbacks,
            )
          : await runImportBatch({ ...batchInput, files: preparedFiles }, cancellationRef.current, callbacks);
        if (!mountedRef.current || runGenerationRef.current !== generation) return;

        if (queuedSeriesPlan && outcome.lastImportedNovel && (outcome.aborted || outcome.failed > 0)) {
          const updatedPlan = await planLocalSeriesForRuntime(
            queuedSeriesPlan.inspection,
            outcome.lastImportedNovel,
            optionsRef.current,
          ).catch(() => undefined);
          if (updatedPlan) setSeriesPlan(updatedPlan);
        }

        if (outcome.completed > 0) {
          await optionsRef.current.onImportSettled?.().catch((error) => {
            optionsRef.current.notify(
              error instanceof Error ? error.message : '동기화 상태를 갱신하지 못했습니다.',
              'warning',
            );
          });
        }
        if (!mountedRef.current || runGenerationRef.current !== generation) return;
        if (!outcome.aborted && outcome.failed === 0) {
          setTasks((current) => current.filter((task) => task.batchId !== batchId));
          if (!backgroundedRunRef.current && outcome.lastImportedNovel) {
            await optionsRef.current.onOpenRequested?.(outcome.lastImportedNovel);
          }
        } else if (outcome.aborted) {
          setTasks((current) => current.filter((task) => task.batchId !== batchId));
        }

        if (queuedMergePlan && !outcome.aborted && outcome.failed === 0) {
          optionsRef.current.notify(
            queuedMergePlan.targetNovel
              ? `“${queuedMergePlan.targetNovel.title}”에 새 회차 ${queuedMergePlan.addCount}개를 추가했습니다.`
              : `“${queuedMergePlan.inspection.workTitle}”을(를) ${queuedMergePlan.addCount}개 회차로 추가했습니다.`,
            'success',
          );
        } else if (queuedSeriesPlan && outcome.completed > 0) {
          optionsRef.current.notify(
            `${outcome.completed}개 회차를 저장했습니다. ${outcome.aborted ? '취소한' : '실패한'} 회차부터 다시 추가할 수 있습니다.`,
            'warning',
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
          setTasks((current) =>
            cancelled
              ? current.filter((task) => task.batchId !== batchId)
              : current.map((task) =>
                  task.batchId === batchId && task.phase !== 'failed'
                    ? { ...task, phase: 'failed', percent: undefined, error: message }
                    : task,
                ),
          );
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
    const generation = seriesAnalysisGenerationRef.current;
    await duplicateInspectionRef.current;
    const draft = preparedDraftRef.current;
    if (
      !mountedRef.current ||
      busyRef.current ||
      generation !== seriesAnalysisGenerationRef.current ||
      draft?.generation !== generation ||
      draft.files !== pendingFiles
    )
      return;
    const files = [...draft.files];
    const policies = new Map(draft.conflicts.map((conflict) => [conflict.fileKey, conflict]));
    queuedResolutionRef.current = {
      policies,
      openExisting: draft.conflicts.find((conflict) => conflict.policy === 'open_existing')?.existingBook,
    };
    queuedSeriesPlanRef.current = draft.seriesPlan;
    queuedDocumentSeriesPlanRef.current = draft.documentSeriesPlan;
    cancelPreview();
    await importFiles(files);
    if (!mountedRef.current) return;
    if (!lastImportFailedRef.current) {
      // The target is only retained for retry, not for the next unrelated drop.
      if (draft.seriesPlan) {
        explicitSeriesTargetRef.current = undefined;
        setSeriesTargetNovelId(undefined);
      }
      setPendingFiles([]);
      setArchivePasswordState('');
      clearPreview();
    }
  }, [cancelPreview, clearPreview, importFiles, pendingFiles]);

  const previewPendingImport = useCallback(async () => {
    const file = pendingFiles[0];
    if (!file) return;
    await startPreview(file, encoding, chapterSplitMode, busyRef.current);
  }, [chapterSplitMode, encoding, pendingFiles, startPreview]);

  const cancelImport = useCallback(() => {
    seriesBuildAbortRef.current?.abort();
    cancellationRef.current.cancel();
    setTasks((current) =>
      current.map((task) => (task.phase === 'failed' ? task : { ...task, phase: 'cancelling', percent: undefined })),
    );
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
      if (nextEncoding !== encoding) invalidatePreparation();
      clearPreview();
      setEncodingState(nextEncoding);
    },
    [clearPreview, encoding, invalidatePreparation],
  );

  const setChapterSplitMode = useCallback(
    (mode: ChapterSplitMode) => {
      if (mode !== chapterSplitMode) invalidatePreparation();
      clearPreview();
      setChapterSplitModeState(mode);
    },
    [chapterSplitMode, clearPreview, invalidatePreparation],
  );

  const setDuplicatePolicy = useCallback((fileKey: string, policy: ImportDuplicatePolicy) => {
    if (preparedDraftRef.current) {
      preparedDraftRef.current = {
        ...preparedDraftRef.current,
        conflicts: preparedDraftRef.current.conflicts.map((conflict) =>
          conflict.fileKey === fileKey ? { ...conflict, policy } : conflict,
        ),
      };
    }
    setDuplicateConflicts((current) =>
      current.map((conflict) => (conflict.fileKey === fileKey ? { ...conflict, policy } : conflict)),
    );
  }, []);

  const setSeriesTargetNovel = useCallback(
    async (targetNovelId?: string) => {
      if ((!seriesInspection && !documentSeriesInspection) || seriesBusy || explicitSeriesTargetRef.current) return;
      const candidates = seriesInspection?.candidateNovels ?? documentSeriesInspection?.candidateNovels ?? [];
      const target = candidates.find((novel) => novel.id === targetNovelId);
      const generation = ++seriesAnalysisGenerationRef.current;
      preparedDraftRef.current = undefined;
      setSeriesTargetNovelId(target?.id);
      setSeriesBusy(true);
      setSeriesError(undefined);
      const preparation = (async () => {
        try {
          let nextSeriesPlan: LocalSeriesImportPlan | undefined;
          let nextDocumentSeriesPlan: LocalDocumentSeriesPlan | undefined;
          if (seriesInspection) {
            nextSeriesPlan = await planLocalSeriesForRuntime(seriesInspection, target, optionsRef.current);
          } else if (documentSeriesInspection) {
            const targetChapters = target ? await optionsRef.current.listChapters(target.id) : [];
            if (generation !== seriesAnalysisGenerationRef.current) return;
            nextDocumentSeriesPlan = await planLocalDocumentSeriesImport(
              documentSeriesInspection,
              target,
              targetChapters,
              optionsRef.current.assets,
            );
          }
          if (generation !== seriesAnalysisGenerationRef.current) return;
          preparedDraftRef.current = {
            generation,
            files: pendingFiles,
            conflicts: [],
            seriesPlan: nextSeriesPlan,
            documentSeriesPlan: nextDocumentSeriesPlan,
          };
          setSeriesPlan(nextSeriesPlan);
          setDocumentSeriesPlan(nextDocumentSeriesPlan);
        } catch (error) {
          if (generation !== seriesAnalysisGenerationRef.current) return;
          setSeriesPlan(undefined);
          setDocumentSeriesPlan(undefined);
          setSeriesError(error instanceof Error ? error.message : '회차 추가 계획을 만들지 못했습니다.');
        } finally {
          if (generation === seriesAnalysisGenerationRef.current) setSeriesBusy(false);
        }
      })();
      duplicateInspectionRef.current = preparation;
      await preparation;
    },
    [documentSeriesInspection, pendingFiles, seriesBusy, seriesInspection],
  );

  const setArchivePassword = useCallback(
    (password: string) => {
      if (password !== archivePassword) invalidatePreparation();
      setArchivePasswordState(password);
    },
    [archivePassword, invalidatePreparation],
  );

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
    tasks,
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
    dismissTask,
    setEncoding,
    setChapterSplitMode,
    setDuplicatePolicy,
    setSeriesTargetNovel,
    setArchivePassword,
    forgetUploadSession,
  };
}
