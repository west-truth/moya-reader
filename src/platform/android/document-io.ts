import type { PickDocumentsOptions, PlatformDocumentIo, SaveDocumentInput, SaveDocumentResult } from '../document-io';

const DOCUMENT_CHUNK_BYTES = 192 * 1024;

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface AndroidDocumentDescriptor {
  readonly token: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly lastModified: number;
}

interface AndroidPickDocumentsResponse {
  readonly cancelled: boolean;
  readonly documents: readonly AndroidDocumentDescriptor[];
}

interface AndroidReadChunkResponse {
  readonly dataBase64: string;
  readonly nextOffset: number;
  readonly eof: boolean;
}

interface AndroidBeginSaveResponse {
  readonly cancelled: boolean;
  readonly token?: string;
}

interface AndroidWriteChunkResponse {
  readonly bytesWritten: number;
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

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const blockBytes = 8 * 1024;
  for (let offset = 0; offset < bytes.length; offset += blockBytes) {
    const block = bytes.subarray(offset, Math.min(bytes.length, offset + blockBytes));
    binary += String.fromCharCode(...block);
  }
  return globalThis.btoa(binary);
}

function validFileLength(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('선택한 파일의 크기를 확인하지 못했습니다.');
  return value;
}

export class AndroidDocumentIo implements PlatformDocumentIo {
  readonly usesNativePicker = true;
  readonly usesNativeSave = true;

  constructor(private readonly injectedInvoke?: TauriInvoke) {}

  async pickDocuments(options: PickDocumentsOptions): Promise<File[]> {
    const invoke = await this.invoke();
    const response = await invoke<AndroidPickDocumentsResponse>('android_document_io_pick', {
      request: {
        multiple: options.multiple ?? false,
        mimeTypes: [...options.mimeTypes],
        extensions: [...options.extensions],
      },
    });
    if (response.cancelled) return [];

    const files: File[] = [];
    for (const document of response.documents) {
      const parts: BlobPart[] = [];
      const byteLength = validFileLength(document.byteLength);
      let offset = 0;
      try {
        while (offset < byteLength) {
          const chunk = await invoke<AndroidReadChunkResponse>('android_document_io_read_chunk', {
            request: { token: document.token, offset, maxBytes: DOCUMENT_CHUNK_BYTES },
          });
          const bytes = decodeBase64(chunk.dataBase64);
          if (bytes.byteLength === 0 && !chunk.eof) throw new Error('선택한 파일을 읽는 중 진행이 멈췄습니다.');
          if (chunk.nextOffset !== offset + bytes.byteLength || chunk.nextOffset > byteLength) {
            throw new Error('선택한 파일을 읽는 중 위치가 일치하지 않습니다.');
          }
          const part = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(part).set(bytes);
          parts.push(part);
          offset = chunk.nextOffset;
          if (chunk.eof && offset !== byteLength) throw new Error('선택한 파일을 끝까지 읽지 못했습니다.');
        }
        files.push(
          new File(parts, document.fileName, {
            type: document.mimeType || 'application/octet-stream',
            lastModified: document.lastModified,
          }),
        );
      } finally {
        await invoke<void>('android_document_io_release', { request: { token: document.token } }).catch(
          () => undefined,
        );
      }
    }
    return files;
  }

  async saveDocument(input: SaveDocumentInput): Promise<SaveDocumentResult> {
    const invoke = await this.invoke();
    const response = await invoke<AndroidBeginSaveResponse>('android_document_io_begin_save', {
      request: { suggestedName: input.suggestedName, mimeType: input.mimeType },
    });
    if (response.cancelled || !response.token) return 'cancelled';

    const token = response.token;
    let offset = 0;
    try {
      while (offset < input.blob.size) {
        const buffer = await input.blob.slice(offset, offset + DOCUMENT_CHUNK_BYTES).arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const result = await invoke<AndroidWriteChunkResponse>('android_document_io_write_chunk', {
          request: { token, dataBase64: encodeBase64(bytes) },
        });
        if (result.bytesWritten !== bytes.byteLength)
          throw new Error('파일을 저장하는 중 일부 데이터가 누락되었습니다.');
        offset += bytes.byteLength;
      }
      await invoke<void>('android_document_io_finish_save', { request: { token } });
      return 'saved';
    } catch (error) {
      await invoke<void>('android_document_io_abort_save', { request: { token } }).catch(() => undefined);
      throw error;
    }
  }

  private async invoke(): Promise<TauriInvoke> {
    return this.injectedInvoke ?? loadDefaultInvoke();
  }
}
