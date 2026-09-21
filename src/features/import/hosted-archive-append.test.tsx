import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import type { ImportService } from '../../services/import/import-service';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { useImportController, type ImportFeatureController } from './useImportController';

afterEach(() => vi.unstubAllGlobals());
it.each([
  ['epub', false],
  ['image_archive', false],
  ['epub', true],
] as const)('uploads %s originals without unpacking the base (stop on failure: %s)', async (format, failSecond) => {
  vi.stubGlobal('window', globalThis);
  let novel = {
    id: 'hosted',
    title: '기존 작품',
    format,
    activeContentRevisionId: 'rev_0',
    totalChapters: 1,
  } as Novel;
  const exportSource = vi.fn(async () => {
    throw new Error('old archive must not be read');
  });
  const inputs: Parameters<ImportService['importFile']>[0][] = [];
  const importFile: ImportService['importFile'] = (input) => {
    inputs.push(input);
    if (failSecond && inputs.length === 2)
      return { jobId: 'failed', cancel: vi.fn(), promise: Promise.reject(new Error('storage failed')) };
    novel = { ...novel, activeContentRevisionId: `rev_${inputs.length}`, totalChapters: novel.totalChapters + 1 };
    return { jobId: `job_${inputs.length}`, cancel: vi.fn(), promise: Promise.resolve({ novel }) };
  };
  let controller!: ImportFeatureController;
  function Harness() {
    controller = useImportController({
      importService: { importFile, supportsLocalArchiveAppend: true },
      assets: { exportSource } as unknown as BookAssetRepository,
      getNovel: async () => novel,
      listNovels: async () => [novel],
      listChapters: async () => [],
      onImportCommitted: async () => {},
      notify: vi.fn(),
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness />);
  });
  try {
    const files = (failSecond ? [1, 2, 3] : [10, 2]).map((i) => {
      const file = new File(['raw-file'], `${i}.${format === 'epub' ? 'epub' : 'cbz'}`);
      Object.defineProperty(file, 'size', { value: 2 * 1024 ** 3 });
      file.arrayBuffer = vi.fn(async () => {
        throw new Error('archive-sized read not allowed');
      });
      return file;
    });
    await act(async () => controller.openChapterAppend(novel));
    await act(async () => controller.selectFiles(files));
    expect(controller.appendTargetTitle).toBe('기존 작품');
    await act(async () => controller.startPendingImport());
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.file)).toEqual(failSecond ? files.slice(0, 2) : [files[1], files[0]]);
    expect(inputs.map((i) => i.baseActiveContentRevisionId)).toEqual(['rev_0', 'rev_1']);
    for (const input of inputs)
      expect(input).toMatchObject({ clientBookId: 'hosted', importMode: 'append_local_archive' });
    expect(exportSource).not.toHaveBeenCalled();
    for (const file of files) expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(controller.seriesTargetLocked).toBe(failSecond);
    expect(controller.tasks.some((task) => task.phase === 'queued')).toBe(false);
  } finally {
    await act(async () => renderer.unmount());
  }
});
