import 'fake-indexeddb/auto';
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbReaderRepository } from '../../repositories/indexeddb-reader-repository';
import { IndexedDbBookAssetRepository } from '../../repositories/indexeddb-book-asset-repository';
import { resetReaderDbForTests } from '../../storage/db';
import { runBrowserFixedDocumentImportPipeline } from '../../services/import/browser-import-pipeline';
import type { ImportService } from '../../services/import/import-service';
import { readLocalSeriesManifest } from './local-series-import';
import { useImportController, type ImportFeatureController } from './useImportController';

const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);
const reader = new IndexedDbReaderRepository();
const assets = new IndexedDbBookAssetRepository();
afterEach(async () => {
  vi.unstubAllGlobals();
  await resetReaderDbForTests();
});

async function release(number: number) {
  const writer = new ZipWriter(new BlobWriter());
  await writer.add(`${number}.png`, new Uint8ArrayReader(PNG));
  return new File([await writer.close()], `순차 작품 ${number}화.cbz`);
}

describe('local chapter sequence through the real browser storage boundary', () => {
  it.each(['success', 'failure', 'cancel'] as const)(
    'retains the target and completed chapter after %s and retries without duplication',
    async (mode) => {
      vi.stubGlobal('window', globalThis);
      let controller!: ImportFeatureController;
      let attempts = 0;
      const requests: Parameters<ImportService['importFile']>[0][] = [];
      const importFile: ImportService['importFile'] = (input, onProgress) => {
        requests.push(input);
        attempts++;
        const failing = attempts === 2 && mode !== 'success';
        return {
          jobId: `job-${attempts}`,
          cancel: vi.fn(),
          promise: (async () => {
            if (failing) {
              if (mode === 'cancel') {
                controller.cancelImport();
                throw new DOMException('Cancelled', 'AbortError');
              }
              throw new Error('fixture import failed');
            }
            return runBrowserFixedDocumentImportPipeline({
              ...input,
              fileName: input.file.name,
              sourceBlob: input.file,
              buffer: new ArrayBuffer(0),
              totalBytes: input.file.size,
              jobId: `job-${attempts}`,
              onProgress,
            });
          })(),
        };
      };
      function Harness() {
        controller = useImportController({
          importService: { importFile, supportsIncrementalImageSeriesAppend: true },
          assets,
          getNovel: (id) => reader.getNovel(id),
          listNovels: () => reader.listNovels(),
          listChapters: (id) => reader.listChapters(id),
          onImportCommitted: async () => undefined,
          notify: vi.fn(),
        });
        return null;
      }
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<Harness />);
      });
      try {
        const count = mode === 'success' ? 101 : 2;
        const files: File[] = [];
        for (let number = 1; number <= count; number++) files.push(await release(number));
        await act(async () => controller.selectFiles(files));
        for (let i = 0; i < 100 && (!controller.seriesPlan || controller.seriesBusy); i++)
          await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
        expect(controller.seriesPlan?.addCount).toBe(count);
        await act(async () => controller.startPendingImport());
        const first = (await reader.listNovels())[0]!;
        expect(await reader.listNovels()).toHaveLength(1);
        if (mode !== 'success') {
          expect(await reader.listChapters(first.id)).toHaveLength(1);
          expect(controller.seriesPlan).toMatchObject({
            targetNovel: { id: first.id },
            addCount: 1,
            duplicateCount: 1,
          });
          expect(controller.seriesTargetLocked).toBe(true);
          expect(controller.isOpen).toBe(true);
          await act(async () => controller.startPendingImport());
        }
        expect(await reader.listNovels()).toHaveLength(1);
        expect(await reader.listChapters(first.id)).toHaveLength(count);
        expect(requests).toHaveLength(mode === 'success' ? count : 3);
        expect(requests[1]).toMatchObject({ clientBookId: first.id, importMode: 'append_image_series' });
        expect(requests[2]).toMatchObject({ clientBookId: first.id, importMode: 'append_image_series' });
        for (const request of requests) expect((await readLocalSeriesManifest(request.file))?.chapters).toHaveLength(1);
        expect(controller.isOpen).toBe(false);
        expect(controller.seriesTargetLocked).toBe(false);
        const unrelated = new File(['다른 소설의 본문'], '다른 작품.txt');
        await act(async () => controller.selectFiles([unrelated]));
        expect(controller.pendingFiles).toEqual([unrelated]);
        expect(controller.seriesTargetNovelId).toBeUndefined();
      } finally {
        await act(async () => renderer.unmount());
      }
    },
    30_000,
  );
});
