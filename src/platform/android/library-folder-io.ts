import type {
  LibraryFolderSourceEntry,
  LinkedLibraryFolder,
  PickedLibraryFolder,
  PlatformLibraryFolderIo,
  ScanLibraryFolderOptions,
} from '../../library-folders/contracts';
import type { TauriInvoke } from './document-io';

const DOCUMENT_CHUNK_BYTES = 192 * 1024;

interface AndroidPickedFolderResponse {
  readonly cancelled: boolean;
  readonly folderId?: string;
  readonly displayName?: string;
}

interface AndroidFolderEntry {
  readonly documentId: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly byteLength: number;
  readonly lastModified: number;
}

interface AndroidScanFolderResponse {
  readonly entries: readonly AndroidFolderEntry[];
}

interface AndroidDocumentDescriptor {
  readonly token: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly lastModified: number;
}

interface AndroidReadFolderFileResponse {
  readonly document: AndroidDocumentDescriptor;
}

interface AndroidReadChunkResponse {
  readonly dataBase64: string;
  readonly nextOffset: number;
  readonly eof: boolean;
}

async function loadDefaultInvoke(): Promise<TauriInvoke> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as TauriInvoke;
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export class AndroidLibraryFolderIo implements PlatformLibraryFolderIo {
  readonly available = true;
  readonly providerKind = 'android-saf' as const;

  constructor(private readonly injectedInvoke?: TauriInvoke) {}

  async pickFolder(): Promise<PickedLibraryFolder | undefined> {
    const invoke = await this.invoke();
    const response = await invoke<AndroidPickedFolderResponse>('android_document_io_pick_folder');
    if (response.cancelled || !response.folderId) return undefined;
    return {
      id: response.folderId,
      providerKind: this.providerKind,
      displayName: response.displayName?.trim() || '선택한 폴더',
    };
  }

  async scanFolder(
    folder: LinkedLibraryFolder,
    options: ScanLibraryFolderOptions,
  ): Promise<LibraryFolderSourceEntry[]> {
    const invoke = await this.invoke();
    const response = await invoke<AndroidScanFolderResponse>('android_document_io_scan_folder', {
      request: { folderId: folder.id, recursive: options.recursive, maxEntries: 20_000 },
    });
    return response.entries.map((entry) => ({
      sourceKey: entry.documentId,
      relativePath: entry.relativePath,
      fileName: entry.fileName,
      mimeType: entry.mimeType,
      byteLength: entry.byteLength,
      lastModified: entry.lastModified,
    }));
  }

  async readFile(folder: LinkedLibraryFolder, entry: LibraryFolderSourceEntry): Promise<File> {
    const invoke = await this.invoke();
    const response = await invoke<AndroidReadFolderFileResponse>('android_document_io_open_folder_file', {
      request: { folderId: folder.id, documentId: entry.sourceKey },
    });
    const document = response.document;
    const parts: BlobPart[] = [];
    let offset = 0;
    try {
      while (offset < document.byteLength) {
        const chunk = await invoke<AndroidReadChunkResponse>('android_document_io_read_chunk', {
          request: { token: document.token, offset, maxBytes: DOCUMENT_CHUNK_BYTES },
        });
        const bytes = decodeBase64(chunk.dataBase64);
        if (bytes.byteLength === 0 && !chunk.eof) throw new Error('폴더 파일을 읽는 중 진행이 멈췄습니다.');
        if (chunk.nextOffset !== offset + bytes.byteLength || chunk.nextOffset > document.byteLength) {
          throw new Error('폴더 파일을 읽는 중 위치가 일치하지 않습니다.');
        }
        const part = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(part).set(bytes);
        parts.push(part);
        offset = chunk.nextOffset;
      }
      return new File(parts, document.fileName, {
        type: document.mimeType || 'application/octet-stream',
        lastModified: document.lastModified,
      });
    } finally {
      await invoke<void>('android_document_io_release', { request: { token: document.token } }).catch(() => undefined);
    }
  }

  async forgetFolder(folder: LinkedLibraryFolder): Promise<void> {
    const invoke = await this.invoke();
    await invoke<void>('android_document_io_forget_folder', { request: { folderId: folder.id } });
  }

  private async invoke(): Promise<TauriInvoke> {
    return this.injectedInvoke ?? loadDefaultInvoke();
  }
}
