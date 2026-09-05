import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, Novel } from '../../domain/types';
import type { ImportService } from '../../services/import/import-service';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { readLocalSeriesManifest } from './local-series-import';
import { useImportController, type ImportFeatureController } from './useImportController';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function selectedFiles(title: string, format: 'image_archive' | 'txt'): Promise<File[]> {
  if (format === 'txt') {
    return [1, 2].map(
      (index) => new File([`Chapter ${index}\n\n${title} content ${index}.`], `${title} Chapter ${index}.txt`),
    );
  }
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await writer.add('001.png', new Uint8ArrayReader(png));
  return [new File([await writer.close()], `${title} Chapter 2.cbz`)];
}

const existingChapters = [testChapter(1, { documentSectionId: 'local_series_release_1' })];
function existingBook(id: string, format: 'image_archive' | 'txt') {
  return testNovel({
    id,
    title: 'Old Title',
    format,
    sourceAssetId: `${id}-source`,
    activeContentRevisionId: `${id}-revision`,
    documentSectionCount: 1,
  });
}

async function harness(
  input: {
    novels?: Novel[];
    listNovels?: () => Promise<Novel[]>;
    listChapters?: (id: string) => Promise<Chapter[]>;
  } = {},
) {
  vi.stubGlobal('window', globalThis);
  let controller!: ImportFeatureController;
  const importFile = vi.fn<ImportService['importFile']>(() => ({
    jobId: 'fixture',
    cancel: vi.fn(),
    promise: Promise.resolve({ novel: testNovel({ title: 'New Title' }) }),
  }));
  function Harness() {
    controller = useImportController({
      importService: { importFile, supportsIncrementalImageSeriesAppend: true },
      getNovel: async () => undefined,
      listNovels: input.listNovels ?? (async () => input.novels ?? []),
      listChapters: input.listChapters ?? (async () => []),
      onImportCommitted: async () => undefined,
      notify: vi.fn(),
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness />);
  });
  return {
    get controller() {
      return controller;
    },
    importFile,
    renderer,
  };
}

async function waitForState(check: () => boolean) {
  for (let index = 0; index < 100 && !check(); index += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  expect(check()).toBe(true);
}

afterEach(() => vi.unstubAllGlobals());

describe('import preparation generations', () => {
  it.each(['image_archive', 'txt'] as const)(
    'ignores obsolete %s planning and a start awaiting the replaced selection',
    async (format) => {
      const gate = deferred<Chapter[]>();
      const listChapters = vi.fn(() => gate.promise);
      const view = await harness({ novels: [existingBook('old', format)], listChapters });
      await act(async () => view.controller.selectFiles(await selectedFiles('Old Title', format)));
      await waitForState(() => listChapters.mock.calls.length > 0);
      let obsoleteStart!: Promise<void>;
      await act(async () => {
        obsoleteStart = view.controller.startPendingImport();
      });
      await act(async () => view.controller.selectFiles(await selectedFiles('New Title', format)));
      await waitForState(
        () => !view.controller.seriesBusy && Boolean(view.controller.seriesPlan ?? view.controller.documentSeriesPlan),
      );
      await act(async () => {
        gate.resolve(existingChapters);
        await obsoleteStart;
      });

      expect(view.importFile).not.toHaveBeenCalled();
      expect((view.controller.seriesPlan ?? view.controller.documentSeriesPlan)?.inspection.workTitle).toBe(
        'New Title',
      );
      expect(view.controller.seriesError).toBeUndefined();
      await act(async () => view.controller.startPendingImport());
      expect(view.importFile).toHaveBeenCalledOnce();
      expect(view.importFile.mock.calls[0]![0]).toMatchObject({
        clientBookId: undefined,
        file: expect.objectContaining({ name: format === 'txt' ? 'New Title.moya.zip' : 'New Title.cbz' }),
      });
      await act(async () => view.renderer.unmount());
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'ignores a target plan that will %s after selecting other files',
    async (outcome) => {
      const gate = deferred<Chapter[]>();
      const first = existingBook('first', 'image_archive');
      const second = existingBook('second', 'image_archive');
      const listChapters = vi.fn(async (id: string) => (id === second.id ? gate.promise : existingChapters));
      const view = await harness({ novels: [first, second], listChapters });
      await act(async () => view.controller.selectFiles(await selectedFiles('Old Title', 'image_archive')));
      await waitForState(() => !view.controller.seriesBusy && Boolean(view.controller.seriesPlan));
      let pendingTarget!: Promise<void>;
      await act(async () => {
        pendingTarget = view.controller.setSeriesTargetNovel(second.id);
      });
      await act(async () => view.controller.selectFiles(await selectedFiles('New Title', 'image_archive')));
      await waitForState(
        () => !view.controller.seriesBusy && view.controller.seriesPlan?.inspection.workTitle === 'New Title',
      );
      await act(async () => {
        if (outcome === 'resolve') gate.resolve(existingChapters);
        else gate.reject(new Error('obsolete target failure'));
        await pendingTarget;
      });

      expect(view.controller.seriesPlan?.inspection.workTitle).toBe('New Title');
      expect(view.controller.seriesError).toBeUndefined();
      await act(async () => view.controller.startPendingImport());
      const request = view.importFile.mock.calls[0]![0];
      expect(request.clientBookId).toBeUndefined();
      expect((await readLocalSeriesManifest(request.file))?.collection.title).toBe('New Title');
      await act(async () => view.renderer.unmount());
    },
  );

  it('keeps the most recent target when competing target requests settle out of order', async () => {
    const firstTargetGate = deferred<Chapter[]>();
    const secondTargetGate = deferred<Chapter[]>();
    const books = ['initial', 'first', 'second'].map((id) => existingBook(id, 'image_archive'));
    const view = await harness({
      novels: books,
      listChapters: async (id) =>
        id === 'first' ? firstTargetGate.promise : id === 'second' ? secondTargetGate.promise : existingChapters,
    });
    await act(async () => view.controller.selectFiles(await selectedFiles('Old Title', 'image_archive')));
    await waitForState(() => !view.controller.seriesBusy && Boolean(view.controller.seriesPlan));
    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;
    await act(async () => {
      firstRequest = view.controller.setSeriesTargetNovel('first');
      secondRequest = view.controller.setSeriesTargetNovel('second');
    });
    await act(async () => {
      secondTargetGate.resolve(existingChapters);
      await secondRequest;
    });
    await act(async () => {
      firstTargetGate.reject(new Error('obsolete failure'));
      await firstRequest;
    });
    expect(view.controller.seriesTargetNovelId).toBe('second');
    expect(view.controller.seriesPlan?.targetNovel?.id).toBe('second');
    expect(view.controller.seriesError).toBeUndefined();
    expect(view.controller.seriesBusy).toBe(false);
    await act(async () => view.renderer.unmount());
  });

  it('uses the completed plan when start was called before inspection finished', async () => {
    const gate = deferred<Novel[]>();
    const view = await harness({ listNovels: () => gate.promise });
    await act(async () => view.controller.selectFiles(await selectedFiles('New Title', 'image_archive')));
    let starting!: Promise<void>;
    await act(async () => {
      starting = view.controller.startPendingImport();
    });
    await act(async () => {
      gate.resolve([]);
      await starting;
    });
    expect(view.importFile).toHaveBeenCalledOnce();
    expect((await readLocalSeriesManifest(view.importFile.mock.calls[0]![0].file))?.collection.title).toBe('New Title');
    await act(async () => view.renderer.unmount());
  });
});
