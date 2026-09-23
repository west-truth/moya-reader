import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { BackupInspection, BackupRepository } from '../../repositories/backup-repository';
import { useBackupController, type BackupFeatureController } from './useBackupController';
import type { PlatformDocumentIo } from '../../platform/document-io';

describe('backup conflict defaults', () => {
  it('streams the server ZIP into a selected file and confirms completion', async () => {
    const steps: string[] = [];
    const chunks: Uint8Array[] = [];
    vi.stubGlobal('window', {
      isSecureContext: true,
      showSaveFilePicker: async () => {
        steps.push('picker');
        return {
          createWritable: async () =>
            new WritableStream<Uint8Array>({
              write(chunk) {
                steps.push('write');
                chunks.push(chunk);
              },
              close() {
                steps.push('close');
              },
            }),
        };
      },
    });
    vi.stubGlobal('fetch', async () => {
      steps.push('fetch');
      return new Response('zip-content');
    });
    const onExported = vi.fn();
    const notify = vi.fn();
    let controller!: BackupFeatureController;
    let renderer!: ReactTestRenderer;
    function Harness() {
      controller = useBackupController({
        repository: {
          createDownload: async () => {
            steps.push('ticket');
            return '/api/backups/download/ticket';
          },
        } as BackupRepository,
        refreshLibrary: async () => {},
        notify,
        onExported,
      });
      return null;
    }
    try {
      await act(async () => {
        renderer = create(<Harness />);
      });
      await act(async () => controller.exportBackup());
      expect(steps).toEqual(['picker', 'ticket', 'fetch', 'write', 'close']);
      expect(new TextDecoder().decode(chunks[0])).toBe('zip-content');
      expect(notify).toHaveBeenCalledWith('백업 파일 저장을 완료했습니다.', 'success');
      expect(onExported).toHaveBeenCalledOnce();
    } finally {
      await act(async () => renderer.unmount());
      vi.unstubAllGlobals();
    }
  });
  it('does not report completion when writing the server ZIP fails', async () => {
    vi.stubGlobal('window', {
      isSecureContext: true,
      showSaveFilePicker: async () => ({
        createWritable: async () =>
          new WritableStream<Uint8Array>({
            write() {
              throw new Error('disk full');
            },
          }),
      }),
    });
    vi.stubGlobal('fetch', async () => new Response('zip-content'));
    const onExported = vi.fn();
    const notify = vi.fn();
    let controller!: BackupFeatureController;
    let renderer!: ReactTestRenderer;
    function Harness() {
      controller = useBackupController({
        repository: { createDownload: async () => '/api/backups/download/ticket' } as BackupRepository,
        refreshLibrary: async () => {},
        notify,
        onExported,
      });
      return null;
    }
    try {
      await act(async () => {
        renderer = create(<Harness />);
      });
      await act(async () => controller.exportBackup());
      expect(onExported).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith('disk full', 'danger');
    } finally {
      await act(async () => renderer.unmount());
      vi.unstubAllGlobals();
    }
  });
  it('starts a native browser download without buffering ZIP or reporting a completed backup', async () => {
    const anchor = { href: '', download: '', target: '', rel: '', click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('document', { createElement: () => anchor, body: { append: vi.fn() } });
    const onExported = vi.fn();
    const exportBackup = vi.fn();
    const notify = vi.fn();
    let controller!: BackupFeatureController;
    let renderer!: ReactTestRenderer;
    function Harness() {
      controller = useBackupController({
        repository: {
          createDownload: async () => '/api/backups/download/ticket',
          exportBackup,
        } as unknown as BackupRepository,
        refreshLibrary: async () => {},
        notify,
        onExported,
      });
      return null;
    }
    try {
      await act(async () => {
        renderer = create(<Harness />);
      });
      await act(async () => controller.exportBackup());
      expect(anchor.href).toBe('/api/backups/download/ticket');
      expect(anchor.click).toHaveBeenCalledOnce();
      expect(exportBackup).not.toHaveBeenCalled();
      expect(onExported).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('완료 여부'), 'info');
    } finally {
      await act(async () => renderer.unmount());
      vi.unstubAllGlobals();
    }
  });
  it.each(['saved', 'cancelled', 'failed'] as const)(
    'records a backup only after export and a non-cancelled save: %s',
    async (outcome) => {
      const onExported = vi.fn();
      const exportedAt = new Date().toISOString();
      const repository = {
        exportBackup: async () => ({ blob: new Blob(['zip']), manifest: { exportedAt, books: [] } }),
      } as unknown as BackupRepository;
      const documentIo = {
        saveDocument: async () => {
          if (outcome === 'failed') throw new Error('disk full');
          return outcome;
        },
      } as unknown as PlatformDocumentIo;
      let controller!: BackupFeatureController;
      let renderer!: ReactTestRenderer;
      function Harness() {
        controller = useBackupController({
          repository,
          documentIo,
          onExported,
          refreshLibrary: async () => {},
          notify: vi.fn(),
        });
        return null;
      }
      await act(async () => {
        renderer = create(<Harness />);
      });
      await act(async () => controller.exportBackup());
      if (outcome === 'saved') expect(onExported).toHaveBeenCalledWith(exportedAt);
      else expect(onExported).not.toHaveBeenCalled();
      await act(async () => renderer.unmount());
    },
  );
  it('applies the default to untouched conflicts and preserves only explicit per-book overrides', async () => {
    const inspection: BackupInspection = {
      manifest: {
        format: 'noveldesk-backup',
        version: 1,
        exportedAt: '2026-09-05',
        appVersion: 'test',
        books: [
          { id: 'a', title: 'A', format: 'txt' },
          { id: 'b', title: 'B', format: 'txt' },
        ],
        entries: [],
        assetBlobs: [],
      },
      conflicts: [
        { bookId: 'a', title: 'A', existingTitle: 'A' },
        { bookId: 'b', title: 'B', existingTitle: 'B' },
      ],
      archiveByteLength: 1,
      totalUncompressedBytes: 1,
      warnings: [],
    };
    const restoreBackup = vi.fn<BackupRepository['restoreBackup']>(async () => ({
      restoredBooks: 1,
      skippedBooks: 1,
      copiedBooks: 0,
      restoredEntries: 1,
    }));
    const repository: BackupRepository = {
      exportBackup: vi.fn(),
      inspectBackup: async () => inspection,
      restoreBackup,
    };
    let controller!: BackupFeatureController;
    function Harness() {
      controller = useBackupController({ repository, refreshLibrary: async () => undefined, notify: vi.fn() });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    const archive = new File(['fixture'], 'backup.zip');
    await act(async () => controller.inspectFile(archive));
    await act(async () => controller.setDefaultResolution('replace'));
    expect(controller.conflictResolutions).toEqual({});
    await act(async () => controller.setConflictResolution('b', 'skip'));
    await act(async () => controller.restoreBackup());
    expect(restoreBackup).toHaveBeenLastCalledWith(archive, {
      defaultConflictResolution: 'replace',
      conflictResolutions: { b: 'skip' },
    });
    await act(async () => controller.inspectFile(archive));
    await act(async () => controller.setDefaultResolution('copy'));
    await act(async () => controller.restoreBackup());
    expect(restoreBackup).toHaveBeenLastCalledWith(archive, {
      defaultConflictResolution: 'copy',
      conflictResolutions: {},
    });
    await act(async () => renderer.unmount());
  });
});
