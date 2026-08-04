import { describe, expect, it, vi } from 'vitest';
import type { LinkedLibraryFolder } from '../../library-folders/contracts';
import type { TauriInvoke } from './document-io';
import { AndroidLibraryFolderIo } from './library-folder-io';

const folder: LinkedLibraryFolder = {
  id: '11111111-1111-1111-1111-111111111111',
  providerKind: 'android-saf',
  displayName: 'Novels',
  filter: { formats: ['text', 'epub'], recursive: true },
  autoSync: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

describe('AndroidLibraryFolderIo', () => {
  it('picks and scans a persisted SAF tree', async () => {
    const invokeMock = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
      if (command === 'android_document_io_pick_folder') {
        return { cancelled: false, folderId: folder.id, displayName: 'Novels' };
      }
      if (command === 'android_document_io_scan_folder') {
        return {
          entries: [
            {
              documentId: 'primary:Novels/book.epub',
              relativePath: 'sub/book.epub',
              fileName: 'book.epub',
              mimeType: 'application/epub+zip',
              byteLength: 12,
              lastModified: 123,
            },
          ],
        };
      }
      throw new Error(`unexpected command ${command}`);
    });
    const invoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>) =>
      (await invokeMock(command, args)) as T;
    const io = new AndroidLibraryFolderIo(invoke);

    await expect(io.pickFolder()).resolves.toMatchObject({ id: folder.id, providerKind: 'android-saf' });
    await expect(io.scanFolder(folder, { recursive: true, requestPermission: false })).resolves.toEqual([
      {
        sourceKey: 'primary:Novels/book.epub',
        relativePath: 'sub/book.epub',
        fileName: 'book.epub',
        mimeType: 'application/epub+zip',
        byteLength: 12,
        lastModified: 123,
      },
    ]);
    expect(invokeMock).toHaveBeenCalledWith('android_document_io_scan_folder', {
      request: { folderId: folder.id, recursive: true, maxEntries: 20_000 },
    });
  });

  it('streams a selected folder entry through the existing chunk bridge', async () => {
    const invokeMock = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
      if (command === 'android_document_io_open_folder_file') {
        return {
          document: {
            token: '22222222-2222-2222-2222-222222222222',
            fileName: 'book.txt',
            mimeType: 'text/plain',
            byteLength: 3,
            lastModified: 123,
          },
        };
      }
      if (command === 'android_document_io_read_chunk') {
        return { dataBase64: 'YWJj', nextOffset: 3, eof: true };
      }
      if (command === 'android_document_io_release') return undefined;
      throw new Error(`unexpected command ${command}`);
    });
    const invoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>) =>
      (await invokeMock(command, args)) as T;
    const io = new AndroidLibraryFolderIo(invoke);
    const file = await io.readFile(folder, {
      sourceKey: 'primary:Novels/book.txt',
      relativePath: 'book.txt',
      fileName: 'book.txt',
      byteLength: 3,
      lastModified: 123,
    });

    expect(file.name).toBe('book.txt');
    expect(await file.text()).toBe('abc');
    expect(invokeMock).toHaveBeenLastCalledWith('android_document_io_release', {
      request: { token: '22222222-2222-2222-2222-222222222222' },
    });
  });
});
