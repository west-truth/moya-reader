import { describe, expect, it, vi } from 'vitest';
import type { PlatformRuntimeInfo } from '../runtime';
import { createPlatformDocumentIo } from '../document-io';
import { AndroidDocumentIo, type TauriInvoke } from './document-io';

const mobileRuntime: PlatformRuntimeInfo = {
  kind: 'tauri-mobile',
  hasTauri: true,
  isMobileWebView: true,
  userAgent: 'Android',
};

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

describe('Android document I/O adapter', () => {
  it('reassembles bounded native chunks into an unmodified File and releases the cache token', async () => {
    const source = new TextEncoder().encode('첫 문단\n두 번째 문단\n원문 끝');
    const calls: string[] = [];
    const invoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push(command);
      if (command === 'android_document_io_pick') {
        return {
          cancelled: false,
          documents: [
            {
              token: '00000000-0000-0000-0000-000000000001',
              fileName: '원문.txt',
              mimeType: 'text/plain',
              byteLength: source.byteLength,
              lastModified: 1234,
            },
          ],
        } as T;
      }
      if (command === 'android_document_io_read_chunk') {
        const request = args?.request as { offset: number };
        const end = Math.min(source.byteLength, request.offset + 7);
        return {
          dataBase64: base64(source.subarray(request.offset, end)),
          nextOffset: end,
          eof: end === source.byteLength,
        } as T;
      }
      if (command === 'android_document_io_release') return undefined as T;
      throw new Error(`unexpected command: ${command}`);
    };

    const files = await new AndroidDocumentIo(invoke).pickDocuments({
      multiple: true,
      mimeTypes: ['text/plain'],
      extensions: ['txt'],
    });

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('원문.txt');
    expect(files[0].type).toBe('text/plain');
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(source);
    expect(calls[0]).toBe('android_document_io_pick');
    expect(calls.at(-1)).toBe('android_document_io_release');
    expect(calls.filter((command) => command === 'android_document_io_read_chunk').length).toBeGreaterThan(1);
  });

  it('streams saves in bounded chunks and finalizes only after every byte is written', async () => {
    const source = new Uint8Array(400_000);
    for (let index = 0; index < source.length; index += 1) source[index] = index % 251;
    const written: Uint8Array[] = [];
    const invoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      if (command === 'android_document_io_begin_save') {
        return { cancelled: false, token: '00000000-0000-0000-0000-000000000002' } as T;
      }
      if (command === 'android_document_io_write_chunk') {
        const request = args?.request as { dataBase64: string };
        const chunk = Uint8Array.from(Buffer.from(request.dataBase64, 'base64'));
        written.push(chunk);
        return { bytesWritten: chunk.byteLength } as T;
      }
      if (command === 'android_document_io_finish_save') return undefined as T;
      throw new Error(`unexpected command: ${command}`);
    };
    const sourceBuffer = new ArrayBuffer(source.byteLength);
    new Uint8Array(sourceBuffer).set(source);

    const result = await new AndroidDocumentIo(invoke).saveDocument({
      suggestedName: 'backup.zip',
      mimeType: 'application/zip',
      blob: new Blob([sourceBuffer]),
    });

    expect(result).toBe('saved');
    expect(written.length).toBe(3);
    const reconstructed = Buffer.concat(written.map((chunk) => Buffer.from(chunk)));
    expect(reconstructed.equals(Buffer.from(source))).toBe(true);
  });

  it('keeps browser downloads on the existing anchor-style fallback', async () => {
    const triggerDownload = vi.fn();
    const revokeObjectUrl = vi.fn();
    const io = createPlatformDocumentIo(
      { ...mobileRuntime, kind: 'browser', hasTauri: false, isMobileWebView: false },
      {
        createObjectUrl: () => 'blob:test',
        revokeObjectUrl,
        triggerDownload,
        schedule: (callback) => callback(),
      },
    );

    await io.saveDocument({ suggestedName: '../unsafe:name.txt', mimeType: 'text/plain', blob: new Blob(['safe']) });

    expect(io.usesNativePicker).toBe(false);
    expect(triggerDownload).toHaveBeenCalledWith('blob:test', '.._unsafe_name.txt');
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test');
  });
});
