import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Novel } from '../../domain/types';
import { sha256 } from '../../domain/hash';
import type { ToastTone } from '../../shared/ui/ToastHost';
import type { ImportProgress, ImportService } from '../../services/import/import-service';
import { hashBlobInChunks } from '../../services/import/chunked-file-reader';
import {
  DEFAULT_LIBRARY_FOLDER_FILTER,
  libraryFolderEntryId,
  libraryFolderEntrySignature,
  libraryFolderFormatForName,
  type LibraryFolderCandidate,
  type LibraryFolderFilter,
  type LibraryFolderSourceEntry,
  type LinkedLibraryFolder,
  type PlatformLibraryFolderIo,
  type StoredLibraryFolderEntry,
} from '../../library-folders/contracts';
import { LibraryFolderLocalStateStore } from '../../library-folders/local-state';
import { reconcileLibraryFolderScan } from '../../library-folders/reconcile';

const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1_000;

export interface LibraryFolderImportProgress {
  readonly current: number;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly linkedExisting: number;
  readonly fileName?: string;
  readonly detail?: ImportProgress;
}

export interface LibraryFolderController {
  readonly open: boolean;
  readonly available: boolean;
  readonly busy: boolean;
  readonly scanning: boolean;
  readonly folders: readonly LinkedLibraryFolder[];
  readonly activeFolder?: LinkedLibraryFolder;
  readonly candidates: readonly LibraryFolderCandidate[];
  readonly progress?: LibraryFolderImportProgress;
  show(): void;
  close(): void;
  pickFolder(): Promise<void>;
  selectFolder(folderId: string): Promise<void>;
  scanActiveFolder(): Promise<void>;
  updateFilter(patch: Partial<LibraryFolderFilter>): Promise<void>;
  setAutoSync(enabled: boolean): Promise<void>;
  toggleCandidate(id: string): void;
  selectAllActionable(selected: boolean): void;
  importSelected(): Promise<void>;
  removeActiveFolder(): Promise<void>;
  cancel(): void;
}

export interface UseLibraryFolderControllerOptions {
  readonly io: PlatformLibraryFolderIo;
  readonly state: LibraryFolderLocalStateStore;
  readonly importService: ImportService;
  getNovel(id: string): Promise<Novel | undefined>;
  listNovels(): Promise<Novel[]>;
  onLibraryChanged(): Promise<void>;
  notify(message: string, tone?: ToastTone): void;
}

function actionable(candidate: LibraryFolderCandidate): boolean {
  return candidate.status === 'new' || candidate.status === 'changed' || candidate.status === 'update-existing';
}

function currentIso(): string {
  return new Date().toISOString();
}

function importedEntry(
  folder: LinkedLibraryFolder,
  candidate: LibraryFolderCandidate,
  bookId: string | undefined,
  contentHash: string | undefined,
  previous: StoredLibraryFolderEntry | undefined,
): StoredLibraryFolderEntry {
  const now = currentIso();
  return {
    sourceKey: candidate.sourceKey,
    relativePath: candidate.relativePath,
    fileName: candidate.fileName,
    mimeType: candidate.mimeType,
    byteLength: candidate.byteLength,
    lastModified: candidate.lastModified,
    id: libraryFolderEntryId(folder.id, candidate.sourceKey),
    folderId: folder.id,
    signature: libraryFolderEntrySignature(candidate),
    bookId,
    contentHash,
    status: 'linked',
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastImportedAt: now,
  };
}

function sameQuickIdentity(source: LibraryFolderSourceEntry, stored: StoredLibraryFolderEntry): boolean {
  return source.byteLength === stored.byteLength && source.lastModified === stored.lastModified;
}

function extension(fileName: string): string {
  return fileName.split('.').pop()?.toLocaleLowerCase() ?? '';
}

function eligibleForFolder(folder: LinkedLibraryFolder, source: LibraryFolderSourceEntry): boolean {
  const format = libraryFolderFormatForName(source.fileName);
  if (!format || !folder.filter.formats.includes(format)) return false;
  if (folder.filter.minBytes !== undefined && source.byteLength < folder.filter.minBytes) return false;
  if (folder.filter.maxBytes !== undefined && source.byteLength > folder.filter.maxBytes) return false;
  return true;
}

export async function enrichScannedLibraryFolderEntries(input: {
  readonly folder: LinkedLibraryFolder;
  readonly sourceEntries: readonly LibraryFolderSourceEntry[];
  readonly storedEntries: readonly StoredLibraryFolderEntry[];
  readonly io: Pick<PlatformLibraryFolderIo, 'readFile'>;
}): Promise<LibraryFolderSourceEntry[]> {
  const storedByKey = new Map(input.storedEntries.map((entry) => [entry.sourceKey, entry]));
  const sourceKeys = new Set(input.sourceEntries.map((entry) => entry.sourceKey));
  const missingWithHash = input.storedEntries.filter(
    (entry) => !sourceKeys.has(entry.sourceKey) && entry.bookId && entry.contentHash,
  );
  const enriched: LibraryFolderSourceEntry[] = [];

  for (const source of input.sourceEntries) {
    if (source.contentHash || !eligibleForFolder(input.folder, source)) {
      enriched.push(source);
      continue;
    }
    const stored = storedByKey.get(source.sourceKey);
    const verifiesSameMetadata = Boolean(stored?.bookId && sameQuickIdentity(source, stored));
    const verifiesPossibleRename =
      !stored &&
      missingWithHash.some(
        (missing) =>
          missing.byteLength === source.byteLength && extension(missing.fileName) === extension(source.fileName),
      );
    if (!verifiesSameMetadata && !verifiesPossibleRename) {
      enriched.push(source);
      continue;
    }

    try {
      const file = await input.io.readFile(input.folder, source);
      enriched.push({
        ...source,
        byteLength: file.size,
        lastModified: typeof file.lastModified === 'number' ? file.lastModified : source.lastModified,
        contentHash: await hashBlobInChunks(file),
        readError: undefined,
      });
    } catch (error) {
      enriched.push({
        ...source,
        readError: error instanceof Error ? error.message : '파일 내용을 확인하지 못했습니다.',
      });
    }
  }
  return enriched;
}

export function useLibraryFolderController(options: UseLibraryFolderControllerOptions): LibraryFolderController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<LinkedLibraryFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string>();
  const [candidates, setCandidates] = useState<LibraryFolderCandidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<LibraryFolderImportProgress>();
  const activeImportRef = useRef<ReturnType<ImportService['importFile']>>();
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const activeFolder = useMemo(() => folders.find((folder) => folder.id === activeFolderId), [activeFolderId, folders]);

  const refreshFolders = useCallback(async () => {
    const next = (await optionsRef.current.state.listFolders()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
    if (!mountedRef.current) return next;
    setFolders(next);
    setActiveFolderId((current) => (current && next.some((folder) => folder.id === current) ? current : next[0]?.id));
    return next;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshFolders();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeImportRef.current?.cancel();
    };
  }, [refreshFolders]);

  const performScan = useCallback(
    async (folder: LinkedLibraryFolder, requestPermission: boolean) => {
      const scanGeneration = generationRef.current + 1;
      generationRef.current = scanGeneration;
      if (mountedRef.current) setScanning(true);
      const scannedAt = currentIso();
      try {
        const [sourceEntries, storedEntries, novels] = await Promise.all([
          optionsRef.current.io.scanFolder(folder, { requestPermission, recursive: folder.filter.recursive }),
          optionsRef.current.state.listEntries(folder.id),
          optionsRef.current.listNovels(),
        ]);
        const fingerprintedEntries = await enrichScannedLibraryFolderEntries({
          folder,
          sourceEntries,
          storedEntries,
          io: optionsRef.current.io,
        });
        const reconciled = reconcileLibraryFolderScan({
          folder,
          sourceEntries: fingerprintedEntries,
          storedEntries,
          novels,
          scannedAt,
        });
        await optionsRef.current.state.saveEntries(reconciled.observedEntries);
        await Promise.all(reconciled.retiredEntryIds.map((id) => optionsRef.current.state.deleteEntry(id)));
        const updated: LinkedLibraryFolder = {
          ...folder,
          lastScanAt: scannedAt,
          lastError: undefined,
          updatedAt: scannedAt,
        };
        await optionsRef.current.state.saveFolder(updated);
        if (mountedRef.current && generationRef.current === scanGeneration) {
          setCandidates([...reconciled.candidates]);
          await refreshFolders();
        }
        return { folder: updated, candidates: reconciled.candidates, storedEntries };
      } catch (error) {
        const message = error instanceof Error ? error.message : '폴더를 확인하지 못했습니다.';
        const updated = { ...folder, lastError: message, updatedAt: scannedAt };
        await optionsRef.current.state.saveFolder(updated).catch(() => undefined);
        if (mountedRef.current && generationRef.current === scanGeneration) await refreshFolders();
        if (requestPermission) optionsRef.current.notify(message, 'warning');
        return undefined;
      } finally {
        if (mountedRef.current && generationRef.current === scanGeneration) setScanning(false);
      }
    },
    [refreshFolders],
  );

  const importCandidates = useCallback(
    async (folder: LinkedLibraryFolder, requestedCandidates: readonly LibraryFolderCandidate[], announce: boolean) => {
      const work = requestedCandidates.filter(actionable);
      if (work.length === 0 || busyRef.current) return;
      busyRef.current = true;
      if (mountedRef.current) {
        setBusy(true);
        setProgress({ current: 0, total: work.length, completed: 0, failed: 0, linkedExisting: 0 });
      }
      let completed = 0;
      let failed = 0;
      let linkedExisting = 0;
      const knownNovels = await optionsRef.current.listNovels();
      const storedByKey = new Map(
        (await optionsRef.current.state.listEntries(folder.id)).map((entry) => [entry.sourceKey, entry]),
      );
      try {
        for (const [index, candidate] of work.entries()) {
          if (!busyRef.current) break;
          if (mountedRef.current) {
            setProgress({
              current: index + 1,
              total: work.length,
              completed,
              failed,
              linkedExisting,
              fileName: candidate.fileName,
            });
          }
          try {
            const file = await optionsRef.current.io.readFile(folder, candidate);
            let targetBookId = candidate.bookId;
            let sourceHash: string | undefined;
            if (!targetBookId) {
              sourceHash = await sha256(await file.arrayBuffer());
              const exact = knownNovels.find(
                (novel) =>
                  novel.rawTextHash.toLocaleLowerCase() === sourceHash?.toLocaleLowerCase() ||
                  novel.sourceContentHash?.replace(/^sha256:/, '').toLocaleLowerCase() ===
                    sourceHash?.toLocaleLowerCase(),
              );
              if (exact) {
                targetBookId = exact.id;
                linkedExisting += 1;
                await optionsRef.current.state.saveEntries([
                  importedEntry(folder, candidate, exact.id, sourceHash, storedByKey.get(candidate.sourceKey)),
                ]);
                continue;
              }
            }

            const controller = optionsRef.current.importService.importFile(
              {
                file,
                encoding: 'auto',
                chapterSplitMode: 'auto',
                clientBookId: targetBookId,
              },
              (detail) => {
                if (!mountedRef.current) return;
                setProgress({
                  current: index + 1,
                  total: work.length,
                  completed,
                  failed,
                  linkedExisting,
                  fileName: candidate.fileName,
                  detail,
                });
              },
            );
            activeImportRef.current = controller;
            const result = await controller.promise;
            activeImportRef.current = undefined;
            const novel = (await optionsRef.current.getNovel(result.novel.id)) ?? result.novel;
            knownNovels.push(novel);
            await optionsRef.current.state.saveEntries([
              importedEntry(
                folder,
                candidate,
                novel.id,
                novel.sourceContentHash ?? novel.rawTextHash ?? sourceHash,
                storedByKey.get(candidate.sourceKey),
              ),
            ]);
            completed += 1;
          } catch (error) {
            activeImportRef.current = undefined;
            if (!busyRef.current) break;
            failed += 1;
            const previous = storedByKey.get(candidate.sourceKey);
            const now = currentIso();
            await optionsRef.current.state.saveEntries([
              {
                ...(previous ?? importedEntry(folder, candidate, candidate.bookId, undefined, undefined)),
                ...candidate,
                id: libraryFolderEntryId(folder.id, candidate.sourceKey),
                folderId: folder.id,
                signature: libraryFolderEntrySignature(candidate),
                status: 'failed',
                firstSeenAt: previous?.firstSeenAt ?? now,
                lastSeenAt: now,
                error: error instanceof Error ? error.message : '가져오기에 실패했습니다.',
              },
            ]);
          }
        }
        await optionsRef.current.onLibraryChanged();
        await performScan(folder, false);
        if (announce) {
          const importedCount = completed + linkedExisting;
          optionsRef.current.notify(
            failed ? `${importedCount}권 처리 완료, ${failed}권 실패` : `${importedCount}권을 폴더와 연결했습니다.`,
            failed ? 'warning' : 'success',
          );
        }
      } finally {
        activeImportRef.current = undefined;
        busyRef.current = false;
        if (mountedRef.current) {
          setBusy(false);
          setProgress((current) =>
            current ? { ...current, completed, failed, linkedExisting, current: work.length } : current,
          );
        }
      }
    },
    [performScan],
  );

  const syncAutomaticFolders = useCallback(async () => {
    if (busyRef.current || document.visibilityState === 'hidden') return;
    const currentFolders = await optionsRef.current.state.listFolders();
    for (const folder of currentFolders.filter((item) => item.autoSync)) {
      if (busyRef.current) return;
      const result = await performScan(folder, false);
      if (!result) continue;
      const changes = result.candidates.filter(actionable);
      if (changes.length) await importCandidates(result.folder, changes, false);
    }
  }, [importCandidates, performScan]);

  useEffect(() => {
    const initial = window.setTimeout(() => void syncAutomaticFolders(), 1_500);
    const interval = window.setInterval(() => void syncAutomaticFolders(), AUTO_SYNC_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void syncAutomaticFolders();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [syncAutomaticFolders]);

  const show = useCallback(() => {
    setOpen(true);
    void refreshFolders().then((next) => {
      const folder = next.find((item) => item.id === activeFolderId) ?? next[0];
      if (folder) void performScan(folder, true);
    });
  }, [activeFolderId, performScan, refreshFolders]);

  const close = useCallback(() => {
    if (!busyRef.current) {
      setOpen(false);
      setProgress(undefined);
    }
  }, []);

  const pickFolder = useCallback(async () => {
    if (!optionsRef.current.io.available || busyRef.current) return;
    try {
      const picked = await optionsRef.current.io.pickFolder();
      if (!picked) return;
      const now = currentIso();
      const folder: LinkedLibraryFolder = {
        ...picked,
        filter: DEFAULT_LIBRARY_FOLDER_FILTER,
        autoSync: false,
        createdAt: now,
        updatedAt: now,
      };
      await optionsRef.current.state.saveFolder(folder);
      await refreshFolders();
      setActiveFolderId(folder.id);
      setCandidates([]);
      setOpen(true);
      await performScan(folder, true);
    } catch (error) {
      optionsRef.current.notify(error instanceof Error ? error.message : '폴더를 선택하지 못했습니다.', 'danger');
    }
  }, [performScan, refreshFolders]);

  const selectFolder = useCallback(
    async (folderId: string) => {
      const folder = folders.find((item) => item.id === folderId);
      if (!folder || busyRef.current) return;
      setActiveFolderId(folderId);
      setCandidates([]);
      await performScan(folder, true);
    },
    [folders, performScan],
  );

  const scanActiveFolder = useCallback(async () => {
    if (activeFolder && !busyRef.current) await performScan(activeFolder, true);
  }, [activeFolder, performScan]);

  const updateActiveFolder = useCallback(
    async (patch: Partial<LinkedLibraryFolder>) => {
      if (!activeFolder) return undefined;
      const updated = { ...activeFolder, ...patch, updatedAt: currentIso() };
      await optionsRef.current.state.saveFolder(updated);
      await refreshFolders();
      return updated;
    },
    [activeFolder, refreshFolders],
  );

  const updateFilter = useCallback(
    async (patch: Partial<LibraryFolderFilter>) => {
      if (!activeFolder || busyRef.current) return;
      const updated = await updateActiveFolder({ filter: { ...activeFolder.filter, ...patch } });
      if (updated) await performScan(updated, true);
    },
    [activeFolder, performScan, updateActiveFolder],
  );

  const setAutoSync = useCallback(
    async (enabled: boolean) => {
      await updateActiveFolder({ autoSync: enabled });
    },
    [updateActiveFolder],
  );

  const toggleCandidate = useCallback((id: string) => {
    setCandidates((current) =>
      current.map((candidate) =>
        candidate.id === id && actionable(candidate) ? { ...candidate, selected: !candidate.selected } : candidate,
      ),
    );
  }, []);

  const selectAllActionable = useCallback((selected: boolean) => {
    setCandidates((current) =>
      current.map((candidate) => (actionable(candidate) ? { ...candidate, selected } : candidate)),
    );
  }, []);

  const importSelected = useCallback(async () => {
    if (!activeFolder) return;
    await importCandidates(
      activeFolder,
      candidates.filter((candidate) => candidate.selected),
      true,
    );
  }, [activeFolder, candidates, importCandidates]);

  const removeActiveFolder = useCallback(async () => {
    if (!activeFolder || busyRef.current) return;
    await optionsRef.current.io.forgetFolder(activeFolder).catch(() => undefined);
    await optionsRef.current.state.deleteFolder(activeFolder.id);
    setCandidates([]);
    await refreshFolders();
    optionsRef.current.notify('폴더 연결을 해제했습니다. 가져온 책은 그대로 유지됩니다.', 'info');
  }, [activeFolder, refreshFolders]);

  const cancel = useCallback(() => {
    busyRef.current = false;
    activeImportRef.current?.cancel();
  }, []);

  return {
    open,
    available: options.io.available,
    busy,
    scanning,
    folders,
    activeFolder,
    candidates,
    progress,
    show,
    close,
    pickFolder,
    selectFolder,
    scanActiveFolder,
    updateFilter,
    setAutoSync,
    toggleCandidate,
    selectAllActionable,
    importSelected,
    removeActiveFolder,
    cancel,
  };
}
