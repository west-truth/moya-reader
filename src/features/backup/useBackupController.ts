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
}

function backupFileName(exportedAt: string): string {
  const stamp = exportedAt.replace(/[:.]/g, '-');
  return `moya-backup-${stamp}.zip`;
}

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
    setOpen(false);
  }, [busy]);

  const exportBackup = useCallback(async () => {
    const repository = optionsRef.current.repository;
    if (!repository || busy) return;
    setBusy(true);
    try {
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
    } catch (error) {
      optionsRef.current.notify(error instanceof Error ? error.message : '백업을 만들지 못했습니다.', 'danger');
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
