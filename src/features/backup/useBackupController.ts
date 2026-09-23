import { useCallback, useRef, useState } from 'react';
import type {
  BackupConflictResolution,
  BackupInspection,
  BackupRepository,
} from '../../repositories/backup-repository';
import type { ToastTone } from '../../shared/ui/ToastHost';
import type { PlatformDocumentIo } from '../../platform/document-io';

export interface BackupFeatureController {
  readonly open: boolean;
  readonly busy: boolean;
  readonly available: boolean;
  readonly inspection?: BackupInspection;
  readonly defaultResolution: BackupConflictResolution;
  readonly conflictResolutions: Readonly<Record<string, BackupConflictResolution>>;
  readonly usesPlatformPicker: boolean;
  openPanel(): void;
  closePanel(): void;
  exportBackup(): Promise<void>;
  pickBackupFile(): Promise<void>;
  inspectFile(file: File): Promise<void>;
  restoreBackup(): Promise<void>;
  setDefaultResolution(value: BackupConflictResolution): void;
  setConflictResolution(bookId: string, value: BackupConflictResolution): void;
}

export interface UseBackupControllerOptions {
  repository?: BackupRepository;
  documentIo?: PlatformDocumentIo;
  refreshLibrary(): Promise<unknown>;
  notify(message: string, tone?: ToastTone): void;
  onExported?(exportedAt: string): void;
}

function backupFileName(exportedAt: string): string {
  const stamp = exportedAt.replace(/[:.]/g, '-');
  return `moya-backup-${stamp}.zip`;
}

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
};

export function useBackupController(options: UseBackupControllerOptions): BackupFeatureController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const archiveRef = useRef<Blob>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<BackupInspection>();
  const [defaultResolution, setDefaultResolution] = useState<BackupConflictResolution>('skip');
  const [conflictResolutions, setConflictResolutions] = useState<Record<string, BackupConflictResolution>>({});

  const openPanel = useCallback(() => setOpen(true), []);
  const closePanel = useCallback(() => {
    if (busy) return;
    void optionsRef.current.repository?.discardInspection?.().catch(() => undefined);
    archiveRef.current = undefined;
    setInspection(undefined);
    setOpen(false);
  }, [busy]);

  const exportBackup = useCallback(async () => {
    const repository = optionsRef.current.repository;
    if (!repository || busy) return;
    setBusy(true);
    try {
      if (repository.createDownload && !optionsRef.current.documentIo?.usesNativeSave) {
        const pickerWindow = typeof window === 'undefined' ? undefined : (window as SavePickerWindow);
        const picker = pickerWindow?.showSaveFilePicker;
        if (picker && pickerWindow.isSecureContext) {
          // Ask while the button click still has user activation; the ticket and
          // server stream are created only after a destination is selected.
          const handle = await picker.call(pickerWindow, {
            suggestedName: 'moya-backup.zip',
            types: [{ description: '모야 백업 ZIP', accept: { 'application/zip': ['.zip'] } }],
          });
          const url = await repository.createDownload();
          const response = await fetch(url, { credentials: 'same-origin' });
          if (!response.ok || !response.body) throw new Error(`백업 다운로드에 실패했습니다. (${response.status})`);
          await response.body.pipeTo(await handle.createWritable());
          optionsRef.current.notify('백업 파일 저장을 완료했습니다.', 'success');
          optionsRef.current.onExported?.(new Date().toISOString());
          return;
        }
        const url = await repository.createDownload();
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'moya-backup.zip';
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        optionsRef.current.notify('백업 다운로드를 시작했습니다. 브라우저에서 완료 여부를 확인하세요.', 'info');
        // A started browser download is not proof of a completed backup.
        return;
      }
      const exported = await repository.exportBackup();
      const fileName = backupFileName(exported.manifest.exportedAt);
      const documentIo = optionsRef.current.documentIo;
      if (documentIo) {
        const result = await documentIo.saveDocument({
          suggestedName: fileName,
          mimeType: 'application/zip',
          blob: exported.blob,
        });
        if (result === 'cancelled') {
          optionsRef.current.notify('백업 저장을 취소했습니다.', 'info');
          return;
        }
      } else {
        const url = URL.createObjectURL(exported.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
      optionsRef.current.notify(`전체 백업 ${exported.manifest.books.length}권을 만들었습니다.`, 'success');
      optionsRef.current.onExported?.(exported.manifest.exportedAt);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        optionsRef.current.notify('백업 저장을 취소했습니다.', 'info');
      } else {
        optionsRef.current.notify(error instanceof Error ? error.message : '백업을 만들지 못했습니다.', 'danger');
      }
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const inspectFile = useCallback(
    async (file: File) => {
      const repository = optionsRef.current.repository;
      if (!repository || busy) return;
      setBusy(true);
      try {
        const next = await repository.inspectBackup(file);
        archiveRef.current = file;
        setInspection(next);
        setConflictResolutions({});
        optionsRef.current.notify(`백업 ${next.manifest.books.length}권을 확인했습니다.`, 'success');
      } catch (error) {
        archiveRef.current = undefined;
        setInspection(undefined);
        optionsRef.current.notify(
          error instanceof Error ? error.message : '백업 파일을 확인하지 못했습니다.',
          'danger',
        );
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const pickBackupFile = useCallback(async () => {
    const documentIo = optionsRef.current.documentIo;
    if (!documentIo?.usesNativePicker || busy) return;
    try {
      const files = await documentIo.pickDocuments({
        multiple: false,
        mimeTypes: ['application/zip', 'application/octet-stream'],
        extensions: ['zip'],
      });
      const file = files?.[0];
      if (file) await inspectFile(file);
    } catch (error) {
      optionsRef.current.notify(error instanceof Error ? error.message : '백업 파일을 선택하지 못했습니다.', 'danger');
    }
  }, [busy, inspectFile]);

  const restoreBackup = useCallback(async () => {
    const repository = optionsRef.current.repository;
    const archive = archiveRef.current;
    if (!repository || !archive || !inspection || busy) return;
    setBusy(true);
    try {
      const result = await repository.restoreBackup(archive, {
        defaultConflictResolution: defaultResolution,
        conflictResolutions,
      });
      await optionsRef.current.refreshLibrary();
      optionsRef.current.notify(
        `${result.restoredBooks}권을 복원했습니다.${result.skippedBooks ? ` ${result.skippedBooks}권은 건너뛰었습니다.` : ''}`,
        'success',
      );
      archiveRef.current = undefined;
      setInspection(undefined);
      setOpen(false);
    } catch (error) {
      optionsRef.current.notify(error instanceof Error ? error.message : '백업을 복원하지 못했습니다.', 'danger');
    } finally {
      setBusy(false);
    }
  }, [busy, conflictResolutions, defaultResolution, inspection]);

  const setConflictResolution = useCallback((bookId: string, value: BackupConflictResolution) => {
    setConflictResolutions((current) => ({ ...current, [bookId]: value }));
  }, []);

  return {
    open,
    busy,
    available: Boolean(options.repository),
    inspection,
    defaultResolution,
    conflictResolutions,
    usesPlatformPicker: Boolean(options.documentIo?.usesNativePicker),
    openPanel,
    closePanel,
    exportBackup,
    pickBackupFile,
    inspectFile,
    restoreBackup,
    setDefaultResolution,
    setConflictResolution,
  };
}
