import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { testChapter } from '../book-workspace/book-workspace-test-fixtures';
import type { ArchivePageSnapshot } from './archive-page-loader';
import { useArchivePageImages } from './use-archive-page-images';

describe('archive image hook lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retains the displayed immutable episode during append and reloads a replaced episode', async () => {
    let url = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:page-${++url}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const getParagraphPage = vi.fn(async () => ({ paragraphs: [{ assetId: 'page' }] }));
    const getEmbeddedResource = vi.fn(async () => ({ blob: new Blob(['image']) }));
    const repository = { getParagraphPage } as unknown as ReaderRepository;
    const assets = { getEmbeddedResource } as unknown as BookAssetRepository;
    let chapters = [testChapter(1, { documentSectionSourceContentHash: 'episode-original' })];
    let revision = 'source-1';
    let snapshot!: ArchivePageSnapshot;
    const renderedUrls: Array<string | undefined> = [];
    function Harness() {
      snapshot = useArchivePageImages({
        enabled: true,
        bookId: 'book',
        sourceRevision: revision,
        chapters,
        currentPage: 0,
        wantedPages: new Set([0]),
        repository,
        assets,
      });
      renderedUrls.push(snapshot.pages.get(0)?.url);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const original = snapshot.pages.get(0)?.url;
    const beforeAppend = renderedUrls.length;
    chapters = [...chapters, testChapter(2, { documentSectionSourceContentHash: 'episode-new' })];
    revision = 'source-after-append';
    await act(async () => {
      renderer.update(<Harness />);
    });
    expect(snapshot.pages.get(0)?.url).toBe(original);
    expect(renderedUrls.slice(beforeAppend).length).toBeGreaterThan(0);
    expect(renderedUrls.slice(beforeAppend).every((url) => url === original)).toBe(true);
    expect(getEmbeddedResource).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    chapters = [testChapter(1, { documentSectionSourceContentHash: 'episode-replaced' }), chapters[1]!];
    revision = 'source-after-replacement';
    const beforeReplacement = renderedUrls.length;
    await act(async () => {
      renderer.update(<Harness />);
    });
    expect(snapshot.pages.get(0)?.url).not.toBe(original);
    expect(renderedUrls[beforeReplacement]).toBeUndefined();
    expect(renderedUrls.slice(beforeReplacement)).not.toContain(original);
    expect(getEmbeddedResource).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(original);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('preserves legacy image elements across append after validating immutable assets', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:legacy');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const getParagraphPage = vi.fn(async () => ({ paragraphs: [{ assetId: 'immutable-page' }] }));
    const getEmbeddedResource = vi.fn(async () => ({ blob: new Blob(['image']) }));
    const repository = { getParagraphPage } as unknown as ReaderRepository;
    const assets = { getEmbeddedResource } as unknown as BookAssetRepository;
    let chapters = [testChapter(1)];
    let revision = 'before';
    const urls: Array<string | undefined> = [];
    function Harness() {
      const snapshot = useArchivePageImages({
        enabled: true,
        bookId: 'legacy',
        sourceRevision: revision,
        chapters,
        currentPage: 0,
        wantedPages: new Set([0]),
        repository,
        assets,
      });
      urls.push(snapshot.pages.get(0)?.url);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const start = urls.length;
    chapters = [...chapters, testChapter(2)];
    revision = 'after-append';
    await act(async () => renderer.update(<Harness />));
    expect(urls.slice(start).every((url) => url === 'blob:legacy')).toBe(true);
    expect(getEmbeddedResource).toHaveBeenCalledOnce();
    expect(getParagraphPage).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('reloads legacy images when the source changes even with identical page title hashes', async () => {
    let url = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:legacy-page-${++url}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let assetId = 'page-original';
    const getParagraphPage = vi.fn(async () => ({ paragraphs: [{ assetId }] }));
    const getEmbeddedResource = vi.fn(async () => ({ blob: new Blob(['image']) }));
    const repository = { getParagraphPage } as unknown as ReaderRepository;
    const assets = { getEmbeddedResource } as unknown as BookAssetRepository;
    const chapters = [testChapter(1, { textHash: 'legacy-page-original' })];
    let revision = 'source-1';
    let snapshot!: ArchivePageSnapshot;
    function Harness() {
      snapshot = useArchivePageImages({
        enabled: true,
        bookId: 'book',
        sourceRevision: revision,
        chapters,
        currentPage: 0,
        wantedPages: new Set([0]),
        repository,
        assets,
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    const original = snapshot.pages.get(0)?.url;

    assetId = 'page-replaced';
    revision = 'source-after-replacement';
    await act(async () => renderer.update(<Harness />));
    expect(snapshot.pages.get(0)?.url).not.toBe(original);
    expect(getEmbeddedResource).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(original);
    await act(async () => renderer.unmount());
  });

  it('forwards cancellation through metadata and asset loads and clears a replaced source', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:ready');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let chapters = [testChapter(1), testChapter(2)].map((chapter) => ({
      ...chapter,
      documentSectionSourceContentHash: 'original',
    }));
    const getParagraphPage = vi.fn(async (chapterId: string) => ({ paragraphs: [{ assetId: `asset:${chapterId}` }] }));
    const requests: Array<{ signal: AbortSignal; resolve: (value: unknown) => void }> = [];
    const getEmbeddedResource = vi.fn(
      (_bookId: string, _assetId: string, signal: AbortSignal) =>
        new Promise((resolve) => {
          requests.push({ signal, resolve });
        }),
    );
    const repository = { getParagraphPage } as unknown as ReaderRepository;
    const assets = { getEmbeddedResource } as unknown as BookAssetRepository;
    let revision = 'original';
    let snapshot!: ArchivePageSnapshot;
    function Harness() {
      snapshot = useArchivePageImages({
        enabled: true,
        bookId: 'book',
        sourceRevision: revision,
        chapters,
        currentPage: 0,
        wantedPages: new Set([0, 1]),
        repository,
        assets,
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    expect(getParagraphPage).toHaveBeenCalledWith(chapters[0]!.id, 0, requests[0]!.signal);
    await act(async () => {
      requests[0]!.resolve({ blob: new Blob(['page']) });
    });
    expect(snapshot.pages.has(0)).toBe(true);
    chapters = chapters.map((chapter) => ({
      ...chapter,
      textHash: `${chapter.textHash}:replacement`,
      documentSectionSourceContentHash: 'replacement',
    }));
    revision = 'replacement';
    await act(async () => {
      renderer.update(<Harness />);
    });
    expect(requests[1]!.signal.aborted).toBe(true);
    expect(snapshot.pages.size).toBe(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:ready');
    await act(async () => {
      requests[1]!.resolve({ blob: new Blob(['stale']) });
    });
    expect(snapshot.pages.size).toBe(0);
    await act(async () => {
      renderer.unmount();
    });
    expect(requests.slice(2).every((request) => request.signal.aborted)).toBe(true);
  });

  it('starts the foreground asset without waiting for neighbouring metadata', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:foreground');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const chapters = [testChapter(1), testChapter(2), testChapter(3)];
    let resolvedNeighbours = 0;
    const getParagraphPage = vi.fn(async (chapterId: string) => {
      if (chapterId === chapters[1]!.id) return { paragraphs: [{ assetId: 'foreground' }] };
      await new Promise((resolve) => setTimeout(resolve, 30));
      resolvedNeighbours += 1;
      return { paragraphs: [{ assetId: chapterId }] };
    });
    const neighbourCountsAtAssetLoad: number[] = [];
    const getEmbeddedResource = vi.fn(async () => {
      neighbourCountsAtAssetLoad.push(resolvedNeighbours);
      return { blob: new Blob(['image']) };
    });
    const repository = { getParagraphPage } as unknown as ReaderRepository;
    const assets = { getEmbeddedResource } as unknown as BookAssetRepository;
    function Harness() {
      useArchivePageImages({
        enabled: true,
        bookId: 'book',
        sourceRevision: 'source',
        chapters,
        currentPage: 1,
        wantedPages: new Set([0, 1, 2]),
        repository,
        assets,
      });
      return null;
    }
    const renderer = create(<Harness />);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getParagraphPage.mock.calls.map(([chapterId]) => chapterId)).toEqual([
      chapters[1]!.id,
      chapters[0]!.id,
      chapters[2]!.id,
    ]);
    expect(getEmbeddedResource).toHaveBeenCalledWith('book', 'foreground', expect.any(AbortSignal));
    expect(neighbourCountsAtAssetLoad[0]).toBe(0);
    renderer.unmount();
  });
});
