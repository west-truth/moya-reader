import { sha256 } from '../domain/hash';
import {
  CLOUD_VAULT_FILE_NAME,
  CloudVaultWriteConflictError,
  type CloudVaultFileProvider,
  type CloudVaultStoredObject,
} from './contracts';

interface PermissionAwareDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

function taggedHash(value: string): string {
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

async function revision(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return taggedHash(await sha256(buffer));
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

export async function ensureDirectoryPermission(handle: FileSystemDirectoryHandle, request = false): Promise<boolean> {
  const permissionHandle = handle as PermissionAwareDirectoryHandle;
  if (!permissionHandle.queryPermission) return true;
  const current = await permissionHandle.queryPermission({ mode: 'readwrite' });
  if (current === 'granted') return true;
  if (!request || !permissionHandle.requestPermission) return false;
  return (await permissionHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export class DirectoryCloudVaultProvider implements CloudVaultFileProvider {
  readonly kind = 'directory' as const;

  constructor(private readonly handle: FileSystemDirectoryHandle) {}

  get label(): string {
    return this.handle.name || '동기화 폴더';
  }

  async read(): Promise<CloudVaultStoredObject | undefined> {
    if (!(await ensureDirectoryPermission(this.handle))) {
      throw new Error('Cloud vault folder permission must be granted again.');
    }
    try {
      const fileHandle = await this.handle.getFileHandle(CLOUD_VAULT_FILE_NAME);
      const file = await fileHandle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { bytes, revision: await revision(bytes) };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async write(bytes: Uint8Array, expectedRevision?: string): Promise<{ revision: string }> {
    if (!(await ensureDirectoryPermission(this.handle, true))) {
      throw new Error('Cloud vault folder write permission was not granted.');
    }
    const current = await this.read();
    if ((expectedRevision && current?.revision !== expectedRevision) || (!expectedRevision && current)) {
      throw new CloudVaultWriteConflictError();
    }
    const fileHandle = await this.handle.getFileHandle(CLOUD_VAULT_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(bytes as unknown as FileSystemWriteChunkType);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    return { revision: await revision(bytes) };
  }
}

export function directoryPickerAvailable(): boolean {
  return (
    typeof (globalThis as typeof globalThis & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

export async function pickCloudVaultDirectory(): Promise<FileSystemDirectoryHandle> {
  const runtime = globalThis as typeof globalThis & {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  };
  if (!runtime.showDirectoryPicker) throw new Error('This environment does not support selecting a sync folder.');
  return runtime.showDirectoryPicker({ id: 'noveldesk-cloud-vault', mode: 'readwrite' });
}
