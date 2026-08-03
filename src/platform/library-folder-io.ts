import type { PlatformRuntimeInfo } from './runtime';
import { AndroidLibraryFolderIo } from './android/library-folder-io';
import type { TauriInvoke } from './android/document-io';
import type {
  LibraryFolderSourceEntry,
  LinkedLibraryFolder,
  PickedLibraryFolder,
  PlatformLibraryFolderIo,
  ScanLibraryFolderOptions,
} from '../library-folders/contracts';
import { LibraryFolderLocalStateStore } from '../library-folders/local-state';

interface PermissionAwareDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface IterableDirectoryHandle extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
}

type DirectoryPickerRuntime = typeof globalThis & {
  showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
};

async function ensureReadPermission(handle: FileSystemDirectoryHandle, request: boolean): Promise<boolean> {
  const permissionHandle = handle as PermissionAwareDirectoryHandle;
  if (!permissionHandle.queryPermission) return true;
  const current = await permissionHandle.queryPermission({ mode: 'read' });
  if (current === 'granted') return true;
  if (!request || !permissionHandle.requestPermission) return false;
  return (await permissionHandle.requestPermission({ mode: 'read' })) === 'granted';
}

async function listBrowserDirectory(
  directory: FileSystemDirectoryHandle,
  prefix: string,
  recursive: boolean,
  output: LibraryFolderSourceEntry[],
): Promise<void> {
  for await (const handle of (directory as IterableDirectoryHandle).values()) {
    const relativePath = prefix ? `${prefix}/${handle.name}` : handle.name;
    if (handle.kind === 'directory') {
      if (recursive) {
        await listBrowserDirectory(handle as FileSystemDirectoryHandle, relativePath, recursive, output);
      }
      continue;
    }
    const file = await (handle as FileSystemFileHandle).getFile();
    output.push({
      sourceKey: relativePath,
      relativePath,
      fileName: file.name,
      mimeType: file.type || undefined,
      byteLength: file.size,
      lastModified: file.lastModified,
    });
    if (output.length >= 20_000) throw new Error('한 폴더에서 확인할 수 있는 파일 수(20,000개)를 넘었습니다.');
  }
}

async function resolveBrowserFile(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemFileHandle> {
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error('폴더 파일 경로가 올바르지 않습니다.');
  let directory = root;
  for (const segment of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(segment);
  return directory.getFileHandle(parts[parts.length - 1]);
}

class BrowserLibraryFolderIo implements PlatformLibraryFolderIo {
  readonly providerKind = 'browser-directory' as const;

  constructor(private readonly state: LibraryFolderLocalStateStore) {}

  get available(): boolean {
    return typeof (globalThis as DirectoryPickerRuntime).showDirectoryPicker === 'function';
  }

  async pickFolder(): Promise<PickedLibraryFolder | undefined> {
    const picker = (globalThis as DirectoryPickerRuntime).showDirectoryPicker;
    if (!picker) throw new Error('이 환경에서는 폴더 선택을 지원하지 않습니다.');
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await picker({ id: 'noveldesk-library-folder', mode: 'read' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return undefined;
      throw error;
    }
    const id = globalThis.crypto?.randomUUID?.() ?? `folder-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await this.state.saveDirectoryHandle(id, handle);
    return { id, providerKind: this.providerKind, displayName: handle.name || '선택한 폴더' };
  }

  async scanFolder(
    folder: LinkedLibraryFolder,
    options: ScanLibraryFolderOptions,
  ): Promise<LibraryFolderSourceEntry[]> {
    const handle = await this.state.getDirectoryHandle(folder.id);
    if (!handle) throw new Error('폴더 연결 정보가 없습니다. 폴더를 다시 선택해 주세요.');
    if (!(await ensureReadPermission(handle, options.requestPermission))) {
      throw new Error('폴더를 다시 확인하려면 읽기 권한이 필요합니다.');
    }
    const entries: LibraryFolderSourceEntry[] = [];
    await listBrowserDirectory(handle, '', options.recursive, entries);
    return entries;
  }

  async readFile(folder: LinkedLibraryFolder, entry: LibraryFolderSourceEntry): Promise<File> {
    const handle = await this.state.getDirectoryHandle(folder.id);
    if (!handle) throw new Error('폴더 연결 정보가 없습니다.');
    if (!(await ensureReadPermission(handle, true))) throw new Error('파일을 읽을 권한이 없습니다.');
    return (await resolveBrowserFile(handle, entry.relativePath)).getFile();
  }

  async forgetFolder(folder: LinkedLibraryFolder): Promise<void> {
    await this.state.clearDirectoryHandle(folder.id);
  }
}

export function createPlatformLibraryFolderIo(
  runtime: PlatformRuntimeInfo,
  state: LibraryFolderLocalStateStore,
  invoke?: TauriInvoke,
): PlatformLibraryFolderIo {
  if (runtime.kind === 'tauri-mobile') return new AndroidLibraryFolderIo(invoke);
  return new BrowserLibraryFolderIo(state);
}
