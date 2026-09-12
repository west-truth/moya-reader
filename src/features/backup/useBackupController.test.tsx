import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { BackupInspection, BackupRepository } from '../../repositories/backup-repository';
import { useBackupController, type BackupFeatureController } from './useBackupController';
import type { PlatformDocumentIo } from '../../platform/document-io';

describe('backup conflict defaults', () => {
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
