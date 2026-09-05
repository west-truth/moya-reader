import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReaderPageBoundary } from '../../domain/types';
import { defaultSettings } from '../../repositories/reader-defaults';
import { loadReaderPageMap, type StoredReaderPageMap } from '../../storage/reader-page-map-store';
import { PaginatedReaderViewport } from './PaginatedReaderViewport';
import { ReaderScreenHandle } from './reader-screen-contract';
import type { ReaderViewportApi, ReaderViewportLayerProps } from './ReaderViewport';

vi.mock('../../storage/reader-page-map-store', () => ({
  loadReaderPageMap: vi.fn(),
  saveReaderPageMap: vi.fn(),
  pruneReaderPageMaps: vi.fn(),
}));
vi.mock('./use-reader-progress', () => {
  const persistence = { schedule: vi.fn(), flush: vi.fn(async () => undefined) };
  return { useReaderPositionPersistence: () => persistence };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('inactive pagination work', () => {
  it('pauses layout and adjacent reads while hidden, then reuses the anchor on activation', async () => {
    const idleCallbacks: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => idleCallbacks.push(callback));
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    vi.stubGlobal('window', { clearTimeout: vi.fn(), cancelAnimationFrame: vi.fn() });
    vi.stubGlobal('document', { fonts: { ready: Promise.resolve() } });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const chapter = { id: 'active-pagination-fixture', novelId: 'book', index: 2, paragraphCount: 1, title: '본문' };
    const paragraph = { id: 'paragraph', novelId: 'book', chapterId: chapter.id, index: 1, text: '원문' };
    const anchor = {
      bookId: 'book',
      contentRevisionId: 'active-pagination-revision',
      sectionId: chapter.id,
      blockId: paragraph.id,
      blockIndex: 0,
      offset: 0,
    };
    const boundaries: ReaderPageBoundary[] = [{ index: 0, start: anchor, end: { ...anchor, offset: 2 } }];
    let resolveFirstMap!: (value?: StoredReaderPageMap) => void;
    vi.mocked(loadReaderPageMap).mockImplementationOnce(() => new Promise((resolve) => (resolveFirstMap = resolve)));
    vi.mocked(loadReaderPageMap).mockResolvedValue({
      id: 'stored-pagination-fixture',
      chapterId: chapter.id,
      contentRevisionId: anchor.contentRevisionId,
      layoutKey: 'fixture-layout',
      rendererVersion: 'fixture-renderer',
      boundaries,
      createdAt: '2026-09-05T00:00:00.000Z',
      lastAccessedAt: '2026-09-05T00:00:00.000Z',
    });
    const getParagraphPage = vi.fn(async () => ({ paragraphs: [paragraph] }));
    const apiRef: { current?: ReaderViewportApi } = {};
    const props = {
      novel: { id: 'book', activeContentRevisionId: anchor.contentRevisionId },
      chapter,
      chapters: [
        { ...chapter, id: 'previous-pagination-fixture', index: 1, paragraphCount: 60_000 },
        chapter,
        { ...chapter, id: 'next-pagination-fixture', index: 3, paragraphCount: 60_000 },
      ],
      repository: { getParagraphPage },
      settings: defaultSettings,
      mode: 'read',
      search: { highlightQuery: '' },
      screenHandle: new ReaderScreenHandle(),
      apiRef,
      onApiReady: vi.fn(),
      onVisualLocation: vi.fn(),
      onPaginationFailure: vi.fn(),
    } as unknown as ReaderViewportLayerProps & { onPaginationFailure: () => void };
    let renderer!: ReactTestRenderer;
    const render = (isActive: boolean) => <PaginatedReaderViewport {...props} isActive={isActive} />;
    try {
      await act(async () => {
        renderer = create(render(false), {
          createNodeMock: () => ({ clientWidth: 800, clientHeight: 600 }),
        });
      });
      expect(loadReaderPageMap).not.toHaveBeenCalled();
      expect(getParagraphPage).not.toHaveBeenCalled();

      await act(async () => renderer.update(render(true)));
      expect(loadReaderPageMap).toHaveBeenCalledTimes(1);
      await act(async () => renderer.update(render(false)));
      await act(async () => resolveFirstMap(undefined));
      expect(getParagraphPage).not.toHaveBeenCalled();
      expect(props.onPaginationFailure).not.toHaveBeenCalled();

      await act(async () => renderer.update(render(true)));
      expect(apiRef.current?.getAnchor()).toEqual(anchor);
      expect(apiRef.current?.getLocation()).toMatchObject({ progress: 1, paragraphIndex: 1, offsetInParagraph: 0 });
      expect(getParagraphPage).toHaveBeenCalledTimes(1);
      const cancelledIdle = idleCallbacks.at(-1)!;
      await act(async () => renderer.update(render(false)));
      await act(async () => cancelledIdle());
      expect(getParagraphPage).toHaveBeenCalledTimes(1);

      await act(async () => renderer.update(render(true)));
      expect(loadReaderPageMap).toHaveBeenCalledTimes(2);
      expect(apiRef.current?.getAnchor()).toEqual(anchor);
      await act(async () => idleCallbacks.at(-1)!());
      expect(getParagraphPage.mock.calls).toEqual([
        [chapter.id, 0],
        ['previous-pagination-fixture', 499],
        ['previous-pagination-fixture', 498],
        ['next-pagination-fixture', 0],
        ['next-pagination-fixture', 1],
      ]);
    } finally {
      act(() => renderer?.unmount());
    }
  });
});
